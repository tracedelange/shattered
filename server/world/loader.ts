import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import yaml from 'js-yaml';
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

export function loadWorld(rootDir: string): WorldDefs {
  const zones: Record<string, ZoneDef> = {};
  const mobs: Record<string, MobTemplate> = {};
  const itemBases: Record<string, ItemBase> = {};
  const affixes: { prefixes: Affix[]; suffixes: Affix[] } = { prefixes: [], suffixes: [] };
  const quests: Record<string, QuestDef> = {};
  const tilesets: Record<string, Tileset> = {};

  const zonesDir = join(rootDir, 'zones');
  for (const file of walk(zonesDir)) {
    if (extname(file) !== '.yaml') continue;
    const zone = readYaml<ZoneDef>(file);
    zones[zone.id] = zone;
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

  return { zones, mobs, itemBases, affixes, quests, tilesets };
}
