// Gardener — reads the world, calls the LLM, writes opportunities.yaml.
//
// Usage:
//   npx tsx pipeline/gardener.ts                          # broad sweep
//   npx tsx pipeline/gardener.ts --dry-run                # print; don't write
//   npx tsx pipeline/gardener.ts --prompt "<focus>"       # focused investigation
//   npx tsx pipeline/gardener.ts --prompt-file <path>     # focus from file
//   echo "<focus>" | npx tsx pipeline/gardener.ts --prompt-stdin
//   npx tsx pipeline/gardener.ts --audit <zone_id>        # visual zone audit
//   npx tsx pipeline/gardener.ts --anchor <zone_id> [--radius <n>]
//                                                         # region bootstrap
//
// --anchor limits the gardener's zone context and opportunity scope to the
// N-step neighborhood (via connections graph) around a named zone. Defaults
// to radius 3. Use this to bootstrap content around a new starting village
// before doing a broad world sweep.
//
// A focus prompt steers the Gardener toward a specific concern ("the tavern
// feels sparse", "audit the goblin faction's reach", etc.) while still
// producing the same opportunities.yaml format. The coherence rules in the
// system prompt still apply.
//
// --audit renders the named zone to a PNG, hands the model the file path,
// and biases it toward refactor_zone opportunities for that zone. Use it
// when a zone looks bad and you want the renderer in the loop at
// opportunity-generation time.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { GARDENER_SYSTEM } from './lib/prompts.ts';
import { HISTORY_FILE, METRICS_FILE, OPPS_FILE, REPO_ROOT, fileExists, readYaml, writeYaml } from './lib/io.ts';
import {
  loadWorldBundle, formatWorldContextCompact, formatPipelineState,
  formatMetricsContext, formatRecentWorkDigest,
} from './lib/worldSummary.ts';
import { callAndValidate } from './lib/validate.ts';
import { UsageLimitError, USAGE_LIMIT_EXIT_CODE } from './lib/llm.ts';
import { initRunLog } from './lib/runLog.ts';
import { renderZoneToFile } from './lib/renderZone.ts';
import { loadWorld } from '../server/world/loader.ts';
import { computeWorldMetrics, trimMetricsForDisk, isSettlement, type WorldMetrics } from './lib/worldMetrics.ts';
import { OpportunitiesFileSchema, type Opportunity, type OpportunitiesFile } from './lib/schemas.ts';
import type { HistoryFile } from './lib/types.ts';
import type { WorldDefs } from '../shared/types.ts';

interface Args {
  dryRun: boolean;
  focus: string | null;
  auditZone: string | null;
  anchorZone: string | null;
  anchorRadius: number;
  worldSweep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, focus: null, auditZone: null, anchorZone: null, anchorRadius: 3, worldSweep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--prompt') args.focus = argv[++i] ?? null;
    else if (a === '--prompt-file') {
      const path = argv[++i];
      if (!path) throw new Error('--prompt-file requires a path');
      args.focus = readFileSync(path, 'utf8').trim();
    } else if (a === '--prompt-stdin') {
      args.focus = readFileSync(0, 'utf8').trim();
    } else if (a === '--audit') {
      args.auditZone = argv[++i] ?? null;
      if (!args.auditZone) throw new Error('--audit requires a zone id');
    } else if (a === '--anchor') {
      args.anchorZone = argv[++i] ?? null;
      if (!args.anchorZone) throw new Error('--anchor requires a zone id');
    } else if (a === '--radius') {
      const r = Number(argv[++i]);
      if (!Number.isFinite(r) || r < 1) throw new Error('--radius must be a positive integer');
      args.anchorRadius = r;
    } else if (a === '--world') {
      args.worldSweep = true;
    }
  }
  if (args.focus !== null && args.focus.length === 0) args.focus = null;
  return args;
}

// BFS the loaded connections graph starting at anchorId, up to `radius` hops.
// Follows both cardinal and non-cardinal (sub-zone) links.
function buildNeighborhood(defs: WorldDefs, anchorId: string, radius: number): Set<string> {
  const neighborhood = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: anchorId, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (neighborhood.has(item.id)) continue;
    if (!defs.zones[item.id]) continue;
    neighborhood.add(item.id);
    if (item.depth >= radius) continue;
    for (const neighborId of Object.values(defs.zones[item.id]!.connections ?? {})) {
      if (neighborId && !neighborhood.has(neighborId)) {
        queue.push({ id: neighborId, depth: item.depth + 1 });
      }
    }
  }
  return neighborhood;
}

