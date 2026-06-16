// Tier 2 — the regional pass. For ONE region, ingests the Tier 1 summary + the
// region's constraints and emits hyper-specific implementation tasks for Tier 3.
// Mid model.
//
// CONTENT LIBRARY SEAM: Tier 2 is the tier meant to draw on a content library
// (archetypes / factions / quest templates) when outlining a region. That
// library was removed; until a new one lands, Tier 2 works from the seed + zone
// graph alone. Reattach it where marked in `tier2System` and `stubTier2`.

import yaml from 'js-yaml';
import { callAndValidate } from '../../pipeline/lib/validate.ts';
import { RegionPlanSchema, type RegionPlan, type Region, type WorldBlueprint } from '../lib/schemas.ts';
import { sleep } from '../lib/util.ts';
import { validateAgainst, type TierResult } from '../lib/trace.ts';
import { zoneById, type Seed } from '../lib/seeds.ts';
import { tierModel } from '../lib/models.ts';
import type { TierOpts } from './opts.ts';

export async function runTier2(
  seed: Seed,
  blueprint: WorldBlueprint,
  region: Region,
  opts: TierOpts,
): Promise<TierResult<RegionPlan>> {
  const prompt = { system: tier2System(), user: tier2User(blueprint, region) };
  const input = { storyline: blueprint.storyline, region };
  const check = (out: RegionPlan) => validateAgainst(
    RegionPlanSchema, 'RegionPlanSchema', out,
    'tasks ≥ 1; each task.kind ∈ mob|item|quest|zone; non-empty zone + requirement.',
  );
  if (opts.live) {
    const { value } = await callAndValidate({
      label: `forge-tier2-${region.id}`,
      model: tierModel('tier2'),
      signal: opts.signal,
      system: [prompt.system],
      user: prompt.user,
      schema: RegionPlanSchema,
    });
    return { prompt, input, output: value, validation: check(value) };
  }
  await sleep(500, opts.signal);
  const output = stubTier2(seed, region);
  return { prompt, input, output, validation: check(output) };
}

function tier2System(): string {
  return [
    'You are the Tier 2 regional designer for a grimdark fantasy MMO.',
    'Given the world storyline and ONE region (its zones + constraints), produce a list',
    'of HYPER-SPECIFIC implementation tasks for Tier 3 to translate into engine schema.',
    'Each task names a kind (mob|item|quest|zone), a target zone, a precise requirement,',
    'and any content-library ids it draws on. Cover each zone with appropriate threats',
    'and at least one quest beat per region. Do not invent new mechanics.',
    // CONTENT LIBRARY SEAM: when a library exists, inject it here (archetypes /
    // factions / quest templates) and instruct Tier 2 to draw task.library_refs
    // from it rather than describing threats free-hand.
    'Output ONLY a single ```yaml block matching the required schema.',
  ].join('\n');
}

function tier2User(blueprint: WorldBlueprint, region: Region): string {
  return [
    '# World storyline', blueprint.storyline,
    '', '# Your region', '```yaml', yaml.dump(region, { lineWidth: -1 }).trim(), '```',
    '', 'Produce the Region Plan (implementation tasks).',
  ].join('\n');
}

// ── Stub: per zone a biome/level-appropriate mob task + one quest beat ──────────
function stubTier2(seed: Seed, region: Region): RegionPlan {
  const tasks: RegionPlan['tasks'] = [];
  for (const zoneId of region.zones) {
    const z = zoneById(seed, zoneId);
    if (!z) continue;
    tasks.push({
      id: `${zoneId}_mob`,
      kind: 'mob',
      zone: zoneId,
      requirement: `Populate ${zoneId} (${z.biome}, L${z.level_band.minLevel}-${z.level_band.maxLevel}) with a threat appropriate to its biome and level. Theme its name and flavor to this zone.`,
      library_refs: [], // CONTENT LIBRARY SEAM: archetype/faction ids go here
    });
  }
  // one quest beat for the region: bounty at low tiers, a named hunt at the capstone
  const tier = seed.graph.zones.find((z) => region.zones.includes(z.id))?.level_band.tier ?? 1;
  const template = tier >= 3 ? 'hunt_named' : 'bounty';
  const questZone = region.zones[0]!;
  tasks.push({
    id: `${region.id}_quest`,
    kind: 'quest',
    zone: questZone,
    requirement: `A "${template}" quest given at ${questZone} that sends the player against the region's threat and advances the storyline beat: ${region.motif}`,
    library_refs: [template, 'local_settler'],
  });
  return { region_id: region.id, tasks };
}
