// forge/lib/wire-zones.ts — turn forged content bodies into wired zone defs.
//
// A forge run (or a grow step) writes mob/item/quest bodies + zone_enhancements,
// but a zone is only *alive* once those bodies are wired into its ZoneDef: mobs
// placed as leveled spawns, quest givers synthesized + placed so quests are
// offerable, enhancement features merged (biome-filtered), and graph adjacency
// turned into edge connections. This module owns that wiring so both the run
// stager (forge/stage.ts) and the iterative grower (forge/grow/grow.ts) share
// one source of truth — previously grow.ts staged bare, lifeless zones.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { featureAllowedInBiome } from './engine.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const WORLD = join(REPO_ROOT, 'world');

// Default spawn shape for a wired mob (no region → scattered across the zone).
export const SPAWN_COUNT = 3;
export const RESPAWN_SECONDS = 90;
// Quest-giver NPCs are persistent fixtures, not respawning threats.
export const GIVER_RESPAWN_SECONDS = 86400;

export interface Spawn { entity: string; count: number; respawn_seconds: number; level?: number }

// Zone ids encode grid position (zone_X_Y), so a neighbour's direction is the
// delta between coords. Negative-aware (grow grows north into negative Y).
export function coordsOf(id: string): [number, number] | null {
  const m = id.match(/_(-?\d+)_(-?\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Edge connections for a zone, derived from its graph links. The engine walks
 *  a player off an edge into connections[dir] (and auto-paints a portal tile),
 *  so without these every staged zone is an island. */
export function connectionsFor(zoneId: string, links: string[]): Record<string, string> {
  const self = coordsOf(zoneId);
  if (!self) return {};
  const [x, y] = self;
  const out: Record<string, string> = {};
  for (const link of links) {
    const c = coordsOf(link);
    if (!c) continue;
    const dx = c[0] - x, dy = c[1] - y;
    if (dx === 0 && dy === -1) out.north = link;
    else if (dx === 0 && dy === 1) out.south = link;
    else if (dx === -1 && dy === 0) out.west = link;
    else if (dx === 1 && dy === 0) out.east = link;
  }
  return out;
}

export const titleize = (id: string): string =>
  id.replace(/^npc_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || id;

// --- Sprite + level reconciliation -----------------------------------------
// The client renders a mob as a colored square keyed by the tileset's sprite
// map (world/tilesets/overworld.json → sprites[id].color), falling back to
// white for any unknown id. The cascade invents sprite ids the atlas doesn't
// know (glass_hollowed, sprite_reaver_scout, npc_quest_giver), so every
// generated mob renders white. We remap each to a real atlas sprite by role.

/** Real sprite ids the engine can color — the closed vocabulary, from the tileset. */
export function validSprites(): Set<string> {
  try {
    const ts = JSON.parse(readFileSync(join(WORLD, 'tilesets', 'overworld.json'), 'utf8')) as { sprites?: Record<string, unknown> };
    return new Set(Object.keys(ts.sprites ?? {}));
  } catch { return new Set(); }
}

// Per-role palettes drawn from existing atlas creatures, so a remap stays
// role-plausible and varied (different ids → different colors → a varied map).
const ROLE_SPRITES: Record<string, string[]> = {
  pest:       ['rat_01', 'giant_rat_01', 'slime_01', 'swamp_slime_01', 'squirrel_01'],
  skirmisher: ['goblin_01', 'bandit_01', 'march_scout_01', 'wolf_01'],
  soldier:    ['hobgoblin_01', 'guard_01', 'goblin_shaman_01', 'warden_01'],
  brute:      ['hobgoblin_warlord_01', 'warden_captain_01'],
  tank:       ['warden_captain_01', 'guard_captain_01'],
  npc:        ['merchant_01', 'barkeep_01', 'patron_01', 'prisoner_01'],
  passive:    ['deer_01', 'squirrel_01'],
};
const FALLBACK_SPRITE = 'goblin_01';

/** Stable index from an id so the same mob always remaps to the same sprite. */
function hashIndex(id: string, n: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return n ? Math.abs(h) % n : 0;
}

export function spriteForRole(role: string, id: string): string {
  const pool = ROLE_SPRITES[role] ?? ROLE_SPRITES.skirmisher;
  return pool[hashIndex(id, pool.length)] ?? FALLBACK_SPRITE;
}

export interface MobMeta { level: number; role: string }

/**
 * Remap each mob's sprite to a real atlas sprite when the cascade invented one,
 * rewriting the file in place. Returns mob metadata (authored level + role)
 * keyed by id, so the zone pass can level each spawn to its zone (mob levels are
 * set per-spawn, not baked into the shared template — one template can appear at
 * L5 in a starter zone and L45 in a heartland zone).
 */
export function reconcileMobs(mobsDir: string, valid = validSprites()): { sprites: number; meta: Map<string, MobMeta> } {
  const meta = new Map<string, MobMeta>();
  let sprites = 0;
  if (!existsSync(mobsDir)) return { sprites, meta };
  for (const f of readdirSync(mobsDir)) {
    if (!f.endsWith('.yaml')) continue;
    const path = join(mobsDir, f);
    const m = yaml.load(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!m?.id) continue;

    const role = String(m.role ?? 'skirmisher');
    if (typeof m.sprite !== 'string' || !valid.has(m.sprite)) {
      m.sprite = spriteForRole(role, String(m.id));
      sprites++;
      writeFileSync(path, yaml.dump(m, { lineWidth: -1, noRefs: true }), 'utf8');
    }
    meta.set(String(m.id), { level: typeof m.level === 'number' ? m.level : 1, role });
  }
  return { sprites, meta };
}

/** Level a spawn to its zone: clamp the mob's authored level into the band.
 *  NPC/passive levels are cosmetic, so they keep the template level. Returns
 *  undefined when no override is needed (combat mob already in-band). */
export function spawnLevelFor(mobId: string, meta: Map<string, MobMeta>, band: { minLevel: number; maxLevel: number }): number | undefined {
  const m = meta.get(mobId);
  if (!m || m.role === 'npc' || m.role === 'passive') return undefined;
  const clamped = Math.min(band.maxLevel, Math.max(band.minLevel, m.level));
  return clamped === m.level ? undefined : clamped;
}

/**
 * Quest givers from a content dir's quests/*.yaml. A quest is only offerable if
 * a mob whose template_id equals its `giver` is spawned in range, but neither a
 * run nor a grow step produces those NPCs — so we synthesize a minimal talkable
 * `npc` template per giver and place one in the quest's zone. Returns the
 * templates to write and a per-zone set of giver ids to spawn. Givers whose zone
 * isn't in the graph are skipped (warned) — there is no zone to place them in.
 */
export function questGivers(contentDir: string, graphZoneIds: Set<string>): {
  templates: Map<string, Record<string, unknown>>;
  byZone: Map<string, Set<string>>;
} {
  const templates = new Map<string, Record<string, unknown>>();
  const byZone = new Map<string, Set<string>>();
  const dir = join(contentDir, 'quests');
  if (!existsSync(dir)) return { templates, byZone };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.yaml')) continue;
    const q = yaml.load(readFileSync(join(dir, f), 'utf8')) as { giver?: string; zone?: string };
    const giver = q?.giver, zone = q?.zone;
    if (!giver || !zone) continue;
    if (!graphZoneIds.has(zone)) { console.warn(`[wire] quest giver '${giver}' targets non-graph zone '${zone}' — not placed`); continue; }
    if (!templates.has(giver)) {
      templates.set(giver, {
        id: giver, name: titleize(giver), sprite: spriteForRole('npc', giver),
        level: 1, role: 'npc', speed: 0, behavior: 'idle', aggro_range: 0,
        dialogue: ['There is work to be done, if you are willing.'],
      });
    }
    (byZone.get(zone) ?? byZone.set(zone, new Set()).get(zone)!).add(giver);
  }
  return { templates, byZone };
}

/** Write synthesized giver templates into mobsDir, skipping ids a mob already owns. */
export function writeGiverTemplates(mobsDir: string, templates: Map<string, Record<string, unknown>>): number {
  let written = 0;
  for (const [id, tmpl] of templates) {
    const dst = join(mobsDir, `${id}.yaml`);
    if (existsSync(dst)) continue; // a generated mob already uses this id
    writeFileSync(dst, yaml.dump(tmpl, { lineWidth: -1, noRefs: true }), 'utf8');
    written++;
  }
  return written;
}

/** zone → add_features, from a content dir's zone_enhancements/*.yaml (atmosphere dropped). */
export function zoneFeatures(contentDir: string): Map<string, unknown[]> {
  const byZone = new Map<string, unknown[]>();
  const dir = join(contentDir, 'zone_enhancements');
  if (!existsSync(dir)) return byZone;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.yaml')) continue;
    const doc = yaml.load(readFileSync(join(dir, f), 'utf8')) as { zone?: string; add_features?: unknown[] };
    if (doc?.zone && doc.add_features?.length) byZone.set(doc.zone, doc.add_features);
  }
  return byZone;
}

// --- Per-zone wiring --------------------------------------------------------

export interface ZoneToWire {
  id: string;
  biome: string;
  seed: string;
  level_band: { tier: number; minLevel: number; maxLevel: number };
  links: string[];
  features: unknown[]; // graph terrain features (rivers/crossings), underlie decoration
}

export interface WireCtx {
  mobMeta: Map<string, MobMeta>;
  /** zoneId → combat mob ids placed there. */
  placements: Map<string, string[]>;
  /** zoneId → quest-giver ids to spawn. */
  giverByZone: Map<string, Set<string>>;
  /** zoneId → enhancement add_features (biome-filtered here). */
  featuresByZone: Map<string, unknown[]>;
  /** zoneId → caller-provided spawns (e.g. start-village life). */
  extraSpawns?: Map<string, Spawn[]>;
}

export interface ZoneWireStats { leveled: number; dropped: number; hasSpawns: boolean }

/** Assemble a wired ZoneDef: leveled combat spawns + giver spawns + extras,
 *  biome-filtered enhancement features over graph terrain, and edge connections. */
export function buildWiredZoneDef(zone: ZoneToWire, ctx: WireCtx): { def: Record<string, unknown>; stats: ZoneWireStats } {
  let leveled = 0, dropped = 0;

  // Level each combat spawn into this zone's band: one shared template can appear
  // at different levels in different zones.
  const wired: Spawn[] = (ctx.placements.get(zone.id) ?? []).map((entity) => {
    const level = spawnLevelFor(entity, ctx.mobMeta, zone.level_band);
    if (level !== undefined) leveled++;
    return { entity, count: SPAWN_COUNT, respawn_seconds: RESPAWN_SECONDS, ...(level !== undefined ? { level } : {}) };
  });
  const spawns: Spawn[] = [
    ...wired,
    ...[...(ctx.giverByZone.get(zone.id) ?? [])].map((entity) => ({ entity, count: 1, respawn_seconds: GIVER_RESPAWN_SECONDS })),
    ...(ctx.extraSpawns?.get(zone.id) ?? []),
  ];

  // Graph terrain first so it underlies decoration. Content features are
  // hard-filtered to this zone's biome so a mis-selected feature (city_walls in
  // a forest) never ships.
  const enhancements = (ctx.featuresByZone.get(zone.id) ?? []).filter((f) => {
    const fid = typeof f === 'string' ? f : (f && typeof f === 'object' && 'id' in f ? String((f as { id: unknown }).id) : undefined);
    if (!fid || featureAllowedInBiome(fid, zone.biome)) return true;
    console.warn(`[wire] dropping feature '${fid}' — not valid for biome '${zone.biome}' in ${zone.id}`);
    dropped++;
    return false;
  });
  const features = [...zone.features, ...enhancements];
  const connections = connectionsFor(zone.id, zone.links);

  const def = {
    id: zone.id,
    biome: zone.biome,
    seed: zone.seed,
    level_band: zone.level_band,
    ...(Object.keys(connections).length ? { connections } : {}),
    ...(features.length ? { features } : {}),
    ...(spawns.length ? { spawns } : {}),
  };
  return { def, stats: { leveled, dropped, hasSpawns: spawns.length > 0 } };
}