/**
 * Auto-anchor selection for broad runs: the settlement whose neighborhood has
 * the least development. Pure function of world state, so rotation emerges on
 * its own — once a neighborhood gains content its score rises and the next
 * least-developed settlement wins the following run. Deterministic tie-break
 * by id. Returns null when the world has no settlements.
 */
function pickAutoAnchor(
  defs: WorldDefs,
  metrics: WorldMetrics,
  radius: number,
): { anchorId: string; score: number } | null {
  const devById = new Map(metrics.zones.map((z) => [z.id, z.development]));
  const settlements = Object.values(defs.zones).filter(isSettlement);
  if (settlements.length === 0) return null;

  let best: { anchorId: string; score: number } | null = null;
  for (const s of settlements) {
    const hood = buildNeighborhood(defs, s.id, radius);
    let score = 0;
    for (const id of hood) score += devById.get(id) ?? 0;
    if (!best || score < best.score || (score === best.score && s.id < best.anchorId)) {
      best = { anchorId: s.id, score };
    }
  }
  return best;
}

// Render the audit target to a PNG and return the relative + absolute paths.
// We render every time (rather than reusing a stale render) so the image the
// LLM reads always reflects the YAML the LLM is also seeing.
function renderAuditZone(world: WorldDefs, zoneId: string): { rel: string; abs: string } {
  const zoneDef = world.zones[zoneId];
  if (!zoneDef) throw new Error(`--audit zone not found: ${zoneId}`);
  const tilesetName = (zoneDef as { tileset?: string }).tileset || 'overworld';
  const tileset = world.tilesets[tilesetName];
  if (!tileset) throw new Error(`tileset not found for ${zoneId}: ${tilesetName}`);
  const rel = `world/renders/${zoneId}.png`;
  const abs = join(REPO_ROOT, rel);
  renderZoneToFile(zoneDef, tileset, abs, { mobs: world.mobs, prefabs: world.prefabs });
  return { rel, abs };
}

function buildAuditFocus(zoneId: string, renderRel: string): string {
  return [
    `You are auditing zone \`${zoneId}\` for visual and structural quality.`,
    `A fresh PNG render has been generated at ${renderRel}.`,
    '',
    'BEFORE producing opportunities, use the Read tool on that PNG path —',
    'it renders inline. Compare the image against the zone YAML above and',
    'look for:',
    '',
    '- Regions that overlap, are misaligned, or extend past the zone bounds.',
    '- Rivers/roads with edge gaps, awkward terminations, or that cut through',
    '  buildings (caused by circle/ellipse rivers, or path endpoints that',
    "  don't reach the zone edge).",
    '- Mob spawn dots placed inside walls, water, or void (region overlaps',
    '  blocked tiles).',
    '- Magenta tiles or magenta mob dots (unmapped tileset or sprite names).',
    '- Large undifferentiated dead space, single-corner clustering, or a lack',
    '  of visual focal points — aesthetic dullness that hurts playability.',
    '- Roads that terminate in walls or that miss the regions they should',
    '  connect.',
    '',
    `If the zone has visual issues, emit one or more zone_enhance`,
    `opportunities targeting \`${zoneId}\` with a specific, actionable`,
    '`intent` naming what to add or reposition (post_ops, features, spawns).',
    'Quote what you saw in the render in the rationale (e.g. "the stamped',
    'entrance sits flush against the wall", "mob dots cluster in one corner").',
    '',
    'If the zone looks clean, say so in `world_summary` and produce only a',
    'small set of non-audit opportunities (or none — an empty `opportunities`',
    'list is valid here).',
  ].join('\n');
}

// Returns the highest numeric suffix used by any known opportunity ID,
// across both opportunities.yaml and history.yaml. New opps must use IDs
// strictly above this value so the global ID sequence stays monotonic.
function collectKnownIds(): { ids: Set<string>; maxNum: number } {
  const ids = new Set<string>();
  let maxNum = 0;
  const consume = (id: unknown) => {
    if (typeof id !== 'string') return;
    ids.add(id);
    const m = id.match(/(\d+)\s*$/);
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  };
  if (fileExists(OPPS_FILE)) {
    const opps = readYaml<OpportunitiesFile>(OPPS_FILE);
    for (const o of opps?.opportunities ?? []) consume(o.id);
  }
  if (fileExists(HISTORY_FILE)) {
    const hist = readYaml<HistoryFile>(HISTORY_FILE);
    for (const e of hist?.entries ?? []) consume(e.opportunity_id);
  }
  return { ids, maxNum };
}

