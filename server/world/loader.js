import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import yaml from 'js-yaml';

function readYaml(path) {
  return yaml.load(readFileSync(path, 'utf8'));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function loadWorld(rootDir) {
  const zones = {};
  const mobs = {};
  const itemBases = {};
  const affixes = { prefixes: [], suffixes: [] };
  const quests = {};
  const tilesets = {};

  const zonesDir = join(rootDir, 'zones');
  for (const file of walk(zonesDir)) {
    if (extname(file) !== '.yaml') continue;
    const zone = readYaml(file);
    zones[zone.id] = zone;
  }

  const mobsDir = join(rootDir, 'entities', 'mobs');
  for (const file of walk(mobsDir)) {
    if (extname(file) !== '.yaml') continue;
    const mob = readYaml(file);
    mobs[mob.id] = mob;
  }

  const basesDir = join(rootDir, 'entities', 'items', 'bases');
  for (const file of walk(basesDir)) {
    if (extname(file) !== '.yaml') continue;
    const base = readYaml(file);
    itemBases[base.id] = base;
  }

  const affixesDir = join(rootDir, 'entities', 'items', 'affixes');
  for (const file of walk(affixesDir)) {
    if (extname(file) !== '.yaml') continue;
    const doc = readYaml(file);
    if (doc.prefixes) affixes.prefixes.push(...doc.prefixes);
    if (doc.suffixes) affixes.suffixes.push(...doc.suffixes);
  }

  const questsDir = join(rootDir, 'quests');
  for (const file of walk(questsDir)) {
    if (extname(file) !== '.yaml') continue;
    const quest = readYaml(file);
    quests[quest.id] = quest;
  }

  const tilesetsDir = join(rootDir, 'tilesets');
  for (const file of walk(tilesetsDir)) {
    if (extname(file) !== '.json') continue;
    const ts = readJson(file);
    tilesets[ts.name || basename(file, '.json')] = ts;
  }

  // Region types — geometry/floor/wall config previously hardcoded in mapgen.
  const regionTypes = {};
  const regionTypesDir = join(rootDir, 'region_types');
  if (existsSync(regionTypesDir)) {
    for (const file of walk(regionTypesDir)) {
      if (extname(file) !== '.yaml') continue;
      const rt = readYaml(file);
      if (rt?.id) regionTypes[rt.id] = rt;
    }
  }

  return { zones, mobs, itemBases, affixes, quests, tilesets, regionTypes };
}
