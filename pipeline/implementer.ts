// Implementer — picks the top pending opportunity, asks the LLM to build it,
// writes the resulting YAML files, updates the lore bible and history.
//
// Usage:
//   npx tsx pipeline/implementer.ts                          # top pending
//   npx tsx pipeline/implementer.ts --opportunity opp_008    # specific id
//   npx tsx pipeline/implementer.ts --dry-run                # don't write
//   npx tsx pipeline/implementer.ts --require-approved       # only "approved"
//   npx tsx pipeline/implementer.ts --no-commit              # write but don't git commit/push (direct invocation)
//   npm run implementer -- --skip-commit                     # same via npm (--no-commit is intercepted by npm)
//   npx tsx pipeline/implementer.ts --plan                   # enable two-phase plan+execute (off by default)

import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { implementerSystemFor, IMPLEMENTER_PLAN_PROMPT } from './lib/prompts.ts';
import {
  HISTORY_FILE, LORE_FILE, OPPS_FILE, REPO_ROOT, WORLD_DIR, TILESETS_DIR,
  readText, readYaml, writeText, writeYaml, fileExists, listJsonFiles,
} from './lib/io.ts';
import {
  loadWorldBundle,
  formatFocusedWorldContext,
  formatImplementerMetrics,
} from './lib/worldSummary.ts';
import type { ZoneMetrics } from './lib/worldMetrics.ts';
import type { WorldDefs } from '../shared/types.ts';

/** One-block ring: the seed zones plus their immediate connection neighbours,
 *  read straight from zone definitions (no metrics pass needed). */
function expandRingFromDefs(seedIds: string[], defs: WorldDefs): Set<string> {
  const ring = new Set(seedIds);
  for (const id of seedIds) {
    for (const n of Object.values(defs.zones[id]?.connections ?? {})) {
      if (n) ring.add(n);
    }
  }
  return ring;
}
import { callAndValidate } from './lib/validate.ts';
import { UsageLimitError, USAGE_LIMIT_EXIT_CODE } from './lib/llm.ts';
import { initRunLog } from './lib/runLog.ts';
import { renderZoneToFile, renderZoneToAscii } from './lib/renderZone.ts';
import { loadWorld } from '../server/world/loader.ts';
import { computeWorldMetrics } from './lib/worldMetrics.ts';
import { lintBuildPlan, formatPlanWarnings } from './lib/planLint.ts';
import { applyFileOps, assertNoCoordinatesInPostOps, validatePrefabGrid } from './lib/fileOps.ts';
import { validateZoneStub, buildZoneStubFromSpec } from './lib/zoneStub.ts';
import { validateReferences } from './lib/refValidate.ts';
import { repairZoneBySeedRetry } from './lib/zoneRepair.ts';
import { buildZoneContext, formatZoneContext } from './lib/context.ts';
import {
  BuildPlanSchema,
  ImplementerOutputSchema,
  type BuildPlan,
  type LoreUpdate,
  type TilesetUpdate,
  type Opportunity,
  type OpportunitiesFile,
} from './lib/schemas.ts';
import type { HistoryFile, OpportunityStatus, RenderStat } from './lib/types.ts';

interface Args {
  dryRun: boolean;
  opportunityId: string | null;
  requireApproved: boolean;
  noCommit: boolean;
  plan: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, opportunityId: null, requireApproved: false, noCommit: false, plan: false };
  // npm intercepts --no-* flags and sets npm_config_<name>='false' instead of
  // passing them through process.argv. Check the env var as a fallback.
  if (process.env.npm_config_commit === 'false' || process.env.npm_config_commit === '') {
    args.noCommit = true;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--require-approved') args.requireApproved = true;
    else if (a === '--no-commit' || a === '--skip-commit') args.noCommit = true;
    else if (a === '--plan') args.plan = true;
    else if (a === '--opportunity') args.opportunityId = argv[++i] ?? null;
  }
  return args;
}

interface LoreBible {
  [key: string]: unknown;
  factions?: unknown[];
  geography?: unknown[];
  zones?: unknown[];
  unresolved?: string[];
}

// Pull leading comment block (the file header) out of bible.yaml so we can
// re-attach it after re-dumping the parsed YAML. js-yaml drops comments on
// round-trip, but the header is the only one worth preserving.
function splitLoreHeader(text: string): { header: string; body: string } {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trimStart().startsWith('#'))) {
    i++;
  }
  return {
    header: lines.slice(0, i).join('\n'),
    body: lines.slice(i).join('\n'),
  };
}

