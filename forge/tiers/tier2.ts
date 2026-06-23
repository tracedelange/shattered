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
import { outputContract } from '../lib/yamlContract.ts';
import { abilityCatalog, grammarKit, featureCatalog } from '../lib/engine.ts';
import { formatFactionKit } from '../../pipeline/lib/grammar.ts';
import { BIOME_REGISTRY } from '../../server/game/mapgen/biomes/index.ts';
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

const TIER2_SKELETON = `
region_id: <region_id>
tasks:
  - id: <task_id>
    kind: <mob | item | quest | zone_enhance>
    zone: <existing_zone_id>
    requirement: "<precise instruction for Tier 3>"
    library_refs: []
`;

function tier2System(): string {
  return [
    'You are the Tier 2 regional designer for a grimdark fantasy MMO.',
    'Given the world storyline and ONE region (its zones + constraints), produce a list',
    'of HYPER-SPECIFIC implementation tasks for Tier 3 to translate into engine schema.',
    'Each task names a kind (mob|item|quest|zone_enhance), a target zone, a precise',
    'requirement, and any content-library ids it draws on. Cover each zone with',
    'appropriate threats and at least one quest beat per region. Do not invent new mechanics.',
    'Zones ALREADY EXIST (from the input graph) — NEVER create a zone. To adjust a',
    'zone\'s look, mood, or contents, emit a zone_enhance task (it adds prefab features',
    'and atmosphere — lighting, tint, fog, weather — to an existing zone).',
    '',
    'GAMEPLAY VOCABULARY — to make a mob a distinct fight (not just a stat block),',
    'put 0-2 of these ability ids into that mob task\'s library_refs. Tier 3 will',
    'attach them to the mob. Pick thematically (a caster gets a ranged/area ability,',
    'a brute gets a charge, a tough mob gets a self-buff):',
    abilityPoolText(),
    '',
    // CONTENT LIBRARY SEAM (reattached): the frozen faction kit. Assign each zone\'s
    // threats to ONE faction so its mobs, loot, and structures cohere, and name a
    // specific archetype per mob task.
    'FACTION KIT — pick the faction whose biome fits each zone. For every mob task,',
    'put that faction id AND one of its archetype ids into library_refs (alongside any',
    'ability ids). Theme the mob\'s name/flavor to the faction; keep its stat chassis',
    'to the chosen archetype. If no faction fits a zone\'s biome, leave it unassigned.',
    factionKitText(),
    '',
    // ZONE FEATURES — give zones distinct, visible identity. A zone_enhance task
    // with no real features renders as bare biome (the homogeneity bug), so make
    // these the point of a zone_enhance task, not atmosphere prose.
    'ZONE FEATURES — for every zone_enhance task, put 1-3 of these real feature ids',
    'into library_refs; Tier 3 places them as add_features. Pick by biome + role (a',
    'settlement gets a fountain/market, a frontier gets a guard_tower, a wild ruin',
    'gets a ruined_shrine). These ids are the ONLY valid features — never invent one.',
    featurePoolText(),
    '',
    outputContract(TIER2_SKELETON),
  ].join('\n');
}

function factionKitText(): string {
  return formatFactionKit(grammarKit()) || '  (no factions available)';
}

function featurePoolText(): string {
  const lines = featureCatalog().map((f) => `  - ${f.id}  ${f.note.replace(/\s+/g, ' ').trim()}`);
  return lines.length ? lines.join('\n') : '  (no features available)';
}

function abilityPoolText(): string {
  const lines = abilityCatalog().map((a) => `  - ${a.id}  (${a.shape}, ${a.effects})`);
  return lines.length ? lines.join('\n') : '  (no abilities available)';
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
  const pool = abilityCatalog().map((a) => a.id);
  const factions = grammarKit().factions;
  let mobIdx = 0;
  for (const zoneId of region.zones) {
    const z = zoneById(seed, zoneId);
    if (!z) continue;
    // Give each mob one ability, rotating the pool so a region's threats fight
    // differently (ranged / charge / buff) rather than being identical blocks.
    const ability = pool.length ? [pool[mobIdx % pool.length]!] : [];
    // Draw from the faction whose biome fits this zone; rotate its archetypes so
    // the zone's threats vary but stay inside one coherent kit.
    const faction = factions.find((f) => f.biomes.includes(z.biome));
    const archetype = faction ? faction.archetypes[mobIdx % faction.archetypes.length]! : null;
    const factionRefs = faction ? [faction.id, archetype!] : [];
    mobIdx++;
    tasks.push({
      id: `${zoneId}_mob`,
      kind: 'mob',
      zone: zoneId,
      requirement: faction
        ? `Populate ${zoneId} (${z.biome}, L${z.level_band.minLevel}-${z.level_band.maxLevel}) with a ${faction.name} threat (${faction.lore_hook.replace(/\s+/g, ' ').trim()}). Theme its name and flavor to the faction; keep its chassis to the named archetype.`
        : `Populate ${zoneId} (${z.biome}, L${z.level_band.minLevel}-${z.level_band.maxLevel}) with a threat appropriate to its biome and level. Theme its name and flavor to this zone.`,
      library_refs: [...factionRefs, ...ability],
    });
  }
  // one quest beat for the region: bounty at low tiers, a named hunt at the capstone
  const tier = seed.graph.zones.find((z) => region.zones.includes(z.id))?.level_band.tier ?? 1;
  const template = tier >= 3 ? 'hunt_named' : 'bounty';
  const hub = region.zones[0]!;
  tasks.push({
    id: `${region.id}_quest`,
    kind: 'quest',
    zone: hub,
    requirement: `A "${template}" quest given at ${hub} that sends the player against the region's threat and advances the storyline beat: ${region.motif}`,
    library_refs: [template, 'local_settler'],
  });
  tasks.push({
    id: `${region.id}_item`,
    kind: 'item',
    zone: hub,
    requirement: `A themed loot item for ${region.name}, appropriate to its level band.`,
    library_refs: [],
  });
  // Real, biome-appropriate features so the enhanced zone actually renders
  // distinct (the hub's biome optionalFeatures, else a safe default).
  const hubBiome = zoneById(seed, hub)?.biome;
  const hubFeatures = (BIOME_REGISTRY[hubBiome ?? '']?.optionalFeatures ?? []).slice(0, 2);
  tasks.push({
    id: `${region.id}_atmosphere`,
    kind: 'zone_enhance',
    zone: hub,
    requirement: `Enhance ${hub} with features that match the region motif: ${region.motif}`,
    library_refs: hubFeatures.length ? hubFeatures : ['ruined_shrine'],
  });
  return { region_id: region.id, tasks };
}
