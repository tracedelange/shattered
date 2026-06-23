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
import { RegionPlanSchema, mobIdFor, type RegionPlan, type Region, type WorldBlueprint } from '../lib/schemas.ts';
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

// Tier 3 is a DETERMINISTIC translator — it reads the TYPED fields below, not the
// requirement prose. Emit the typed fields for each kind; `requirement` is just a
// short human-readable note.
const TIER2_SKELETON = `
region_id: <region_id>
tasks:
  - id: <task_id>
    kind: mob
    zone: <existing_zone_id>
    requirement: "<short note>"
    faction_ref: <faction_id>             # from the FACTION KIT (match the zone's biome)
    archetype_ref: <archetype_id>         # one of that faction's archetypes
    ability_refs: [<ability_id>]          # 0-2 from the ABILITY POOL
    difficulty: <trash | elite | boss>    # where in the zone's level band
  - id: <task_id>
    kind: zone_enhance
    zone: <existing_zone_id>
    requirement: "<short note>"
    feature_refs: [<feature_id>]          # 1-3 from the FEATURE POOL (match the zone's biome)
  - id: <task_id>
    kind: quest
    zone: <hub_zone_id>
    requirement: "<short note>"
    giver_ref: <npc_id>                   # who gives the quest
    objective: { kind: <kill | collect | talk>, target_ref: <mob/item/npc id>, count: <int> }
    # For a kill quest, target_ref MUST be the mob id of a mob task in this region:
    # it is "<zone>_<archetype_ref>" (e.g. zone_1_2_raider_skirmisher).
  - id: <task_id>
    kind: item
    zone: <zone_id>
    requirement: "<short note>"
    item_spec: { slot: <mainhand|helmet|chest|gloves|leggings|boots|amulet|consumable>, family: <weapon|armor|consumable|trinket> }
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
    'set 0-2 of these ability ids as the mob task\'s `ability_refs`. Pick thematically',
    '(a caster gets a ranged/area ability, a brute gets a charge, a tough mob a buff):',
    abilityPoolText(),
    '',
    // CONTENT LIBRARY SEAM (reattached): the frozen faction kit. Assign each zone\'s
    // threats to ONE faction so its mobs, loot, and structures cohere, and name a
    // specific archetype per mob task.
    'FACTION KIT — pick the faction whose biome fits each zone. For every mob task,',
    'set `faction_ref` to that faction id and `archetype_ref` to ONE of its archetype',
    'ids. Theme the mob\'s flavor to the faction; its stat chassis comes from the',
    'archetype. If no faction fits a zone\'s biome, leave faction_ref/archetype_ref unset.',
    factionKitText(),
    '',
    // ZONE FEATURES — give zones distinct, visible identity. A zone_enhance task
    // with no real features renders as bare biome (the homogeneity bug), so make
    // these the point of a zone_enhance task, not atmosphere prose.
    'ZONE FEATURES — for every zone_enhance task, set `feature_refs` to 1-3 of these',
    'real feature ids; Tier 3 places them as add_features. A [biomes: …] tag means the',
    'feature ONLY fits those biomes — match the zone\'s biome (a settlement gets a',
    'fountain/market, a wild ruin gets a ruined_shrine); untagged features fit any',
    'biome. These ids are the ONLY valid features — never invent one.',
    featurePoolText(),
    '',
    outputContract(TIER2_SKELETON),
  ].join('\n');
}

function factionKitText(): string {
  return formatFactionKit(grammarKit()) || '  (no factions available)';
}

function featurePoolText(): string {
  const lines = featureCatalog().map((f) => {
    const where = f.biomes.length ? ` [biomes: ${f.biomes.join(', ')}]` : '';
    return `  - ${f.id}${where}  ${f.note.replace(/\s+/g, ' ').trim()}`;
  });
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
const difficultyForTier = (tier: number): 'trash' | 'elite' | 'boss' =>
  tier >= 5 ? 'boss' : tier >= 3 ? 'elite' : 'trash';

function stubTier2(seed: Seed, region: Region): RegionPlan {
  const tasks: RegionPlan['tasks'] = [];
  const pool = abilityCatalog().map((a) => a.id);
  const factions = grammarKit().factions;
  // Remember the hub zone's chosen threat so the region quest can target it.
  let hubArchetype: string | undefined;
  let mobIdx = 0;
  for (const zoneId of region.zones) {
    const z = zoneById(seed, zoneId);
    if (!z) continue;
    // Rotate one ability per mob so a region's threats fight differently.
    const ability = pool.length ? [pool[mobIdx % pool.length]!] : [];
    // Draw from the faction whose biome fits this zone; rotate its archetypes so
    // the zone's threats vary but stay inside one coherent kit.
    const faction = factions.find((f) => f.biomes.includes(z.biome));
    const archetype = faction ? faction.archetypes[mobIdx % faction.archetypes.length]! : undefined;
    if (zoneId === region.zones[0]) hubArchetype = archetype;
    mobIdx++;
    tasks.push({
      id: `${zoneId}_mob`,
      kind: 'mob',
      zone: zoneId,
      requirement: faction
        ? `A ${faction.name} threat in ${zoneId} (${z.biome}, L${z.level_band.minLevel}-${z.level_band.maxLevel}): ${faction.lore_hook.replace(/\s+/g, ' ').trim()}`
        : `A threat in ${zoneId} (${z.biome}, L${z.level_band.minLevel}-${z.level_band.maxLevel}) appropriate to its biome and level.`,
      faction_ref: faction?.id,
      archetype_ref: archetype,
      ability_refs: ability,
      difficulty: difficultyForTier(z.level_band.tier),
      library_refs: [...(faction ? [faction.id, archetype!] : []), ...ability],
    });
  }
  const hub = region.zones[0]!;
  const hubZone = zoneById(seed, hub);
  // One quest beat: a kill bounty against the hub zone's threat.
  tasks.push({
    id: `${region.id}_quest`,
    kind: 'quest',
    zone: hub,
    requirement: `A bounty given at ${hub} against the region's threat — advances the beat: ${region.motif}`,
    giver_ref: 'local_settler',
    objective: { kind: 'kill', target_ref: mobIdFor(hub, hubArchetype), count: 5 },
    library_refs: ['local_settler'],
  });
  tasks.push({
    id: `${region.id}_item`,
    kind: 'item',
    zone: hub,
    requirement: `A themed weapon for ${region.name}, appropriate to its level band.`,
    item_spec: { slot: 'mainhand', family: 'weapon' },
    library_refs: [],
  });
  // Real, biome-appropriate features so the enhanced zone renders distinct
  // (the hub's biome optionalFeatures, else a safe default).
  const hubFeatures = (BIOME_REGISTRY[hubZone?.biome ?? '']?.optionalFeatures ?? []).slice(0, 2);
  const featureRefs = hubFeatures.length ? hubFeatures : ['ruined_shrine'];
  tasks.push({
    id: `${region.id}_atmosphere`,
    kind: 'zone_enhance',
    zone: hub,
    requirement: `Enhance ${hub} with features that match the region motif: ${region.motif}`,
    feature_refs: featureRefs,
    library_refs: featureRefs,
  });
  return { region_id: region.id, tasks };
}