// Find the tileset JSON whose `name` field matches `name`. Returns the absolute
// path or null if no file claims that name. We resolve by `name`, not filename,
// because the loader keys tilesets by their declared name.
function resolveTilesetPath(name: string): string | null {
  if (!/^[a-z0-9_]+$/i.test(name)) {
    throw new Error(`tileset_update.tileset has unsafe characters: ${name}`);
  }
  for (const path of listJsonFiles(TILESETS_DIR)) {
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as { name?: string };
      if (doc.name === name) return path;
    } catch {
      // skip unparseable file
    }
  }
  return null;
}

interface TilesetDoc {
  name?: string;
  tile_size?: number;
  tiles?: Record<string, { color: string } & Record<string, unknown>>;
  sprites?: Record<string, { color: string } & Record<string, unknown>>;
  [k: string]: unknown;
}

// Returns { added_tiles, added_sprites } so we can log what changed.
function applyTilesetUpdate(update: TilesetUpdate): {
  path: string;
  rel: string;
  added_tiles: string[];
  added_sprites: string[];
} {
  const path = resolveTilesetPath(update.tileset);
  if (!path) throw new Error(`tileset_update target not found: ${update.tileset}`);
  const doc = JSON.parse(readFileSync(path, 'utf8')) as TilesetDoc;
  doc.tiles = doc.tiles ?? {};
  doc.sprites = doc.sprites ?? {};

  const addedTiles: string[] = [];
  const addedSprites: string[] = [];
  for (const [k, v] of Object.entries(update.tiles_add ?? {})) {
    if (k in doc.tiles) continue; // skip existing — never overwrite by mistake
    doc.tiles[k] = v;
    addedTiles.push(k);
  }
  for (const [k, v] of Object.entries(update.sprites_add ?? {})) {
    if (k in doc.sprites) continue;
    doc.sprites[k] = v;
    addedSprites.push(k);
  }

  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const rel = path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path;
  return { path, rel, added_tiles: addedTiles, added_sprites: addedSprites };
}

function mergeLore(bible: LoreBible, update: LoreUpdate): void {
  const u = update as LoreUpdate & {
    zones_replace?: unknown[];
    factions_replace?: unknown[];
    geography_replace?: unknown[];
    unresolved_replace?: string[];
  };

  for (const key of ['zones', 'factions', 'geography'] as const) {
    const replace = u[`${key}_replace`];
    if (replace !== undefined) {
      bible[key] = replace;
    } else {
      const append = update[`${key}_append`];
      if (append && append.length > 0) bible[key] = [...(bible[key] ?? []), ...append];
    }
  }

  if (u.unresolved_replace !== undefined) {
    bible.unresolved = u.unresolved_replace;
  } else {
    if (update.unresolved_resolve?.length) {
      const remaining = (bible.unresolved ?? []).filter((entry) => {
        const e = String(entry);
        return !update.unresolved_resolve!.some((needle) => e.includes(needle));
      });
      bible.unresolved = remaining;
    }
    if (update.unresolved_append?.length) {
      bible.unresolved = [...(bible.unresolved ?? []), ...update.unresolved_append];
    }
  }
}

function pickOpportunity(file: OpportunitiesFile, args: Args): Opportunity {
  const pool = file?.opportunities ?? [];
  if (args.opportunityId) {
    const found = pool.find((o) => o.id === args.opportunityId);
    if (!found) throw new Error(`Opportunity ${args.opportunityId} not found.`);
    return found;
  }
  const eligibleStatus: OpportunityStatus = args.requireApproved ? 'approved' : 'pending';
  const eligible = pool
    .filter((o) => o.status === eligibleStatus)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  if (eligible.length === 0) {
    throw new Error(`No opportunities with status="${eligibleStatus}" found.`);
  }
  return eligible[0];
}

/**
 * Extracts zone IDs that are explicitly named in an opportunity so we can
 * focus the metrics context on the local area. Only IDs that exist in the
 * current world are returned (new zones that don't exist yet are skipped).
 */
