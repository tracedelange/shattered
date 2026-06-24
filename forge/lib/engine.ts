// Validate a generated artifact body against the schemas the game engine writes
// — the same Zod schemas the real mutation/loader pipeline enforces, so "valid
// here" means "the engine would accept this". No repair: we report where the
// output goes wrong and leave it. Tier 3 also stages outputs in the engine's
// directory layout, so a high-quality run can be copied straight into world/.

import { z } from 'zod';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { MobBodySchema, ItemBodySchema } from '../../pipeline/lib/mutations.ts';
import { QuestBodySchema, validateStageGraph } from '../../server/world/quest_schema.ts';
import { FeatureEntrySchema } from '../../pipeline/lib/zoneStub.ts';
import { loadGrammar, type Grammar } from '../../pipeline/lib/grammar.ts';
import { FEATURE_REGISTRY, contentFeatureIds, featureBiomes } from '../../server/game/mapgen/features/index.ts';
import { validateAgainst, type Validation } from './trace.ts';

// ── Ability catalog (the gameplay vocabulary) ────────────────────────────────
// Loaded from the engine's real ability registry (world/abilities/), so a
// generated mob's ability references are checked against what the game actually
// has — the same conformance gate the engine loader enforces, mirrored here so
// Tier 2/3 can be told the closed set and the run can validate the refs.
const ABILITIES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'world', 'abilities');

export interface AbilitySummary { id: string; name: string; shape: string; effects: string }
let _catalog: AbilitySummary[] | null = null;

export function abilityCatalog(): AbilitySummary[] {
  if (_catalog) return _catalog;
  const out: AbilitySummary[] = [];
  if (existsSync(ABILITIES_DIR)) {
    for (const f of readdirSync(ABILITIES_DIR)) {
      if (!f.endsWith('.yaml')) continue;
      try {
        const a = yaml.load(readFileSync(join(ABILITIES_DIR, f), 'utf8')) as {
          id?: string; name?: string; targeting?: { shape?: string }; effects?: { kind: string }[];
        };
        if (a?.id) out.push({
          id: a.id,
          name: a.name ?? a.id,
          shape: a.targeting?.shape ?? '?',
          effects: (a.effects ?? []).map((e) => e.kind).join('+'),
        });
      } catch { /* skip malformed */ }
    }
  }
  _catalog = out;
  return out;
}

export function abilityIds(): Set<string> {
  return new Set(abilityCatalog().map((a) => a.id));
}

// ── Grammar kit (the frozen content vocabulary: factions + archetypes) ────────
// Mirrors the ability catalog: load the engine-orthogonal frozen library once
// (source of truth world/grammar/, like abilities), so Tier 2 can be told the
// faction roster and Tier 3 the archetype chassis, and the cascade references
// both by id in a task's library_refs.
let _grammar: Grammar | null = null;
export function grammarKit(): Grammar {
  if (!_grammar) _grammar = loadGrammar();
  return _grammar;
}
/** Drop the cached grammar so the next grammarKit() re-reads from disk. Called
 *  after the inventor freezes new entries, so a same-session grow sees them. */
export function resetGrammarKit(): void { _grammar = null; }

export function archetypeIds(): Set<string> {
  return new Set(grammarKit().archetypes.map((a) => a.id));
}

// ── Feature catalog (the closed set of placeable zone features) ───────────────
// Mirrors the ability catalog: a zone's `add_features` must reference real
// FEATURE_REGISTRY ids, or the loader silently skips them (the cause of the
// "every zone collapses to bare biome" homogeneity). Surfaced to Tier 2 (which
// selects features into a zone_enhance task's library_refs) and Tier 3 (which
// emits them). `note` is the registry's own one-liner for an LLM selector.
//
// The catalog excludes terrain features (beaches/rivers/bridges) — those are
// world-gen-owned and flow from the zone graph, not cascade selection. Content
// features carry their `biomes` restriction so prompts can annotate/filter and
// the stager can hard-drop biome mismatches (no city_walls in a forest).
export interface FeatureSummary { id: string; note: string; biomes: string[] }
export function featureCatalog(biome?: string): FeatureSummary[] {
  return contentFeatureIds(biome).map((id) => ({
    id, note: FEATURE_REGISTRY[id]!.note, biomes: featureBiomes(id),
  }));
}

