// forge/grow/grow.ts — Phase 1: one iterative grow step.
//
// Proposes ONE new region (Tier 1 grow), waits for user approval via an
// approve/regenerate gate, then forges it (Tier 2 + deterministic Tier 3) and
// appends the result to world-grown/.
//
//   npm run forge:grow              # stub mode (no LLM, fast)
//   FORGE_LIVE=1 npm run forge:grow # live Tier 1 + Tier 2
//
// After each step: WORLD_DIR=world-grown npm start

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  grownWorldDir, loadGrownState, saveGraph, saveBlueprint,
  stageZoneDef, stageArtifact, connectionsFor, frontierZones,
} from './worldState.ts';
import { synthesizeRegion } from '../lib/region-synth.ts';
import { runTier1Grow } from '../tiers/tier1-grow.ts';
import { runTier2 } from '../tiers/tier2.ts';
import { runTier3 } from '../tiers/tier3.ts';
import { isAbortError, mapPool } from '../lib/util.ts';
import type { RegionSpec, Region, WorldBlueprint } from '../lib/schemas.ts';
import type { Seed } from '../lib/seeds.ts';

const LIVE = !!process.env.FORGE_LIVE;
const AUTO_APPROVE = process.argv.includes('--yes') || process.argv.includes('-y');
const CONCURRENCY = Math.max(1, Number(process.env.FORGE_CONCURRENCY ?? 1));

