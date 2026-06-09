import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import yaml from 'js-yaml';
import { BLOCKING_TILES } from '../../shared/constants.ts';
import {
  BIOME_REGISTRY,
  resolveBiomeGenOps,
} from '../game/mapgen/biomes/index.ts';
import { resolveFeatureOps } from '../game/mapgen/features/index.ts';
import { resolveSeed } from '../game/mapgen/rng.ts';
import type {
  Affix, ItemBase, MobTemplate, QuestDef, Tileset, WorldDefs, ZoneDef,
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

/**
 * When a zone specifies a `biome`, derive its `ops` from the biome pipeline
 * at load time. `inset` is taken from `zoneParams.inset` if present and not
 * already set on the zone directly.
 */
function resolveBiomeOps(zone: ZoneDef): ZoneDef {
  if (!zone.biome) return zone;

  const biomeDef = BIOME_REGISTRY[zone.biome];
  if (!biomeDef) {
    console.warn(`[loader] Zone '${zone.id}' references unknown biome '${zone.biome}' — skipping op derivation.`);
    return zone;
  }

  const rawSeed    = zone.seed ?? `${zone.id}:default`;
  const numSeed    = resolveSeed(rawSeed);
  const featureOps = resolveFeatureOps(zone.features ?? [], numSeed);
  const { ops } = resolveBiomeGenOps(biomeDef, rawSeed, {
    activeModules: zone.activeModules,
    opParams:      zone.opParams,
    featureOps,
  });

  const inset = zone.inset ?? zone.zoneParams?.['inset'] ?? 0;

  return {
    // Biome provides defaults for fields not explicitly set in the zone file.
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

  const zonesDir = join(rootDir, 'zones');
  for (const file of walk(zonesDir)) {
    const ext = extname(file);
    let zone: ZoneDef | null = null;
    if (ext === '.yaml') zone = readYaml<ZoneDef>(file);
    else if (ext === '.json') zone = readJson<ZoneDef>(file);
    if (!zone) continue;
    zones[zone.id] = resolveBiomeOps(zone);
  }

  const mobsDir = join(rootDir, 'entities', 'mobs');
  for (const file of walk(mobsDir)) {
    if (extname(file) !== '.yaml') continue;
    const mob = readYaml<MobTemplate>(file);
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

  // Extend the base blocking set with any tile entries that carry blocking: true.
  const blockingTiles = new Set(BLOCKING_TILES);
  for (const ts of Object.values(tilesets)) {
    for (const [name, entry] of Object.entries(ts.tiles)) {
      if (entry.blocking) blockingTiles.add(name);
    }
  }

  return { zones, mobs, itemBases, affixes, quests, tilesets, blockingTiles };
}