export function featureIds(): Set<string> {
  return new Set(Object.keys(FEATURE_REGISTRY));
}

export { featureAllowedInBiome } from '../../server/game/mapgen/features/index.ts';

// ── Zone enhancement contract ───────────────────────────────────────────────
// Zones pre-exist (input graph), so we never create them — we ENHANCE them.
// `add_features` mirrors the engine's real zone-content interface (prefabs +
// feature ops). `atmosphere` is a PROPOSED extension to ZoneDef (the visual/mood
// knobs the model kept reaching for) — not yet applied by the engine loader.
const AtmosphereSchema = z.object({
  light_level: z.number().min(0).max(1).optional(), // 0 dark … 1 bright (ties into the night cycle)
  tint: z.string().optional(),                       // hex (#rrggbb) or palette name
  fog: z.number().min(0).max(1).optional(),
  weather: z.enum(['none', 'rain', 'snow', 'sandstorm', 'ash', 'fog']).optional(),
  ambient_sound: z.string().optional(),
}).strict();

export const ZoneEnhanceSchema = z.object({
  zone: z.string().min(1),                              // existing zone id (target)
  add_features: z.array(FeatureEntrySchema).default([]), // engine-real: prefabs / feature ops
  atmosphere: AtmosphereSchema.optional(),               // proposed ZoneDef extension
  lore_summary: z.string().optional(),
}).strict();

// Where each artifact type lives under world/ (zone_enhance is a proposed-change
// folder, not a world/ path — an applier would merge these into zone files).
export const ENGINE_DIR: Record<string, string> = {
  mob: 'entities/mobs',
  item: 'entities/items/bases',
  quest: 'quests',
  zone_enhance: 'zone_enhancements',
};

/** Check a generated body against the schema for its type. */
export function validateEngineBody(type: string, content: unknown): Validation {
  switch (type) {
    case 'mob': {
      const v = validateAgainst(MobBodySchema, 'MobBodySchema', content, 'engine mob template (strict).');
      if (!v.ok) return v;
      // Conformance check: every referenced ability id must exist in the registry.
      const body = content as { abilities?: { ability: string }[] };
      const ids = abilityIds();
      const bad = (body.abilities ?? []).map((a) => a.ability).filter((id) => !ids.has(id));
      if (bad.length) {
        return {
          schema: 'MobBodySchema + abilityRefs', ok: false, note: 'mob ability references',
          error: `unknown ability id(s): ${bad.join(', ')}. Valid: ${[...ids].join(', ') || '(none loaded)'}`,
        };
      }
      return { ...v, schema: 'MobBodySchema + abilityRefs' };
    }
    case 'item':
      return validateAgainst(ItemBodySchema, 'ItemBodySchema', content, 'engine item base (strict).');
    case 'quest': {
      const v = validateAgainst(QuestBodySchema, 'QuestBodySchema', content, 'engine quest body + stage graph.');
      if (!v.ok) return v;
      try {
        validateStageGraph(content as Parameters<typeof validateStageGraph>[0], '(forge)');
      } catch (e) {
        return { schema: 'QuestBodySchema + stageGraph', ok: false, note: 'stage-graph reachability check', error: e instanceof Error ? e.message : String(e) };
      }
      return { ...v, schema: 'QuestBodySchema + stageGraph' };
    }
    case 'zone_enhance':
      return validateAgainst(ZoneEnhanceSchema, 'ZoneEnhanceSchema', content,
        'forge zone-enhancement contract: features are engine-real; atmosphere is a proposed ZoneDef extension, not yet applied.');
    default:
      return { schema: '(none)', ok: false, error: `no engine schema registered for artifact type "${type}"` };
  }
}