async function grow(): Promise<void> {
  const worldDir = grownWorldDir();
  const { graph, blueprint } = loadGrownState(worldDir);
  const frontier = frontierZones(graph);
  const opts = { live: LIVE };

  if (frontier.length === 0) {
    console.error('[forge:grow] No frontier zones found. Cannot grow.');
    process.exit(1);
  }

  const growthStep = graph.generation + 1;
  console.log(`[forge:grow] World has ${graph.zones.length} zones; ${frontier.length} frontier zone(s).`);
  console.log(`[forge:grow] Growth step #${growthStep}  (live: ${LIVE})\n`);

  // ── Tier 1 (grow): propose a region, approve/regenerate gate ─────────────────
  let spec: RegionSpec | null = null;
  const rl = readline.createInterface({ input, output });

  while (true) {
    process.stdout.write('[grow] Tier 1: proposing region… ');
    const t1 = await runTier1Grow(blueprint, graph, opts);
    process.stdout.write('done.\n');

    if (!t1.validation.ok) {
      console.warn(`[grow] Tier 1 validation failed: ${t1.validation.error}`);
      console.warn('[grow] Regenerating…\n');
      continue;
    }

    spec = t1.output;
    console.log('\n─── Region Proposal ───────────────────────────────────────────────');
    console.log(yaml.dump(spec, { lineWidth: 80 }).trim());
    console.log('────────────────────────────────────────────────────────────────────\n');

    if (AUTO_APPROVE) { console.log('[grow] Auto-approved (--yes).'); break; }

    const answer = await rl.question('Approve? [y / r / n  — yes / regenerate / abort]: ');
    const a = answer.trim().toLowerCase();
    if (a === 'y' || a === 'yes') break;
    if (a === 'r' || a === 'regen' || a === 'regenerate') { spec = null; continue; }
    console.log('[grow] Aborted.');
    rl.close();
    return;
  }
  rl.close();

  if (!spec) return;

  // ── Region synthesis: assign coords + level bands ────────────────────────────
  console.log(`\n[grow] Synthesizing region (seam: ${spec.seam_zone})…`);
  const { newZones, seamLinks } = synthesizeRegion(spec, graph, growthStep);
  console.log(`[grow]   ${newZones.length} new zones: ${newZones.map((z) => z.id).join(', ')}`);

  // Build a grow-mode Seed: bible from the blueprint lore + full expanded graph.
  const growSeed: Seed = {
    bible: parseLore(blueprint.lore_history),
    graph: { zones: [...graph.zones, ...newZones] },
  };

  // Build the Region + WorldBlueprint for Tier 2 (reuse existing tier signatures).
  const regionId = `region_g${growthStep}`;
  const regionName = deriveRegionName(spec);
  const region: Region = {
    id: regionId,
    name: regionName,
    overview: spec.purpose,
    motif: spec.motif,
    zones: newZones.map((z) => z.id),
    constraints: [
      `Threats must draw from faction(s): ${spec.faction_ids.join(', ')}.`,
      `Quest beat: ${spec.quest_beat}`,
    ],
  };

  const growBlueprint: WorldBlueprint = {
    storyline: blueprint.storyline || spec.lore_continuation,
    lore_additions: spec.lore_continuation,
    regions: [region],
    zone_sketches: newZones.map((z, i) => ({
      zone: z.id,
      region: regionId,
      summary: spec.zones[i]?.note ?? `${z.biome} zone (${spec.zones[i]?.role ?? 'interior'}).`,
      role: spec.zones[i]?.role ?? 'wilderness',
    })),
  };

  // ── Tier 2: design the region's implementation tasks ─────────────────────────
  console.log('[grow] Tier 2: designing region tasks…');
  let plan;
  try {
    const t2 = await runTier2(growSeed, growBlueprint, region, opts);
    if (!t2.validation.ok) {
      console.warn(`[grow] Tier 2 validation warning: ${t2.validation.error}`);
    }
    plan = t2.output;
    console.log(`[grow]   ${plan.tasks.length} tasks planned.`);
  } catch (err) {
    if (isAbortError(err)) return;
    throw err;
  }

  // ── Tier 3: translate tasks to engine artifacts ───────────────────────────────
  console.log('[grow] Tier 3: translating tasks to engine artifacts…');
  let valid = 0, invalid = 0;
  await mapPool(plan.tasks, CONCURRENCY, async (task) => {
    try {
      const t3 = await runTier3(growSeed, task, opts);
      if (t3.validation.ok) {
        stageArtifact(worldDir, t3.output.filename, t3.output.content);
        valid++;
      } else {
        console.warn(`[grow]   INVALID ${task.id}: ${t3.validation.error}`);
        invalid++;
      }
    } catch (err) {
      if (isAbortError(err)) return;
      console.error(`[grow]   ERROR ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      invalid++;
    }
  });
  console.log(`[grow]   ${valid} valid, ${invalid} invalid artifacts.`);

  // ── Stage new zone JSON files + patch seam zone ───────────────────────────────
  console.log('[grow] Staging zone files…');
  for (const z of newZones) {
    const connections = connectionsFor(z.id, z.links);
    stageZoneDef(worldDir, {
      id: z.id,
      biome: z.biome,
      seed: z.seed,
      level_band: z.level_band,
      ...(Object.keys(connections).length ? { connections } : {}),
      ...(z.features.length ? { features: z.features } : {}),
    });
  }
  patchSeamZoneJson(worldDir, spec.seam_zone, seamLinks);

  // ── Commit: update graph.json + blueprint.json ────────────────────────────────
  const seam = graph.zones.find((z) => z.id === spec.seam_zone);
  if (seam) seam.links = seamLinks;
  graph.zones.push(...newZones);
  graph.generation = growthStep;
  saveGraph(worldDir, graph);

  blueprint.lore_history.push(spec.lore_continuation);
  blueprint.storyline = blueprint.storyline
    ? `${blueprint.storyline}\n\n${spec.lore_continuation}`
    : spec.lore_continuation;
  blueprint.regions.push({
    id: regionId,
    name: regionName,
    growth_step: growthStep,
    seam_zone: spec.seam_zone,
    motif: spec.motif,
    lore_paragraph: spec.lore_continuation,
    zone_ids: newZones.map((z) => z.id),
  });
  saveBlueprint(worldDir, blueprint);

  console.log(`\n[grow] ✓ Growth step #${growthStep} complete.`);
  console.log(`[grow]   New zones:  ${newZones.map((z) => z.id).join(', ')}`);
  console.log(`[grow]   Artifacts:  ${valid} valid${invalid ? `, ${invalid} invalid` : ''}`);
  console.log('[grow]');
  console.log('[grow] Boot: WORLD_DIR=world-grown npm start');
  console.log('[grow] Next: npm run forge:grow   (grow another region)');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseLore(history: string[]): Record<string, unknown> {
  const combined = history.join('\n\n');
  try {
    const parsed = yaml.load(combined);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* fall through */ }
  return { lore: combined || 'A village at the edge of the known world.' };
}

function deriveRegionName(spec: RegionSpec): string {
  const first = spec.purpose.split(':')[0]?.trim();
  if (first && first.length < 50) return first;
  return spec.motif.split('.')[0]?.trim() || 'Grown Region';
}

/** Rewrite the seam zone's staged JSON to include the new north connection. */
function patchSeamZoneJson(worldDir: string, seamId: string, newLinks: string[]): void {
  const path = join(worldDir, 'zones', `${seamId}.json`);
  let def: Record<string, unknown>;
  try {
    def = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch { return; }
  def.connections = connectionsFor(seamId, newLinks);
  writeFileSync(path, JSON.stringify(def, null, 2), 'utf8');
}

grow().catch((err) => {
  console.error('[forge:grow] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
