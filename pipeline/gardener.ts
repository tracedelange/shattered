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
  loadWorldBundle, formatWorldContextCompact,
  formatMetricsContext, formatRecentWorkDigest,
} from './lib/worldSummary.ts';
import { callAndValidate } from './lib/validate.ts';
import { UsageLimitError, USAGE_LIMIT_EXIT_CODE } from './lib/llm.ts';
import { initRunLog } from './lib/runLog.ts';
import { renderZoneToFile } from './lib/renderZone.ts';
import { loadWorld } from '../server/world/loader.ts';
import { computeWorldMetrics, trimMetricsForDisk } from './lib/worldMetrics.ts';
import { buildNeighborhood, pickAutoAnchor } from './lib/anchor.ts';
import { loadSagas, upsertSagas, formatSagaContext, SagaSchema } from './lib/sagas.ts';
import {
  OpportunitiesFileLenientSchema, OpportunitySchema,
  type Opportunity, type OpportunitiesFile,
} from './lib/schemas.ts';
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
    'Analyze the world above and produce a FRESH opportunities.yaml batch.',
    '',
    'This is a fresh batch: do NOT echo or carry forward prior opportunities —',
    'emit only the work you want built now. Each opportunity uses an ID of',
    `${nextId} or higher (monotonically increasing); never reuse an ID already`,
    'recorded in history.yaml.',
  ];

  if (mode === 'audit' && focus) {
    base.push(
      '',
      '# Visual zone audit',
      '',
      focus,
      '',
      'Aim for 1–4 opportunities total, weighted toward zone_enhance on the',
      'audited zone.',
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
      `- The anchor zone \`${anchorId}\` is the focal point of this region — make`,
      '  it a place worth arriving at: a landmark, a notable structure, or, if it',
      '  reads as a settlement, its town basics (an NPC, a quest giver, a shop).',
      '- Wilderness zones (including the anchor when it is wilderness) need mob',
      '  spawn tables appropriate to their biome and level_band, and benefit from',
      '  a landmark or named feature (a prefab, a distinctive zone_enhance). Use',
      '  the level_band in each zone stub.',
      '- Any settlement that falls inside the neighborhood should still get its',
      '  NPC / quest-giver / mob basics.',
      '- SAGA FIRST: if open_sagas lists an arc for this region, emit the',
      '  opportunities that realize its next stage (tagged saga_id + saga_stage)',
      '  before anything else. If this region has NO open saga, author one in',
      '  `sagas:` (motif, secret, climbing escalation) and tag the opportunities',
      '  that start its first stage. Give the region one memorable idea, not a',
      '  uniform checklist.',
      '- Below the saga, weight toward the low rungs of the depth ladder for any',
      '  zone still under the floor: mob_populate, zone_enhance, quest_add.',
      '- If clone_pairs flags interchangeable zones here, differentiate one',
      '  rather than repeating the same template.',
      '- Do NOT propose opportunities for zones outside the neighborhood.',
      '',
      'Aim for 5–10 opportunities covering the anchor and its immediate ring.',
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
  // computeWorldMetrics) — pristine stubs are never regenerated here. Sagas
  // feed the open_sagas signal (the narrative spine's work queue).
  const sagasFile = loadSagas();
  const metrics = computeWorldMetrics(worldDefs, undefined, sagasFile.sagas);
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

  // Broad runs auto-anchor. Sagas drive selection: an open saga's region is
  // the focus until its arc completes (most-progressed first, so started arcs
  // finish). Only when no saga is open do we fall back to the least-developed
  // settlement neighborhood. --world disables auto-anchoring entirely.
  if (!anchorZone && !args.auditZone && !args.focus && !args.worldSweep) {
    const sagaAnchor = metrics.signals.open_sagas[0]?.anchor_zone;
    if (sagaAnchor && worldDefs.zones[sagaAnchor]) {
      anchorZone = sagaAnchor;
      console.error(
        `[gardener] saga-anchor: ${sagaAnchor} ` +
        `(open saga '${metrics.signals.open_sagas[0]!.saga}', ` +
        `${metrics.signals.open_sagas[0]!.realized}/${metrics.signals.open_sagas[0]!.total} stages)`,
      );
    } else {
      const picked = pickAutoAnchor(worldDefs, metrics, args.anchorRadius);
      if (picked) {
        anchorZone = picked.anchorId;
        console.error(
          `[gardener] auto-anchor: ${picked.anchorId} ` +
          `(least-developed settlement neighborhood, score ${picked.score})`,
        );
      }
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
  // The prior opportunities.yaml is intentionally NOT fed to the model: each
  // run produces a fresh batch (the host overwrites the queue), so echoing the
  // old queue would only waste context and tempt carry-forward churn. Unbuilt
  // work is re-derived from world state + metrics + sagas next run.
  const recentDigest = formatRecentWorkDigest(bundle.historyRaw);
  const known = collectKnownIds();
  const nextId = `opp_${String(known.maxNum + 1).padStart(3, '0')}`;
  const userMessage = buildUserMessage(focus, nextId, mode, anchorContext);

  // Scope the metrics context to the neighborhood when anchored; otherwise
  // only developed-zone rows are included so the block never balloons.
  const metricsContext = formatMetricsContext(metrics, zoneFilter);

  // Full bodies of open sagas in scope, so the model can CONTINUE an arc
  // (motif, secret, every stage) rather than only seeing its next stage in the
  // metrics signal. Scoped to the neighborhood to keep context bounded.
  const inScope = (id: string) => !zoneFilter || zoneFilter.has(id);
  const sagaContext = formatSagaContext(sagasFile.sagas, inScope);

  if (mode === 'audit') {
    console.error(`[gardener] audit zone: ${args.auditZone}`);
  } else if (focus) {
    console.error(`[gardener] focus: ${focus.slice(0, 120)}${focus.length > 120 ? '…' : ''}`);
  }
  console.error('[gardener] calling LLM...');
  const { value: rawOut, raw } = await callAndValidate({
    label: 'gardener',
    system: [GARDENER_SYSTEM, worldContext, metricsContext, sagaContext, recentDigest].filter(Boolean),
    user: userMessage,
    // Lenient envelope: opportunities/sagas are validated individually below so a
    // single malformed entry can't reject the whole batch (the repair retry still
    // covers gross YAML / envelope errors).
    schema: OpportunitiesFileLenientSchema,
    // Broad/focus opportunity-finding is pure YAML generation — no tools needed.
    // Audit mode is the exception: it Reads the rendered PNG.
    disableTools: mode !== 'audit',
  });

  // Per-opportunity (and per-saga) isolation: keep the valid entries, DROP and
  // log the invalid ones. One bad field (e.g. an invented `status: deferred`)
  // must never discard good work — like a saga's finale stage — along with it.
  const idOf = (o: unknown) => String((o as { id?: unknown })?.id ?? '(no id)');
  const issues = (e: import('zod').ZodError) => e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  const validOpps: Opportunity[] = [];
  for (const o of rawOut.opportunities) {
    const r = OpportunitySchema.safeParse(o);
    if (r.success) validOpps.push(r.data);
    else console.error(`[gardener] dropped invalid opportunity ${idOf(o)}: ${issues(r.error)}`);
  }
  const validSagas: Array<import('zod').infer<typeof SagaSchema>> = [];
  for (const s of rawOut.sagas ?? []) {
    const r = SagaSchema.safeParse(s);
    if (r.success) validSagas.push(r.data);
    else console.error(`[gardener] dropped invalid saga ${idOf(s)}: ${issues(r.error)}`);
  }
  if (validOpps.length === 0) {
    console.error('[gardener] warning: no valid opportunities survived this run (all dropped or none produced).');
  }

  const out: OpportunitiesFile = {
    generated_at: rawOut.generated_at ?? new Date().toISOString(),
    world_summary: rawOut.world_summary,
    ...(validSagas.length ? { sagas: validSagas } : {}),
    opportunities: validOpps,
  };

  const rewrites = enforceMonotonicIds(out.opportunities, known);
  for (const r of rewrites) {
    console.error(`[gardener] rewrote ID ${r.from} → ${r.to} (collision with known IDs)`);
  }

  // Persist any saga the model authored or revised (merge preserves realized
  // stages). Opportunities tagged saga_id/saga_stage reference these.
  const authoredSagas = out.sagas ?? [];
  if (args.dryRun) {
    console.log('--- DRY RUN — would write to', OPPS_FILE, '---');
    if (authoredSagas.length) console.log(`(would upsert ${authoredSagas.length} saga(s))`);
    console.log(raw);
    return;
  }

  const changedSagas = upsertSagas(authoredSagas);
  if (changedSagas.length) {
    console.error(`[gardener] upserted ${changedSagas.length} saga(s): ${changedSagas.join(', ')}`);
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