// Belt-and-suspenders enforcement: rewrite any "new" ID (one not present in
// the prior known set) to a fresh, strictly-increasing slot. Existing IDs
// (carry-forwards) keep their numbers. Returns the list of {old, new}
// rewrites for logging.
function enforceMonotonicIds(
  opps: Opportunity[],
  known: { ids: Set<string>; maxNum: number },
): { from: string; to: string }[] {
  const rewrites: { from: string; to: string }[] = [];
  let next = known.maxNum + 1;
  const pad = (n: number) => `opp_${String(n).padStart(3, '0')}`;
  for (const op of opps) {
    if (known.ids.has(op.id)) continue;
    const fresh = pad(next++);
    if (fresh !== op.id) rewrites.push({ from: op.id, to: fresh });
    op.id = fresh;
  }
  return rewrites;
}

function buildUserMessage(
  focus: string | null,
  nextId: string,
  mode: 'broad' | 'focus' | 'audit' | 'anchor',
  anchorContext?: { anchorId: string; radius: number; neighborhood: Set<string>; totalZones: number },
): string {
  const base = [
    'Analyze the world above and produce an updated opportunities.yaml.',
    '',
    'Carry forward still-relevant pending opportunities unchanged (keep',
    'their existing IDs). Mark stale ones as status: superseded.',
    `Any NEW opportunity you add must use an ID of ${nextId} or higher`,
    '(monotonically increasing). NEVER reuse an ID from this file or from',
    'history.yaml — even if that opportunity is now superseded.',
    'Add new opportunities to fill gaps you identify.',
  ];

  if (mode === 'audit' && focus) {
    base.push(
      '',
      '# Visual zone audit',
      '',
      focus,
      '',
      'Aim for 1–4 opportunities total, weighted toward zone_enhance on the',
      'audited zone. Carry-forward and superseded entries from prior runs',
      'still apply.',
    );
  } else if (mode === 'anchor' && anchorContext) {
    const { anchorId, radius, neighborhood, totalZones } = anchorContext;
    const neighborList = [...neighborhood].sort().join(', ');
    base.push(
      '',
      '# Region bootstrap (anchor mode)',
      '',
      `You are bootstrapping content for a new development region. The full`,
      `world contains ${totalZones} zones; this run focuses on the`,
      `${neighborhood.size}-zone neighborhood (radius ${radius}) around \`${anchorId}\`.`,
      '',
      `Neighborhood zones: ${neighborList}`,
      '',
      'Rules for this run:',
      `- New opportunities MUST target zones within the neighborhood only.`,
      `- The anchor zone \`${anchorId}\` is a settlement — prioritize giving it`,
      '  at least one NPC, one quest giver, and a basic mob spawn table.',
      '- Wilderness zones in the neighborhood need mob spawn tables appropriate',
      '  to their biome and level_band. Use the level_band in each zone stub.',
      '- Weight toward the low rungs of the depth ladder: mob_populate,',
      '  zone_enhance, quest_add.',
      '- Do NOT propose opportunities for zones outside the neighborhood.',
      '- Carry forward existing pending opportunities as usual.',
      '',
      'Aim for 5–10 opportunities covering the anchor settlement and its',
      'immediate wilderness ring.',
    );
    if (focus) {
      base.push('', '# Additional focus', '', focus);
    }
  } else if (mode === 'focus' && focus) {
    base.push(
      '',
      '# Focus for this run',
      '',
      'A human operator has asked you to concentrate on the following.',
      'Weight opportunities that address it more heavily, but do not abandon',
      'global coherence — if the focus conflicts with the lore bible or the',
      'standing coherence rules, surface that as a refactor_lore or',
      'refactor_zone opportunity rather than violating the rules.',
      '',
      focus,
      '',
      'Aim for 3–6 opportunities, most of them addressing the focus directly.',
    );
  } else {
    base.push(
      'Weight the batch toward the low rungs of the depth ladder: mob_populate',
      'and zone_enhance before quest_add, and zone_connect only for zones that',
      'already have inhabitants and an identity.',
      'Aim for 4–8 total opportunities in the final list.',
    );
  }
  return base.join('\n');
}

