// Tier 2 — the regional pass. For ONE region, ingests the Tier 1 summary + the
// region's constraints, consults the content library (grammar), and emits
// hyper-specific implementation tasks for Tier 3. Mid model.

import yaml from 'js-yaml';
import { callAndValidate } from '../../pipeline/lib/validate.ts';
import { loadGrammar, type Grammar } from '../../pipeline/lib/grammar.ts';
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
  const grammar = loadGrammar();
  const prompt = { system: tier2System(grammar), user: tier2User(blueprint, region) };
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
  const output = stubTier2(seed, region, grammar);
  return { prompt, input, output, validation: check(output) };
}

function tier2System(grammar: Grammar): string {
  return [
    'You are the Tier 2 regional designer for a grimdark fantasy MMO.',
    'Given the world storyline and ONE region (its zones + constraints), produce a list',
    'of HYPER-SPECIFIC implementation tasks for Tier 3 to translate into engine schema.',
    'Each task names a kind (mob|item|quest|zone), a target zone, a precise requirement,',
    'and the content-library ids it draws on. Draw from the library below; do not invent',
    'mechanics. Cover each zone with appropriate threats and at least one quest beat per region.',
    '',
    '# Content library (draw archetypes/factions/quest templates from here)',
    '```yaml',
    yaml.dump({
      archetypes: grammar.archetypes.map((a) => ({ id: a.id, role: a.role, identity: a.identity })),
      factions: grammar.factions.map((f) => ({ id: f.id, archetypes: f.archetypes, biomes: f.biomes })),
      quest_templates: grammar.quest_templates.map((t) => ({ id: t.id, shape: t.shape, premise: t.premise })),
    }, { lineWidth: -1 }).trim(),
    '```',
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

// ── Stub: per zone a faction-appropriate mob task + one quest beat per region ───
function factionForBiome(grammar: Grammar, biome: string) {
  return grammar.factions.find((f) => f.biomes.includes(biome)) ?? grammar.factions[0];
}

function stubTier2(seed: Seed, region: Region, grammar: Grammar): RegionPlan {
  const tasks: RegionPlan['tasks'] = [];
  for (const zoneId of region.zones) {
    const z = zoneById(seed, zoneId);
    if (!z) continue;
    const faction = factionForBiome(grammar, z.biome);
    // pick an archetype that fits the tier (later tiers field heavier archetypes)
    const archetypeId = faction?.archetypes[Math.min(z.level_band.tier - 1, (faction.archetypes.length - 1))] ?? grammar.archetypes[0]?.id ?? 'glass_husk';
    tasks.push({
      id: `${zoneId}_mob`,
      kind: 'mob',
      zone: zoneId,
      requirement: `Populate ${zoneId} (L${z.level_band.minLevel}-${z.level_band.maxLevel}) with a ${faction?.name ?? 'local'} threat built from archetype "${archetypeId}". Theme its name and flavor to this zone.`,
      library_refs: [archetypeId, faction?.id ?? ''].filter(Boolean),
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
    library_refs: [template, 'oasis_settler'],
  });
  return { region_id: region.id, tasks };
}
