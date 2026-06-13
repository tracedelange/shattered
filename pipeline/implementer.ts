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
  HISTORY_FILE, OPPS_FILE, REPO_ROOT, WORLD_DIR,
  readYaml, writeYaml, fileExists,
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
import { callLlm, UsageLimitError, USAGE_LIMIT_EXIT_CODE } from './lib/llm.ts';
import { initRunLog } from './lib/runLog.ts';
import { renderZoneToFile, renderZoneToAscii } from './lib/renderZone.ts';
import { loadWorld } from '../server/world/loader.ts';
import { computeWorldMetrics } from './lib/worldMetrics.ts';
import { lintBuildPlan, formatPlanWarnings } from './lib/planLint.ts';
import { validateMutations, applyMutations, type MutationFailure } from './lib/mutations.ts';
import { repairZoneBySeedRetry } from './lib/zoneRepair.ts';
import { buildZoneContext, formatZoneContext } from './lib/context.ts';
import { loadSagas, markStageRealized, formatSagaBrief } from './lib/sagas.ts';
import {
  BuildPlanSchema,
  ImplementerOutputSchema,
  type BuildPlan,
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
 * Failure isolation: when an opportunity can't be made valid even after the
 * repair retry, mark it `blocked` (with the reasons) and persist, so the caller
 * can return cleanly. This keeps ONE bad LLM response from killing the whole
 * loop — the loop just advances to the next pending opportunity. The gardener
 * wipes the queue each run and re-derives still-warranted work from world
 * state, so a blocked opp gets a fresh shot on a later cycle.
 */
function blockOpportunity(opps: OpportunitiesFile, opportunity: Opportunity, reasons: string[]): void {
  opportunity.status = 'blocked';
  (opportunity as Record<string, unknown>).blocked_reason = reasons.join(' | ');
  (opportunity as Record<string, unknown>).blocked_at = new Date().toISOString();
  writeYaml(OPPS_FILE, opps);
  console.error(
    `[implementer] BLOCKED ${opportunity.id} after repair — ${reasons.length} unrecoverable ` +
    `error(s). Committing nothing; the loop continues to the next opportunity.`,
  );
  for (const r of reasons) console.error(`  - ${r}`);
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

// Repair prompt for post-op structural warnings that survived seed retry.
// Shows the LLM the current zone JSON + the warnings, asks for a corrected
// JSON. Only the zone file is touched; no other files are returned.
function buildPostOpRepairMessage(zoneId: string, zoneJson: string, warnings: string[]): string {
  return [
    `Zone ${zoneId} was written this run but the following mapgen warnings`,
    'persist after programmatic seed and size repair — they require a',
    'structural fix in the zone JSON itself:',
    '',
    ...warnings.map((w) => `  ${w}`),
    '',
    'Common fixes:',
    '  - Add "overwrite": true to a stamp that carves through blocking tiles',
    '    or into a region claimed by an earlier post_op in the same list.',
    '  - Change "in_region" to "near_region" (or vice versa) when the target',
    '    region is too small to fit the prefab footprint.',
    '  - Remove a stamp whose at-region is never generated by the biome.',
    '',
    'Current zone JSON:',
    '```json',
    zoneJson,
    '```',
    '',
    'Return ONLY the corrected zone JSON in a single ```json fenced block.',
    'Change the minimum required to eliminate the warnings. Do not alter seeds,',
    'connections, spawns, or any field unrelated to the listed warnings.',
  ].join('\n');
}

// Repair prompt for invalid ops: re-emit the full op list with only the listed
// problems fixed. The errors come straight from the single mutation-validation
// boundary, so each names a precise op + reason.
function buildMutationRepairMessage(prevRaw: string, failed: MutationFailure[]): string {
  return [
    'Some operations in your previous response are invalid and cannot be applied:',
    '',
    ...failed.map((f) => `- [${f.op.op}] ${f.error}`),
    '',
    'Re-emit your FULL response (every op, in the same `mutations` list) with only',
    'these problems fixed. For each: correct the op, OR create the missing',
    'entity/item/prefab/zone/tile in the SAME response, OR remove that op. Do not',
    'change anything that was already valid, and do not emit an op type your task',
    'does not permit. Output ONLY the corrected YAML in a single ```yaml fenced block.',
    '',
    '```yaml',
    prevRaw.replace(/```/g, "'''"),
    '```',
  ].join('\n');
}

// Per-opportunity safety net (rung 2). Once main() commits to an opportunity,
// it arms this; the top-level catch consults it so an unexpected throw in the
// apply/write/render phase blocks THAT opportunity and exits 0 (the loop
// advances) instead of crashing the whole loop. Stays null until an
// opportunity is picked, so the "no pending" / "not found" throws from
// pickOpportunity propagate normally (the loop keys on the no-pending message).
// `dryRun` disarms the net: a --dry-run must never mutate OPPS_FILE, and the
// loop never dry-runs, so a throw there can exit 1 harmlessly.
let safetyNet: { opps: OpportunitiesFile; opportunity: Opportunity; dryRun: boolean } | null = null;

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

  // Arm the safety net now that we've committed to this opportunity: any
  // unexpected throw from here on (apply/write/render) blocks it rather than
  // killing the loop. The ref/body phases below still handle their own
  // validation blocking + clean return; this catches everything they don't.
  safetyNet = { opps, opportunity, dryRun: args.dryRun };

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

  // Saga brief: when this opportunity is tagged to an arc, give the model the
  // motif, secret, and this stage's place in the escalation so the piece reads
  // as one beat of the saga rather than a standalone zone.
  const sagaId = (opportunity as Record<string, unknown>).saga_id as string | undefined;
  const sagaStage = (opportunity as Record<string, unknown>).saga_stage as string | undefined;
  let sagaBrief = '';
  if (sagaId && sagaStage) {
    const saga = loadSagas().sagas.find((s) => s.id === sagaId);
    sagaBrief = formatSagaBrief(saga, sagaStage);
    if (!sagaBrief) {
      console.error(`[implementer] warning: opportunity tags saga ${sagaId}/${sagaStage} but it was not found`);
    } else {
      console.error(`[implementer] saga: realizing ${sagaId} stage '${sagaStage}'`);
    }
  }

  console.error('[implementer] calling LLM...');
  const systemBlocks = [implementerSystem, sagaBrief, executeContext, metricsContext, zoneContextBlock].filter(Boolean);
  let { value: out, raw } = await callAndValidate({
    label: 'implementer',
    system: systemBlocks,
    user: userMessage,
    schema: ImplementerOutputSchema,
    disableTools: true,
    effort: 'medium',
  });

  // Log the op shape before touching disk.
  const opCounts = out.mutations.reduce<Record<string, number>>((acc, m) => {
    acc[m.op] = (acc[m.op] ?? 0) + 1; return acc;
  }, {});
  console.error(
    `[implementer] LLM returned ${out.mutations.length} op(s) ` +
    `[${Object.entries(opCounts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}], ` +
    `status=${out.status ?? '(default)'}`,
  );
  if (out.notes) console.error(`[implementer] notes: ${out.notes}`);

  // The single validation boundary (Implementor v3). Structure was enforced by
  // the schema; this is the semantic + reference + scope pass over the WHOLE op
  // set, in one place. Failures are isolated per-op — the rest still apply. One
  // repair retry on the precise failure list, then skip whatever is still bad.
  const validateOpts = { opportunityType: opportunity.type, allowedZoneIds: new Set(expandedZoneIds) };
  let { valid, failed } = validateMutations(out.mutations, preFlight, validateOpts);
  if (failed.length > 0) {
    console.error(`[implementer] ${failed.length} op(s) failed validation:\n${failed.map((f) => `  - [${f.op.op}] ${f.error}`).join('\n')}`);
    console.error('[implementer] asking LLM to repair...');
    ({ value: out, raw } = await callAndValidate({
      label: 'implementer-repair',
      system: systemBlocks,
      user: buildMutationRepairMessage(raw, failed),
      schema: ImplementerOutputSchema,
      disableTools: true,
      effort: 'medium',
    }));
    ({ valid, failed } = validateMutations(out.mutations, preFlight, validateOpts));
    if (failed.length > 0) {
      console.error(
        `[implementer] ${failed.length} op(s) still invalid after repair — skipping them:\n` +
        failed.map((f) => `  - [${f.op.op}] ${f.error}`).join('\n'),
      );
    } else {
      console.error('[implementer] repair succeeded.');
    }
  }

  if (args.dryRun) {
    console.log('--- DRY RUN — would apply the following ops ---');
    const r = applyMutations(valid, preFlight, { dryRun: true });
    console.log(valid.length ? yaml.dump(valid, { lineWidth: -1, noRefs: true }) : '(no valid ops)');
    console.log(
      `\n# ${valid.length} valid op(s), ${failed.length} skipped → ` +
      `create ${r.created.length}, modify ${r.modified.length}, zones touched [${r.touchedZones.join(', ')}]`,
    );
    for (const w of r.warnings) console.log(w);
    if (out.notes) console.log(`\n# history note: ${out.notes}`);
    return;
  }

  // A legit no-op is zero ops returned (with notes). If the model emitted ops
  // but EVERY one was invalid, nothing is safe to apply — block so the
  // opportunity gets a fresh shot next cycle rather than recording false success.
  const isNoOp = out.mutations.length === 0;
  if (!isNoOp && valid.length === 0) {
    return blockOpportunity(opps, opportunity, failed.map((f) => `[${f.op.op}] ${f.error}`));
  }

  // Apply the validated op set atomically through the mutation boundary. Every
  // file touched is snapshotted; if any write throws, the whole set rolls back
  // and the per-opportunity safety net blocks this opportunity cleanly.
  const apply = applyMutations(valid, preFlight, {});
  const written = [...apply.created];
  const modified = [...apply.modified];
  for (const w of apply.warnings) console.error(w);
  console.error(
    `[implementer] applied ${apply.applied.length} op(s) — ` +
    `created ${apply.created.length}, modified ${apply.modified.length}, ` +
    `zones touched [${apply.touchedZones.join(', ')}]`,
  );

  // Resolve the opportunity's final status. Default is 'implemented' when we
  // wrote files; for a no-op we default to 'superseded'. The LLM can override.
  const finalStatus: OpportunityStatus = out.status ?? (isNoOp ? 'superseded' : 'implemented');
  opportunity.status = finalStatus;
  (opportunity as Record<string, unknown>).implemented_at = new Date().toISOString();
  writeYaml(OPPS_FILE, opps);

  // Advance the saga spine: a tagged opportunity that actually built something
  // marks its stage realized (and may complete the saga). A no-op never counts.
  if (sagaId && sagaStage && finalStatus === 'implemented') {
    const newStatus = markStageRealized(sagaId, sagaStage, opportunity.id);
    if (newStatus) {
      console.error(`[implementer] saga ${sagaId}: stage '${sagaStage}' realized → saga now ${newStatus}`);
    } else {
      console.error(`[implementer] warning: could not mark saga ${sagaId}/${sagaStage} realized (not found)`);
    }
  }

  // Force-render every zone YAML touched in this run. This is the "be honest"
  // mechanism — the LLM may have rendered during its session, but we render
  // again here so the artifact always reflects the final canonical YAML.
  const touchedZoneIds = apply.touchedZones;
  const renders: string[] = [];
  const renderStats: RenderStat[] = [];
  if (touchedZoneIds.length > 0) {
    // Zone files created in THIS run own their seed and may be reseeded by the
    // programmatic repair. Existing zones (mutated via add_*/set_zone_field) have
    // frozen seeds — their issues are surfaced for the Gardener instead.
    const runCreatedZoneIds = new Set(apply.createdZones);
    let fresh = loadWorld(join(REPO_ROOT, 'world'));

    // Programmatic structural repair: a stub's grid is a pure function of
    // biome + seed, so retry seeds host-side and keep the best. No LLM call.
    const persistentWarnings = new Map<string, string[]>(); // zoneId → warning lines
    for (const zoneId of touchedZoneIds) {
      if (!runCreatedZoneIds.has(zoneId) || !fresh.zones[zoneId]) continue;
      try {
        // Capture [mapgen] warnings emitted during the repair so we can feed
        // any that survive back to the LLM for a structural fix.
        const warningLines: string[] = [];
        const origWarn = console.warn;
        console.warn = (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].startsWith('[mapgen]')) warningLines.push(args[0]);
          origWarn.apply(console, args as Parameters<typeof origWarn>);
        };
        let r;
        try { r = repairZoneBySeedRetry(zoneId, WORLD_DIR, fresh.tilesets, fresh.prefabs); }
        finally { console.warn = origWarn; }

        const suffix = `(inaccessible=${r.inaccessibleTiles}, accessible_default=${r.accessibleDefaultTiles}, warnings=${r.warnings})`;
        if (r.reseeded || r.resized) {
          const what = [r.reseeded && `reseeded → ${r.seed}`, r.resized && `resized → ${r.width ?? 'default'}x${r.height ?? 'default'}`].filter(Boolean).join(', ');
          console.error(`[implementer] seed-repair: ${zoneId} ${what} after ${r.attempts} attempt(s) ${suffix}`);
        } else if (r.inaccessibleTiles > 0 || r.accessibleDefaultTiles > 0 || r.warnings > 0) {
          console.error(
            `[implementer] seed-repair: ${zoneId} kept ${r.seed} — no candidate was cleaner ${suffix}`,
          );
        }
        if (r.reseeded || r.resized) fresh = loadWorld(join(REPO_ROOT, 'world'));

        // Collect unique warnings from the best-seed evaluation for the LLM pass.
        if (r.warnings > 0) {
          const unique = [...new Set(warningLines)];
          persistentWarnings.set(zoneId, unique);
        }
      } catch (err) {
        console.error(`[implementer] seed-repair failed for ${zoneId} (non-fatal): ${(err as Error).message}`);
      }
    }

    // Structural repair pass: for zones whose mapgen warnings survived seed
    // retry, ask the LLM for a targeted JSON fix (one call per zone).
    if (persistentWarnings.size > 0) {
      for (const [zoneId, warnings] of persistentWarnings) {
        try {
          const stubPath = join(WORLD_DIR, 'zones', `${zoneId}.json`);
          const zoneJson = readFileSync(stubPath, 'utf8');
          console.error(`[implementer] post-repair: asking LLM to fix ${warnings.length} warning(s) in ${zoneId}…`);
          const raw = await callLlm({
            label: 'implementer-postop-repair',
            system: systemBlocks,
            user: buildPostOpRepairMessage(zoneId, zoneJson, warnings),
            disableTools: true,
            effort: 'medium',
          });
          // Extract JSON from a fenced block.
          const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (!jsonMatch?.[1]) {
            console.error(`[implementer] post-repair: no JSON block in LLM response for ${zoneId} — skipping`);
            continue;
          }
          const corrected = jsonMatch[1].trim();
          JSON.parse(corrected); // validate parseable before writing
          writeFileSync(stubPath, corrected.endsWith('\n') ? corrected : corrected + '\n', 'utf8');
          modified.push(`world/zones/${zoneId}.json`);
          console.error(`[implementer] post-repair: rewrote ${zoneId}`);
          fresh = loadWorld(join(REPO_ROOT, 'world'));
        } catch (err) {
          console.error(`[implementer] post-repair failed for ${zoneId} (non-fatal): ${(err as Error).message}`);
        }
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
      ...apply.absPaths,
      OPPS_FILE,
      HISTORY_FILE,
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
  // Rung-2 safety net: if we'd committed to an opportunity, block it and exit
  // cleanly so the loop advances to the next one instead of dying on a single
  // bad apply/write/render. (dryRun disarms this — it must not mutate OPPS_FILE.)
  if (safetyNet && !safetyNet.dryRun) {
    try {
      blockOpportunity(safetyNet.opps, safetyNet.opportunity, [
        `unexpected error during apply/write/render: ${(err as Error).message}`,
      ]);
      process.exit(0);
    } catch (netErr) {
      console.error('[implementer] safety net failed to block opportunity:', netErr);
    }
  }
  console.error(err);
  process.exit(1);
});