async function main(): Promise<void> {
  initRunLog('gardener');
  const args = parseArgs(process.argv.slice(2));

  if (args.auditZone && args.focus) {
    throw new Error('--audit and --prompt/--prompt-file/--prompt-stdin are mutually exclusive');
  }
  if (args.auditZone && args.anchorZone) {
    throw new Error('--audit and --anchor are mutually exclusive');
  }

  // One world load serves everything: neighborhood BFS, metrics, audit render.
  const worldDefs = loadWorld(join(REPO_ROOT, 'world'));
  const totalZones = Object.keys(worldDefs.zones).length;

  // Structural metrics. Grid analysis self-scopes to developed zones (see
  // computeWorldMetrics) — pristine stubs are never regenerated here.
  const metrics = computeWorldMetrics(worldDefs);
  writeYaml(METRICS_FILE, trimMetricsForDisk(metrics));
  const developed = metrics.zones.filter((z) => z.development > 0).length;
  console.error(
    `[gardener] computed world_metrics: ${metrics.graph.total_zones} zones ` +
    `(${developed} developed), ${metrics.graph.connected_components} component(s), ` +
    `${metrics.signals.frontier.length} frontier zone(s), ` +
    `${metrics.signals.questless_settlements.length} questless settlement(s)`,
  );

  let mode: 'broad' | 'focus' | 'audit' | 'anchor' = 'broad';
  let focus = args.focus;
  let anchorContext: Parameters<typeof buildUserMessage>[3] | undefined;
  let zoneFilter: Set<string> | undefined;
  let anchorZone = args.anchorZone;

  // Broad runs auto-anchor to the least-developed settlement neighborhood —
  // the host picks the focus so runs rotate through the world's frontiers
  // instead of asking the model to survey everything. --world disables it.
  if (!anchorZone && !args.auditZone && !args.focus && !args.worldSweep) {
    const picked = pickAutoAnchor(worldDefs, metrics, args.anchorRadius);
    if (picked) {
      anchorZone = picked.anchorId;
      console.error(
        `[gardener] auto-anchor: ${picked.anchorId} ` +
        `(least-developed settlement neighborhood, score ${picked.score})`,
      );
    }
  }

  if (args.auditZone) {
    const { rel } = renderAuditZone(worldDefs, args.auditZone);
    console.error(`[gardener] audit render → ${rel}`);
    focus = buildAuditFocus(args.auditZone, rel);
    mode = 'audit';
  } else if (anchorZone) {
    const neighborhood = buildNeighborhood(worldDefs, anchorZone, args.anchorRadius);
    if (!neighborhood.has(anchorZone)) {
      throw new Error(`--anchor zone not found: ${anchorZone}`);
    }
    anchorContext = { anchorId: anchorZone, radius: args.anchorRadius, neighborhood, totalZones };
    zoneFilter = neighborhood;
    mode = 'anchor';
    console.error(
      `[gardener] anchor: ${anchorZone}, radius: ${args.anchorRadius}, ` +
      `neighborhood: ${neighborhood.size} zones`,
    );
  } else if (args.focus) {
    mode = 'focus';
  }

  const bundle = loadWorldBundle(zoneFilter ? { zoneFilter } : undefined);
  const worldContext = formatWorldContextCompact(bundle);
  const pipelineState = formatPipelineState(bundle);
  const recentDigest = formatRecentWorkDigest(bundle.historyRaw);
  const known = collectKnownIds();
  const nextId = `opp_${String(known.maxNum + 1).padStart(3, '0')}`;
  const userMessage = buildUserMessage(focus, nextId, mode, anchorContext);

  // Scope the metrics context to the neighborhood when anchored; otherwise
  // only developed-zone rows are included so the block never balloons.
  const metricsContext = formatMetricsContext(metrics, zoneFilter);

  if (mode === 'audit') {
    console.error(`[gardener] audit zone: ${args.auditZone}`);
  } else if (focus) {
    console.error(`[gardener] focus: ${focus.slice(0, 120)}${focus.length > 120 ? '…' : ''}`);
  }
  console.error('[gardener] calling LLM...');
  const { value: out, raw } = await callAndValidate({
    label: 'gardener',
    system: [GARDENER_SYSTEM, worldContext, pipelineState, metricsContext, recentDigest].filter(Boolean),
    user: userMessage,
    schema: OpportunitiesFileSchema,
    // Broad/focus opportunity-finding is pure YAML generation — no tools needed.
    // Audit mode is the exception: it Reads the rendered PNG.
    disableTools: mode !== 'audit',
  });

  out.generated_at = out.generated_at ?? new Date().toISOString();

  const rewrites = enforceMonotonicIds(out.opportunities, known);
  for (const r of rewrites) {
    console.error(`[gardener] rewrote ID ${r.from} → ${r.to} (collision with known IDs)`);
  }

  if (args.dryRun) {
    console.log('--- DRY RUN — would write to', OPPS_FILE, '---');
    console.log(raw);
    return;
  }

  writeYaml(OPPS_FILE, out);
  const pending = out.opportunities.filter((o) => o.status === 'pending').length;
  console.error(
    `[gardener] wrote ${out.opportunities.length} opportunities (${pending} pending) to ${OPPS_FILE}`,
  );
}

main().catch((err) => {
  if (err instanceof UsageLimitError) {
    console.error('[llm] USAGE_LIMIT', err.message);
    process.exit(USAGE_LIMIT_EXIT_CODE);
  }
  console.error(err);
  process.exit(1);
});
