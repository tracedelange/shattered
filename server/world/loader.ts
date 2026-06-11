import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import yaml from 'js-yaml';
import { BLOCKING_TILES, MOB_ROLES } from '../../shared/constants.ts';
import {
  BIOME_REGISTRY,
  resolveBiomeGenOps,
  mergeFeatures,
} from '../game/mapgen/biomes/index.ts';
import { resolveSeed, mulberry32 } from '../game/mapgen/rng.ts';
import type {
  Affix, ItemBase, MobTemplate, Prefab, QuestDef, Tileset, WorldDefs, ZoneDef,
} from '../../shared/types.ts';

function readYaml<T>(path: string): T {
  return yaml.load(readFileSync(path, 'utf8')) as T;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Authored min/max overrides stored in world/biome-params.json. */
type BiomeParamOverrides = Record<string, {
  zoneParams?: Record<string, { min?: number; max?: number }>;
  opParams?:   Record<string, Record<string, { min?: number; max?: number }>>;
}>;

export function loadBiomeParamOverrides(worldDir: string): BiomeParamOverrides {
  try { return JSON.parse(readFileSync(join(worldDir, 'biome-params.json'), 'utf8')); }
  catch { return {}; }
}

/** Derives a deterministic value within [min, max] snapped to step, keyed by seed + path. */
function seedParam(
  p: { min: number; max: number; step: number },
  overrides: { min?: number; max?: number } | undefined,
  zoneSeed: string,
  path: string,
): number {
  const min = overrides?.min ?? p.min;
  const max = overrides?.max ?? p.max;
  const rng = mulberry32(resolveSeed(`${zoneSeed}:param:${path}`));
  const steps = Math.round((max - min) / p.step);
  return min + Math.round(rng() * steps) * p.step;
}

/**
 * When a zone specifies a `biome`, derive its `ops` from the biome pipeline
 * at load time. All declared biome params (zone-level and op-level) are seeded
 * from the zone seed for deterministic per-zone variation. Authored min/max
 * bounds from biome-params.json constrain the seeded range. Explicit zone-file
 * overrides in `zoneParams` / `opParams` always take precedence.
 */
export function resolveBiomeOps(zone: ZoneDef, paramOverrides: BiomeParamOverrides): ZoneDef {
  if (!zone.biome) return zone;

  const biomeDef = BIOME_REGISTRY[zone.biome];
  if (!biomeDef) {
    console.warn(`[loader] Zone '${zone.id}' references unknown biome '${zone.biome}' — skipping op derivation.`);
    return zone;
  }

  const rawSeed = zone.seed ?? `${zone.id}:default`;
  const numSeed = resolveSeed(rawSeed);

  const biomeOver = paramOverrides[zone.biome!] ?? {};

  // Derive zone-level params from seed, then overlay explicit zone overrides.
  const seededZoneParams: Record<string, number> = {};
  for (const p of biomeDef.zoneParams ?? []) {
    seededZoneParams[p.id] = seedParam(p, biomeOver.zoneParams?.[p.id], rawSeed, p.id);
  }
  const mergedZoneParams = { ...seededZoneParams, ...(zone.zoneParams ?? {}) };

  // Derive basePipeline op-level params from seed, then overlay explicit zone overrides.
  const seededOpParams: Record<string, Record<string, number>> = {};
  for (const entry of biomeDef.basePipeline) {
    if (entry.id && entry.params?.length) {
      seededOpParams[entry.id] = {};
      for (const p of entry.params) {
        const over = biomeOver.opParams?.[entry.id]?.[p.field];
        seededOpParams[entry.id]![p.field] = seedParam(p, over, rawSeed, `${entry.id}:${p.field}`);
      }
    }
  }
  // Field-level merge: zone file overrides win per field, not per entry.
  const mergedOpParams: Record<string, Record<string, number>> = { ...seededOpParams };
  for (const [entryId, fields] of Object.entries(zone.opParams ?? {})) {
    mergedOpParams[entryId] = { ...(mergedOpParams[entryId] ?? {}), ...fields };
  }

  // Merge the biome's default features with the zone's per-feature overrides
  // (toggle on/off, tune params, or add a new feature) into the placement list.
  // The array form (['beach_S']) is shorthand for "enable these with defaults".
  const featureOverrides = Array.isArray(zone.features)
    ? Object.fromEntries(zone.features.map((id) => [id, true as const]))
    : zone.features;
  const features = mergeFeatures(biomeDef.features, featureOverrides);
  const { ops } = resolveBiomeGenOps(biomeDef, rawSeed, {
    opParams: mergedOpParams,
    features,
  });

  const inset = zone.inset ?? mergedZoneParams['inset'] ?? 0;

  return {
    tileset:      zone.tileset      ?? biomeDef.tileset,
    width:        zone.width        ?? biomeDef.width,
    height:       zone.height       ?? biomeDef.height,
    default_tile: zone.default_tile ?? biomeDef.defaultTile,
    ...zone,
    inset,
    ops,
  };
}

export function loadWorld(rootDir: string): WorldDefs {
  const zones: Record<string, ZoneDef> = {};
  const mobs: Record<string, MobTemplate> = {};
  const itemBases: Record<string, ItemBase> = {};
  const affixes: { prefixes: Affix[]; suffixes: Affix[] } = { prefixes: [], suffixes: [] };
  const quests: Record<string, QuestDef> = {};
  const tilesets: Record<string, Tileset> = {};
  const prefabs: Record<string, Prefab> = {};

  const paramOverrides = loadBiomeParamOverrides(rootDir);
  const zonesDir = join(rootDir, 'zones');
  for (const file of walk(zonesDir)) {
    const ext = extname(file);
    let zone: ZoneDef | null = null;
    if (ext === '.yaml') zone = readYaml<ZoneDef>(file);
    else if (ext === '.json') zone = readJson<ZoneDef>(file);
    if (!zone) continue;
    zones[zone.id] = resolveBiomeOps(zone, paramOverrides);
  }

  const mobsDir = join(rootDir, 'entities', 'mobs');
  for (const file of walk(mobsDir)) {
    if (extname(file) !== '.yaml') continue;
    const mob = readYaml<MobTemplate>(file);
    if (!(mob.role in MOB_ROLES)) {
      const valid = Object.keys(MOB_ROLES).join(', ');
      throw new Error(`Mob "${mob.id}" (${file}): invalid role "${mob.role}". Must be one of: ${valid}`);
    }
    mobs[mob.id] = mob;
  }

  const basesDir = join(rootDir, 'entities', 'items', 'bases');
  for (const file of walk(basesDir)) {
    if (extname(file) !== '.yaml') continue;
    const base = readYaml<ItemBase>(file);
    itemBases[base.id] = base;
  }

  const affixesDir = join(rootDir, 'entities', 'items', 'affixes');
  for (const file of walk(affixesDir)) {
    if (extname(file) !== '.yaml') continue;
    const doc = readYaml<{ prefixes?: Affix[]; suffixes?: Affix[] }>(file);
    if (doc.prefixes) affixes.prefixes.push(...doc.prefixes);
    if (doc.suffixes) affixes.suffixes.push(...doc.suffixes);
  }

  const questsDir = join(rootDir, 'quests');
  for (const file of walk(questsDir)) {
    if (extname(file) !== '.yaml') continue;
    const quest = readYaml<QuestDef>(file);
    quests[quest.id] = quest;
  }

  const tilesetsDir = join(rootDir, 'tilesets');
  for (const file of walk(tilesetsDir)) {
    if (extname(file) !== '.json') continue;
    const ts = readJson<Tileset>(file);
    tilesets[ts.name || basename(file, '.json')] = ts;
  }

  // Named prefabs (optional dir). Available by id to stamp/place/post_ops.
  const prefabsDir = join(rootDir, 'prefabs');
  if (existsSync(prefabsDir)) {
    for (const file of walk(prefabsDir)) {
      if (extname(file) !== '.json') continue;
      const prefab = readJson<Prefab>(file);
      const id = prefab.id || basename(file, '.json');
      prefabs[id] = { ...prefab, id };
    }
  }

  // Extend the base blocking set with any tile entries that carry blocking: true.
  const blockingTiles = new Set(BLOCKING_TILES);
  for (const ts of Object.values(tilesets)) {
    for (const [name, entry] of Object.entries(ts.tiles)) {
      if (entry.blocking) blockingTiles.add(name);
    }
  }

  return { zones, mobs, itemBases, affixes, quests, tilesets, prefabs, blockingTiles };
}
