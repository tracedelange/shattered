// Tier 3 — the translator. Takes ONE task and emits an engine-schema body
// (mob/item/quest/zone_enhance). DETERMINISTIC: no model call. Translation is
// mechanical, so it's code — the design intent lives entirely in Tier 1/2, which
// hand down typed choices (archetype/faction/feature/objective ids from closed
// vocabularies). This is correct by construction: sprites come from the frozen
// grammar/atlas, levels from the zone band, abilities/features are pre-validated,
// and quests are assembled from a reachable stage-machine template — so the
// classes of invalid output a cheap model used to emit (off-atlas sprites,
// out-of-band levels, auto-completing quests, biome-wrong features) cannot occur.

import { type Artifact, type Task, mobIdFor } from '../lib/schemas.ts';
import type { TierResult } from '../lib/trace.ts';
import { validateEngineBody, ENGINE_DIR, abilityIds, grammarKit, featureIds, featureAllowedInBiome } from '../lib/engine.ts';
import { getArchetype, getFaction } from '../../pipeline/lib/grammar.ts';
import { resolveMobSprite } from '../lib/sprites.ts';
import { zoneById, type Seed, type ZoneNode } from '../lib/seeds.ts';
import type { TierOpts } from './opts.ts';

export async function runTier3(seed: Seed, task: Task, _opts: TierOpts): Promise<TierResult<Artifact>> {
  const input = { task, refs: task.library_refs };
  const output = translate(seed, task);
  const validation = validateEngineBody(output.artifact_type, output.content);
  // Tier 3 is deterministic — there is no prompt. Keep the field for the trace
  // shape the UI/persistence expect.
  const prompt = { system: '(deterministic Tier-3 translator — no model call)', user: `task ${task.id} (${task.kind})` };
  return { prompt, input, output, validation };
}

// ── Translation ─────────────────────────────────────────────────────────────
const ROLE_BY_TIER: Record<number, string> = { 1: 'pest', 2: 'soldier', 3: 'ranged', 4: 'support', 5: 'tank' };
const title = (s: string): string => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Level a mob/item to its zone band by difficulty (trash=floor, boss=ceiling). */
function levelFor(z: ZoneNode | undefined, difficulty: Task['difficulty']): number {
  const b = z?.level_band;
  if (!b) return 1;
  if (difficulty === 'boss') return b.maxLevel;
  if (difficulty === 'elite') return Math.round((b.minLevel + b.maxLevel) / 2);
  return b.minLevel; // trash / unspecified
}

function translate(seed: Seed, task: Task): Artifact {
  switch (task.kind) {
    case 'mob':   return translateMob(seed, task);
    case 'item':  return translateItem(seed, task);
    case 'quest': return translateQuest(seed, task);
    default:      return translateZoneEnhance(seed, task);
  }
}

function translateMob(seed: Seed, task: Task): Artifact {
  const z = zoneById(seed, task.zone);
  const g = grammarKit();
  const arch = task.archetype_ref ? getArchetype(g, task.archetype_ref) : undefined;
  const faction = task.faction_ref ? getFaction(g, task.faction_ref) : undefined;
  const role = arch?.role ?? ROLE_BY_TIER[z?.level_band.tier ?? 1] ?? 'soldier';
  const level = levelFor(z, task.difficulty);

  const id = mobIdFor(task.zone, task.archetype_ref);
  // Theme the name from the faction skin + the archetype's concept noun.
  const archNoun = arch ? title(arch.id.split('_').pop() ?? 'threat') : 'Marauder';
  const factionWord = faction ? faction.name.replace(/^the\s+/i, '').replace(/s$/, '') : title(task.zone);
  const name = `${factionWord} ${archNoun}`.trim();

  // Abilities: typed ability_refs (fall back to legacy library_refs), kept only
  // if they resolve to real abilities. validateEngineBody re-checks this.
  const valid = abilityIds();
  const abilityRefs = task.ability_refs.length ? task.ability_refs : task.library_refs;
  const abilities = abilityRefs.filter((r) => valid.has(r)).map((ability) => ({ ability }));

  // Loot theme for the universal procedural drop: the archetype's loot_affinity
  // biases which base type drops, the faction's loot_flavor biases affix element.
  const lootAffinity = arch?.loot_affinity ?? [];
  const lootBrand = faction?.loot_flavor ?? [];

  const content = {
    id,
    name,
    sprite: resolveMobSprite(arch?.sprite, role, id),
    level,
    role,
    speed: arch?.speed ?? 1.0,
    behavior: arch?.behavior ?? 'patrol',
    aggro_range: arch?.aggro_range ?? 6,
    ...(abilities.length ? { abilities } : {}),
    ...(lootAffinity.length ? { loot_affinity: lootAffinity } : {}),
    ...(lootBrand.length ? { loot_brand: lootBrand } : {}),
  };
  return { task_id: task.id, artifact_type: 'mob', filename: `${ENGINE_DIR.mob}/${id}.yaml`, content };
}