function extractRelevantZoneIds(
  opportunity: Opportunity,
  knownZoneIds: Set<string>,
): string[] {
  const opp = opportunity as Record<string, unknown>;
  const candidates: string[] = [];

  for (const field of ['target_zone', 'suggested_new_zone_id', 'suggested_id', 'from_zone', 'to_zone']) {
    if (typeof opp[field] === 'string') candidates.push(opp[field] as string);
  }

  const conn = opp.connection as Record<string, unknown> | undefined;
  if (conn && typeof conn.zone === 'string') candidates.push(conn.zone as string);

  return candidates.filter((id) => knownZoneIds.has(id));
}

/**
 * Entity template IDs the execute phase needs: those explicitly named in the
 * opportunity (suggested_entities) plus those spawned in the relevant zones.
 */
function extractRelevantEntityIds(
  opportunity: Opportunity,
  expandedZoneIds: Set<string>,
  zoneMetrics: ZoneMetrics[],
): Set<string> {
  const ids = new Set<string>();
  const opp = opportunity as Record<string, unknown>;
  const suggested = opp.suggested_entities;
  if (Array.isArray(suggested)) {
    for (const id of suggested) {
      if (typeof id === 'string') ids.add(id);
    }
  }
  for (const zm of zoneMetrics) {
    if (expandedZoneIds.has(zm.id)) {
      for (const e of zm.unique_entities) ids.add(e);
    }
  }
  return ids;
}

/** Quest IDs the execute phase needs (currently only target_quest for refactor_quest). */
function extractRelevantQuestIds(opportunity: Opportunity): Set<string> {
  const ids = new Set<string>();
  const opp = opportunity as Record<string, unknown>;
  if (typeof opp.target_quest === 'string') ids.add(opp.target_quest as string);
  return ids;
}

/**
 * Resolves the effective zone IDs to pass to formatFocusedWorldContext.
 *
 * - Types that touch no zone file need no zone bodies.
 * - All other types use the pre-expanded set. There is deliberately NO
 *   fall-back to "all zones": on a large world that produced 400k-token
 *   contexts. If extraction found nothing, the model works from the lore
 *   bible + Zone Contexts and we log a loud warning instead.
 */
function buildContextZoneIds(
  opportunity: Opportunity,
  expandedZoneIds: Set<string>,
): Set<string> {
  const noZoneTypes = new Set<string>([
    'tile_create', 'lore_refactor', 'prefab_create',
    // legacy aliases still present in hand-edited opportunity files
    'add_tile', 'refactor_lore',
  ]);
  if (noZoneTypes.has(opportunity.type)) return new Set();
  if (expandedZoneIds.size === 0) {
    console.error(
      `[implementer] warning: no zone ids extracted from ${opportunity.id} ` +
      `(type=${opportunity.type}) — context will include no zone bodies`,
    );
  }
  return expandedZoneIds;
}

function validatePath(rel: string): string {
  // Refuse anything that tries to escape the repo or touch unrelated files.
  const cleaned = rel.replace(/^\.\/+/, '');
  if (cleaned.startsWith('/') || cleaned.includes('..')) {
    throw new Error(`Unsafe path from LLM: ${rel}`);
  }
  const allowedPrefixes = ['world/zones/', 'world/entities/', 'world/quests/', 'world/prefabs/'];
  if (!allowedPrefixes.some((p) => cleaned.startsWith(p))) {
    throw new Error(`LLM tried to write outside allowed dirs: ${rel}`);
  }
  const isJson = cleaned.startsWith('world/prefabs/') || cleaned.startsWith('world/zones/');
  if (isJson ? !cleaned.endsWith('.json') : !cleaned.endsWith('.yaml')) {
    throw new Error(`LLM tried to write wrong format: ${rel} (zones and prefabs must be .json, entities/quests must be .yaml)`);
  }
  return join(REPO_ROOT, cleaned);
}

