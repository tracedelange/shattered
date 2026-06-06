// Gardener — reads the world, calls the LLM, writes opportunities.yaml.
//
// Usage:
//   npx tsx pipeline/gardener.ts                          # broad sweep
//   npx tsx pipeline/gardener.ts --dry-run                # print; don't write
//   npx tsx pipeline/gardener.ts --opencode               # use opencode run backend
//   npx tsx pipeline/gardener.ts --prompt "<focus>"       # focused investigation
//   npx tsx pipeline/gardener.ts --prompt-file <path>     # focus from file
//   echo "<focus>" | npx tsx pipeline/gardener.ts --prompt-stdin
//   npx tsx pipeline/gardener.ts --audit <zone_id>        # visual zone audit
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
import { GARDENER_SYSTEM } from './lib/prompts.ts';
import { HISTORY_FILE, METRICS_FILE, OPPS_FILE, REPO_ROOT, fileExists, readYaml, writeYaml } from './lib/io.ts';
import { loadWorldBundle, formatWorldContext, formatPipelineState, formatMetricsContext } from './lib/worldSummary.ts';
import { callAndValidate } from './lib/validate.ts';
import { renderZoneToFile } from './lib/renderZone.ts';
import { loadWorld } from '../server/world/loader.ts';
import { computeWorldMetrics } from './lib/worldMetrics.ts';
import { OpportunitiesFileSchema, type Opportunity, type OpportunitiesFile } from './lib/schemas.ts';
import type { HistoryFile } from './lib/types.ts';

interface Args {
  dryRun: boolean;
  focus: string | null;
  auditZone: string | null;
  useOpenCode: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, focus: null, auditZone: null, useOpenCode: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--opencode') args.useOpenCode = true;
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
    }
  }
  if (args.focus !== null && args.focus.length === 0) args.focus = null;
  return args;
}

// Render the audit target to a PNG and return the relative + absolute paths.
// We render every time (rather than reusing a stale render) so the image the
// LLM reads always reflects the YAML the LLM is also seeing.
function renderAuditZone(zoneId: string): { rel: string; abs: string } {
  const world = loadWorld(join(REPO_ROOT, 'world'));
  const zoneDef = world.zones[zoneId];
  if (!zoneDef) throw new Error(`--audit zone not found: ${zoneId}`);
  const tilesetName = (zoneDef as { tileset?: string }).tileset || 'overworld';
  const tileset = world.tilesets[tilesetName];
  if (!tileset) throw new Error(`tileset not found for ${zoneId}: ${tilesetName}`);
  const rel = `world/renders/${zoneId}.png`;
  const abs = join(REPO_ROOT, rel);
  renderZoneToFile(zoneDef, tileset, abs, { mobs: world.mobs });
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
    `If the zone has visual issues, emit one or more refactor_zone`,
    `opportunities targeting \`${zoneId}\` with specific, actionable`,
    '`suggested_additions` that name the ops or regions to change. Quote',
    'what you saw in the render in the rationale (e.g. "river leaves a',
    '3-tile gap at the south edge", "two mob spawns sit in the wall along',
    'the east region").',
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
    for (const o of opps.opportunities ?? []) consume(o.id);
  }
  if (fileExists(HISTORY_FILE)) {
    const hist = readYaml<HistoryFile>(HISTORY_FILE);
    for (const e of hist.entries ?? []) consume(e.opportunity_id);
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
  mode: 'broad' | 'focus' | 'audit',
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
      'Aim for 1–4 opportunities total, weighted toward refactor_zone on the',
      'audited zone. Carry-forward and superseded entries from prior runs',
      'still apply.',
    );
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
      'Aim for a balanced mix of types (not just new_zone).',
      'Aim for 4–8 total opportunities in the final list.',
    );
  }
  return base.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.auditZone && args.focus) {
    throw new Error('--audit and --prompt/--prompt-file/--prompt-stdin are mutually exclusive');
  }

  let mode: 'broad' | 'focus' | 'audit' = 'broad';
  let focus = args.focus;
  if (args.auditZone) {
    const { rel } = renderAuditZone(args.auditZone);
    console.error(`[gardener] audit render → ${rel}`);
    focus = buildAuditFocus(args.auditZone, rel);
    mode = 'audit';
  } else if (args.focus) {
    mode = 'focus';
  }

  const bundle = loadWorldBundle();
  const worldContext = formatWorldContext(bundle);
  const pipelineState = formatPipelineState(bundle);
  const known = collectKnownIds();
  const nextId = `opp_${String(known.maxNum + 1).padStart(3, '0')}`;
  const userMessage = buildUserMessage(focus, nextId, mode);

  // Compute fresh structural metrics from the loaded world.
  // Written to world/pipeline/world_metrics.yaml so it's inspectable between runs,
  // and injected as a dedicated context block so the Gardener reasons from
  // hard numbers rather than re-deriving structure from the raw zone YAMLs.
  const worldDefs = loadWorld(join(REPO_ROOT, 'world'));
  const metrics = computeWorldMetrics(worldDefs, bundle.zones);
  writeYaml(METRICS_FILE, metrics);
  console.error(
    `[gardener] computed world_metrics: ${metrics.graph.total_zones} zones, ` +
    `${metrics.graph.connected_components} component(s), ` +
    `${metrics.graph.clusters.length} cluster(s), ` +
    `${metrics.graph.narrative_orphans.length} orphan(s), ` +
    `${metrics.signals.deepen_candidates.length} deepen candidate(s), ` +
    `${metrics.signals.at_max_branching.length} at max branching`,
  );
  const metricsContext = formatMetricsContext(metrics);

  if (mode === 'audit') {
    console.error(`[gardener] audit zone: ${args.auditZone}`);
  } else if (focus) {
    console.error(`[gardener] focus: ${focus.slice(0, 120)}${focus.length > 120 ? '…' : ''}`);
  }
  console.error('[gardener] calling LLM...');
  const { value: out, raw } = await callAndValidate({
    label: 'gardener',
    system: [GARDENER_SYSTEM, worldContext, pipelineState, metricsContext],
    user: userMessage,
    schema: OpportunitiesFileSchema,
    useOpenCode: args.useOpenCode,
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
  console.error(err);
  process.exit(1);
});