function translateItem(seed: Seed, task: Task): Artifact {
  const z = zoneById(seed, task.zone);
  const level = levelFor(z, 'elite');
  const spec = task.item_spec ?? { slot: 'mainhand', family: 'weapon' as const };
  // slug() sanitizes zone ids that contain hyphens (e.g. zone_-1_0 from grown coords).
  const id = mobIdFor(task.zone, spec.family);
  const name = `${title(task.zone)} ${title(spec.family)}`;

  let body: Record<string, unknown>;
  switch (spec.family) {
    case 'armor':
      body = { slot: spec.slot, tags: ['armor'], base_defense: [level, level + 3], value: level * 8 };
      break;
    case 'consumable':
      body = { slot: 'consumable', tags: ['consumable'], use_effect: { heal: [level * 3, level * 5] }, value: level * 4 };
      break;
    case 'trinket':
      body = { slot: 'amulet', tags: ['trinket'], value: level * 15 };
      break;
    case 'weapon':
    default:
      body = { slot: 'mainhand', tags: ['weapon', 'blade'], base_damage: [Math.max(1, level - 1), level + 2], value: level * 10 };
  }
  const content = { id, name, ...body };
  return { task_id: task.id, artifact_type: 'item', filename: `${ENGINE_DIR.item}/${id}.yaml`, content };
}

function translateQuest(seed: Seed, task: Task): Artifact {
  const z = zoneById(seed, task.zone);
  const level = levelFor(z, 'elite');
  const giver = task.giver_ref ?? 'local_settler';
  const obj = task.objective;

  // Build a valid objective body for the act stage. Default to a kill bounty
  // against the zone's threat when Tier 2 left the objective untyped.
  let objective: Record<string, unknown>;
  let actText: string;
  let questName: string;
  switch (obj?.kind) {
    case 'collect':
      objective = { kind: 'collect_count', item_base: obj.target_ref ?? `${task.zone}_weapon`, target: obj.count ?? 3 };
      actText = 'Recover what was asked of you.';
      questName = 'Salvage';
      break;
    case 'talk':
      objective = { kind: 'talk', target_template: obj.target_ref ?? giver };
      actText = 'Seek out the one you were sent to find.';
      questName = 'A Word in Private';
      break;
    case 'kill':
    default:
      objective = {
        kind: 'kill_count',
        target: obj?.count ?? 5,
        template_id: obj?.target_ref ?? mobIdFor(task.zone, task.archetype_ref),
        zone: task.zone,
      };
      actText = 'Thin the threat menacing the area.';
      questName = 'Cull the Threat';
  }

  const content = {
    id: task.id,
    name: questName,
    giver,
    zone: task.zone,
    description: task.requirement,
    // accept → act → done: reachable, ends at the literal "done" — can't auto-complete.
    stages: [
      { id: 'accept', text: 'Take the work.', on_complete: 'act' },
      { id: 'act', text: actText, objective, on_complete: 'done' },
      { id: 'done', text: 'Return for your reward.' },
    ],
    rewards: [{ gold: level * 20, xp: level * 50 }],
  };
  return { task_id: task.id, artifact_type: 'quest', filename: `${ENGINE_DIR.quest}/${content.id}.yaml`, content };
}

function translateZoneEnhance(seed: Seed, task: Task): Artifact {
  // Place the features Tier 2 chose, filtered to the registry AND this zone's
  // biome so a settlement feature can't land in a forest (terrain features are
  // graph-owned and never selectable here).
  const biome = zoneById(seed, task.zone)?.biome;
  const refs = task.feature_refs.length ? task.feature_refs : task.library_refs;
  const features = refs.filter((r) => featureIds().has(r) && featureAllowedInBiome(r, biome));
  const content = {
    zone: task.zone,
    add_features: features.length ? features : ['ruined_shrine'],
    atmosphere: { light_level: 0.6, weather: 'none' },
    lore_summary: `Feature pass for ${title(task.zone)}.`,
  };
  return { task_id: task.id, artifact_type: 'zone_enhance', filename: `${ENGINE_DIR.zone_enhance}/${task.zone}.yaml`, content };
}