// Repair prompt for referential errors: same contract as the schema-repair
// path in validate.ts — re-emit the full corrected response, fixing only the
// listed problems.
function buildRefRepairMessage(prevRaw: string, errors: string[]): string {
  return [
    'Your previous response references things that do not exist in the world',
    'and are not created in the response itself:',
    '',
    ...errors.map((e) => `- ${e}`),
    '',
    'Re-emit the SAME response with these fixed. Either create the missing',
    'entity/item/prefab/sprite in the same response, or switch the reference',
    'to something that exists. Do not change anything else.',
    'Output ONLY the corrected YAML in a single ```yaml fenced block.',
    '',
    '```yaml',
    prevRaw.replace(/```/g, "'''"),
    '```',
  ].join('\n');
}

async function main(): Promise<void> {
  initRunLog('implementer');
  const args = parseArgs(process.argv.slice(2));

  if (!fileExists(OPPS_FILE)) {
    throw new Error(`No opportunities file at ${OPPS_FILE}. Run gardener first.`);
  }
  // An empty/0-byte file parses to undefined — treat as no opportunities so the
  // graceful "No opportunities with status pending" path runs (the loop keys on
  // it to move to the gardener) rather than crashing.
  const opps = readYaml<OpportunitiesFile>(OPPS_FILE) ?? { opportunities: [] };
  const opportunity = pickOpportunity(opps, args);
  console.error(
    `[implementer] picked ${opportunity.id} (${opportunity.type}, priority=${opportunity.priority})`,
  );

  const bundle = loadWorldBundle();
  const oppYaml = yaml.dump(opportunity, { lineWidth: -1, noRefs: true });

  // Pre-flight: compute structural metrics for the relevant zone neighbourhood.
  const preFlight = loadWorld(WORLD_DIR);
  const knownZoneIds = new Set(Object.keys(preFlight.zones));
  const relevantZoneIds = extractRelevantZoneIds(opportunity, knownZoneIds);

  // Expand to the one-block ring straight from zone connections (cheap), and
  // scope the expensive grid/walkability metrics to that ring only — a
  // single-opportunity run must not regenerate all ~1700 zones in the world.
  const expandedZoneIds = expandRingFromDefs(relevantZoneIds, preFlight);
  const worldMetrics = computeWorldMetrics(preFlight, expandedZoneIds);
  const metricsContext = formatImplementerMetrics(worldMetrics, expandedZoneIds);

  // Resolve the zone set for world-context formatting (never "all zones").
  const contextZoneIds = buildContextZoneIds(opportunity, expandedZoneIds);

  // Entity and quest IDs needed by the execute phase only.
  const relevantEntityIds = extractRelevantEntityIds(opportunity, contextZoneIds, worldMetrics.zones);
  const relevantQuestIds = extractRelevantQuestIds(opportunity);

  // Execute phase: full relevant slice — add mobs and quests.
  const executeContext = formatFocusedWorldContext(
    bundle, contextZoneIds, relevantEntityIds, relevantQuestIds,
  );

  // ZoneContext (Implementor v2): coordinate-free semantic handles (named_regions,
  // tile_types_present, weights) for the explicitly-referenced existing zones, so
  // post_ops / file_ops can target regions and tiles without seeing coordinates.
  const zoneContexts = relevantZoneIds
    .map((id) => buildZoneContext(id, preFlight))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const zoneContextBlock = zoneContexts.length
    ? ['# Zone Contexts (semantic handles for post_ops / file_ops)', '', ...zoneContexts.map(formatZoneContext)].join('\n')
    : '';

  // --- Phase 1: Build Plan (opt-in via --plan) -----------------------------
  // Separates spatial reasoning from serialization. Valuable for complex
  // multi-zone opportunities; overkill for simple enhancements.
  const knownTilesets = new Set(Object.keys(preFlight.tilesets));
  let planSection = '';

  if (args.plan) {
    const planContext = formatFocusedWorldContext(bundle, contextZoneIds, new Set(), new Set());
    const planUserMessage = [
      'Produce a build plan for the opportunity below.',
      '',
      '```yaml',
      oppYaml.trim(),
      '```',
    ].join('\n');

    console.error('[implementer] calling LLM for build plan...');
    const { value: plan } = await callAndValidate({
      label: 'implementer-plan',
      system: [IMPLEMENTER_PLAN_PROMPT, planContext, metricsContext],
      user: planUserMessage,
      schema: BuildPlanSchema,
      effort: 'medium',
    });

    const planYaml = yaml.dump(plan, { lineWidth: -1, noRefs: true });
    console.error(
      `[implementer] plan: ${plan.zones.length} zone(s) [${plan.zones.map(z => `${z.id}(${z.mode}${z.archetype ? `:${z.archetype}` : ''})`).join(', ')}]` +
      (plan.entities_needed?.length ? `, ${plan.entities_needed.length} entity(ies) needed` : ''),
    );

    const planWarnings = lintBuildPlan(plan, knownZoneIds, knownTilesets);
    for (const w of planWarnings) {
      console.error(`[implementer] plan-lint [${w.code}] ${w.zone}: ${w.message}`);
    }

    planSection = [
      '',
      '## Build Plan',
      '',
      '```yaml',
      planYaml.trim(),
      '```',
      formatPlanWarnings(planWarnings),
    ].join('\n');
  }

  // --- Phase 2: Execute ----------------------------------------------------
  const userMessage = [
    args.plan
      ? 'Implement the opportunity below. Your approved build plan is attached.\nFollow the plan. Emit the fenced YAML described in your system prompt.'
      : 'Implement the opportunity below. Emit the fenced YAML described in your system prompt.',
    '',
    '## Opportunity',
    '',
    '```yaml',
    oppYaml.trim(),
    '```',
    planSection,
  ].join('\n');

  const implementerSystem = implementerSystemFor(opportunity.type);

  console.error('[implementer] calling LLM...');
  const systemBlocks = [implementerSystem, executeContext, metricsContext, zoneContextBlock].filter(Boolean);
  let { value: out, raw } = await callAndValidate({
    label: 'implementer',
    system: systemBlocks,
    user: userMessage,
    schema: ImplementerOutputSchema,
    disableTools: true,
    effort: 'medium',
  });

  // Referential validation: every entity/prefab/tile/zone the response
  // references must exist in the world or be created in the response itself.
  // One repair retry with the precise error list, then hard-fail.
  let refErrors = validateReferences(out, preFlight);
  if (refErrors.length > 0) {
    console.error(`[implementer] referential errors:\n${refErrors.map((e) => `  - ${e}`).join('\n')}`);
    console.error('[implementer] asking LLM to repair references...');
    ({ value: out, raw } = await callAndValidate({
      label: 'implementer-ref-repair',
      system: systemBlocks,
      user: buildRefRepairMessage(raw, refErrors),
      schema: ImplementerOutputSchema,
      disableTools: true,
      effort: 'medium',
    }));
    refErrors = validateReferences(out, preFlight);
    if (refErrors.length > 0) {
      throw new Error(`[implementer] referential errors persist after repair:\n${refErrors.join('\n')}`);
    }
    console.error('[implementer] reference repair succeeded.');
  }

  // Summarize what the LLM returned before we touch disk, so the log shows the
  // shape of the response independent of write/render side-effects.
  const byKind = (prefix: string) =>
    out.files.filter((f) => f.path.startsWith(`world/${prefix}/`)).length;
  console.error(
    `[implementer] LLM returned ${out.files.length} file(s) ` +
    `[zones=${byKind('zones')}, entities=${byKind('entities')}, quests=${byKind('quests')}], ` +
    `new_zones=${out.new_zones?.length ?? 0}, ` +
    `lore_update=${out.lore_update && Object.keys(out.lore_update).length > 0 ? 'yes' : 'no'}, ` +
    `tileset_update=${out.tileset_update ? out.tileset_update.tileset : 'no'}, ` +
    `status=${out.status ?? '(default)'}`,
  );
  if (out.notes) console.error(`[implementer] notes: ${out.notes}`);

  // Validate every zone and prefab body BEFORE anything is written. Zone files
  // must be v2 biome stubs (validateZoneStub rejects hand-authored op-lists),
  // their post_ops must respect the coordinate boundary, and prefab grids must
  // be rectangular and legend-covered. Throwing here aborts the run cleanly.
  for (const f of out.files) {
    if (f.path.startsWith('world/zones/')) {
      const stub = validateZoneStub(f.path, f.body);
      if (stub.post_ops) assertNoCoordinatesInPostOps(stub.post_ops, stub.id);
    } else if (f.path.startsWith('world/prefabs/')) {
      const parsed = JSON.parse(f.body) as { data?: string; legend?: Record<string, string> };
      const err = validatePrefabGrid(parsed as { data: string; legend: Record<string, string> });
      if (err) throw new Error(`[implementer] prefab ${f.path} invalid — ${err}`);
    }
  }

  // Validate FileOps' coordinate boundary up front so a bad post_op aborts the
  // whole run before any file is touched (applyFileOps re-checks at write time).
  for (const fo of out.file_ops ?? []) {
    if (fo.op === 'append_post_ops') assertNoCoordinatesInPostOps(fo.ops, fo.zone_id);
  }

  // Materialize new_zones specs into stub file writes. The host derives all
  // mechanical fields (seed, spawn_point, connections, level_band-from-parent)
  // and synthesizes the lore bible entry — the LLM supplied only the creative
  // fields. Parent existence was checked by validateReferences.
  for (const spec of out.new_zones ?? []) {
    if (knownZoneIds.has(spec.id)) {
      throw new Error(
        `[implementer] new_zones['${spec.id}'] already exists — refusing to overwrite. ` +
        `If this opportunity was already implemented, mark it superseded.`,
      );
    }
    const parent = preFlight.zones[spec.parent_zone]!;
    const stub = buildZoneStubFromSpec(spec, parent);
    out.files.push({
      path: `world/zones/${spec.id}.json`,
      op: 'write',
      body: JSON.stringify(stub, null, 2) + '\n',
    });
    out.lore_update = out.lore_update ?? {};
    out.lore_update.zones_append = [
      ...(out.lore_update.zones_append ?? []),
      {
        id: spec.id,
        summary: spec.lore_summary,
        connections: [spec.parent_zone],
        implemented: new Date().toISOString().slice(0, 10),
      },
    ];
    console.error(`[implementer] new_zones: built stub for ${spec.id} (${spec.biome}, parent ${spec.parent_zone})`);
  }

  // A response is a no-op only if it writes no files, runs no file_ops, AND has
  // no lore / tileset side-effects. A tileset-only or lore-only response is real work.
  const isNoOp =
    out.files.length === 0 && (out.file_ops?.length ?? 0) === 0 && !out.lore_update && !out.tileset_update;

  // Resolve and check every path before writing anything.
  const resolved = out.files.map((f) => ({
    abs: validatePath(f.path),
    rel: f.path,
    op: f.op,
    body: f.body,
  }));

  if (args.dryRun) {
    console.log('--- DRY RUN — would write the following ---');
    for (const f of resolved) {
      console.log(`\n# ${f.op} ${f.rel}\n${f.body}`);
    }
    if (out.file_ops?.length) {
      const r = applyFileOps(out.file_ops, { dryRun: true });
      console.log(`\n# file_ops: ${out.file_ops.length} op(s) → create ${r.created.length}, modify ${r.modified.length}`);
      console.log(yaml.dump(out.file_ops, { lineWidth: -1, noRefs: true }));
    }
    if (out.lore_update) {
      console.log(`\n# merge into ${LORE_FILE}\n${yaml.dump(out.lore_update)}`);
    }
    if (out.tileset_update) {
      console.log(`\n# merge into tileset ${out.tileset_update.tileset}\n${JSON.stringify(out.tileset_update, null, 2)}`);
    }
    if (out.notes) console.log(`\n# history note: ${out.notes}`);
    return;
  }

  const written: string[] = [];
  const modified: string[] = [];
  for (const f of resolved) {
    const exists = fileExists(f.abs);
    writeText(f.abs, f.body.endsWith('\n') ? f.body : f.body + '\n');
    (exists ? modified : written).push(f.rel);
    console.error(`[implementer] ${f.op === 'modify' || exists ? 'modified' : 'wrote'} ${f.rel}`);
  }

  // Apply the validated FileOp layer (Implementor v2). Surgical mutations to
  // existing zones (append_post_ops / patch_*) plus any `create` ops the LLM
  // routed here instead of files[]. Validation already ran above.
  let fileOpAbsPaths: string[] = [];
  let fileOpTouchedZones: string[] = [];
  if (out.file_ops?.length) {
    const r = applyFileOps(out.file_ops);
    written.push(...r.created);
    modified.push(...r.modified);
    fileOpAbsPaths = r.absPaths;
    fileOpTouchedZones = r.touchedZones;
    console.error(
      `[implementer] file_ops: ${out.file_ops.length} op(s) — ` +
      `created ${r.created.length}, modified ${r.modified.length}, zones touched [${r.touchedZones.join(', ')}]`,
    );
  }

  if (out.lore_update && Object.keys(out.lore_update).length > 0) {
    const raw = readText(LORE_FILE);
    const { header, body } = splitLoreHeader(raw);
    const bible = (yaml.load(body) ?? {}) as LoreBible;
    mergeLore(bible, out.lore_update);
    const dumped = yaml.dump(bible, { lineWidth: -1, noRefs: true });
    writeText(LORE_FILE, (header ? header.replace(/\s*$/, '\n\n') : '') + dumped);
    modified.push('world/lore/bible.yaml');
  }

  let tilesetAbsPath: string | null = null;
  if (out.tileset_update) {
    const r = applyTilesetUpdate(out.tileset_update);
    if (r.added_tiles.length + r.added_sprites.length === 0) {
      console.error(`[implementer] tileset_update on ${out.tileset_update.tileset}: no new entries (all already present)`);
    } else {
      console.error(
        `[implementer] tileset_update on ${out.tileset_update.tileset}: ` +
        `+${r.added_tiles.length} tiles [${r.added_tiles.join(', ')}], ` +
        `+${r.added_sprites.length} sprites [${r.added_sprites.join(', ')}]`,
      );
      tilesetAbsPath = r.path;
      modified.push(r.rel);
    }
  }

  // Resolve the opportunity's final status. Default is 'implemented' when we
  // wrote files; for a no-op we default to 'superseded'. The LLM can override.
  const finalStatus: OpportunityStatus = out.status ?? (isNoOp ? 'superseded' : 'implemented');
  opportunity.status = finalStatus;
  (opportunity as Record<string, unknown>).implemented_at = new Date().toISOString();
  writeYaml(OPPS_FILE, opps);

  // Force-render every zone YAML touched in this run. This is the "be honest"
  // mechanism — the LLM may have rendered during its session, but we render
  // again here so the artifact always reflects the final canonical YAML.
  const touchedZoneIds = Array.from(new Set([
    ...resolved
      .filter(f => f.rel.startsWith('world/zones/') && /\.(json|yaml)$/.test(f.rel))
      .map(f => f.rel.replace(/^world\/zones\//, '').replace(/\.(json|yaml)$/, '')),
    ...fileOpTouchedZones,
  ]));
  const renders: string[] = [];
  const renderStats: RenderStat[] = [];
  if (touchedZoneIds.length > 0) {
    // Zone files created in THIS run own their seed and may be reseeded by the
    // programmatic repair. Existing zones (touched only via file_ops) have
    // frozen seeds — their issues are surfaced for the Gardener instead.
    const runCreatedZoneIds = new Set(
      resolved
        .filter((f) => f.rel.startsWith('world/zones/'))
        .map((f) => f.rel.replace(/^world\/zones\//, '').replace(/\.(json|yaml)$/, '')),
    );
    let fresh = loadWorld(join(REPO_ROOT, 'world'));

    // Programmatic structural repair: a stub's grid is a pure function of
    // biome + seed, so retry seeds host-side and keep the best. No LLM call.
    for (const zoneId of touchedZoneIds) {
      if (!runCreatedZoneIds.has(zoneId) || !fresh.zones[zoneId]) continue;
      try {
        const r = repairZoneBySeedRetry(zoneId, WORLD_DIR, fresh.tilesets, fresh.prefabs);
        if (r.reseeded) {
          console.error(
            `[implementer] seed-repair: ${zoneId} reseeded → ${r.seed} after ${r.attempts} attempt(s) ` +
            `(inaccessible=${r.inaccessibleTiles}, accessible_default=${r.accessibleDefaultTiles})`,
          );
        } else if (r.inaccessibleTiles > 0 || r.accessibleDefaultTiles > 0) {
          console.error(
            `[implementer] seed-repair: ${zoneId} kept ${r.seed} — no candidate was cleaner ` +
            `(inaccessible=${r.inaccessibleTiles}, accessible_default=${r.accessibleDefaultTiles})`,
          );
        }
        if (r.reseeded) fresh = loadWorld(join(REPO_ROOT, 'world'));
      } catch (err) {
        console.error(`[implementer] seed-repair failed for ${zoneId} (non-fatal): ${(err as Error).message}`);
      }
    }

    for (const zoneId of touchedZoneIds) {
      const zoneDef = fresh.zones[zoneId];
      if (!zoneDef) {
        console.error(`[implementer] render skipped: ${zoneId} not found post-write`);
        continue;
      }
      const tilesetName = (zoneDef as { tileset?: string }).tileset || 'overworld';
      const tileset = fresh.tilesets[tilesetName];
      if (!tileset) {
        console.error(`[implementer] render skipped: tileset '${tilesetName}' missing for ${zoneId}`);
        continue;
      }
      const outRel = `world/renders/${zoneId}.png`;
      const outAbs = join(REPO_ROOT, outRel);
      try {
        const result = renderZoneToFile(zoneDef, tileset, outAbs, { mobs: fresh.mobs, prefabs: fresh.prefabs });
        renders.push(outRel);
        const lg = result.legend;
        console.error(
          `[implementer] rendered ${outRel} ` +
          `(${result.width}x${result.height}px, ` +
          `${lg.regions.length} region(s), ${lg.spawns.length} spawn(s), ${lg.portals.length} portal(s))`,
        );

        const { text } = renderZoneToAscii(zoneDef, { tileset, prefabs: fresh.prefabs });
        console.error(`[implementer]   ASCII map for ${zoneId}:`);
        console.error(text.split('\n').map((l) => '    ' + l).join('\n'));

        // Surface remaining zone-quality signals: recorded in history so the
        // Gardener can schedule a follow-up; never re-prompted in this run.
        if (lg.inaccessibleTiles > 0) {
          console.error(`[implementer]   ⚠ ${zoneId}: ${lg.inaccessibleTiles} walkable tile(s) unreachable from entry points`);
        }
        if (lg.accessibleDefaultTiles > 0) {
          console.error(
            `[implementer]   ⚠ ${zoneId}: ${lg.accessibleDefaultTiles} background '${lg.accessibleDefaultTileName}' tile(s) ` +
            `reachable — likely a dungeon-carving issue`,
          );
        }
        if (lg.inaccessibleTiles > 0 || lg.accessibleDefaultTiles > 0) {
          renderStats.push({
            zone: zoneId,
            inaccessible_tiles: lg.inaccessibleTiles,
            accessible_default_tiles: lg.accessibleDefaultTiles,
            accessible_default_tile_name: lg.accessibleDefaultTileName,
          });
        }
      } catch (err) {
        console.error(`[implementer] render failed for ${zoneId}: ${(err as Error).message}`);
      }
    }
  }

  // Append to history.yaml.
  const history = fileExists(HISTORY_FILE)
    ? readYaml<HistoryFile>(HISTORY_FILE)
    : { entries: [] };
  history.entries = history.entries ?? [];
  history.entries.push({
    opportunity_id: opportunity.id,
    type: opportunity.type,
    ...(typeof (opportunity as Record<string, unknown>).target_zone === 'string'
      ? { target_zone: (opportunity as Record<string, unknown>).target_zone as string }
      : {}),
    implemented_at: new Date().toISOString(),
    files_written: written,
    files_modified: modified,
    notes: out.notes ?? '',
    ...(renders.length > 0 ? { renders } : {}),
    ...(renderStats.length > 0 ? { render_stats: renderStats } : {}),
  });
  writeYaml(HISTORY_FILE, history);

  if (isNoOp) {
    console.error(`[implementer] no-op: ${opportunity.id} → ${finalStatus}. ${out.notes}`);
  } else {
    console.error(`[implementer] done. ${written.length} written, ${modified.length} modified. status=${finalStatus}`);

    if (args.noCommit) {
      console.error('[implementer] --no-commit set: skipping git add/commit/push');
      return;
    }

    const stagedFiles = [
      ...resolved.map(f => f.abs),
      ...fileOpAbsPaths,
      OPPS_FILE,
      HISTORY_FILE,
      ...(out.lore_update && Object.keys(out.lore_update).length > 0 ? [LORE_FILE] : []),
      ...(tilesetAbsPath ? [tilesetAbsPath] : []),
    ];

    try {
      execSync(`git add ${stagedFiles.map(p => `"${p}"`).join(' ')}`, { cwd: REPO_ROOT });
      execSync(
        `git commit -m "Implement ${opportunity.id} (${opportunity.type})\n\n${out.notes ?? ''}"`,
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );
      execSync('git push', { cwd: REPO_ROOT, stdio: 'pipe' });
      console.error(`[implementer] committed and pushed ${opportunity.id}`);
    } catch (err) {
      console.error('[implementer] git commit/push failed:', (err as Error).message);
    }
  }
}

main().catch((err) => {
  if (err instanceof UsageLimitError) {
    console.error('[llm] USAGE_LIMIT', err.message);
    process.exit(USAGE_LIMIT_EXIT_CODE);
  }
  console.error(err);
  process.exit(1);
});
