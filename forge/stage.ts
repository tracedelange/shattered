// forge/stage.ts — turn a FORGE run into a loadable engine world root.
//
// A run stages mob/item/quest BODIES + zone_enhancements, but not the things the
// engine actually boots from: the zone files, the spawn wiring that makes mobs
// appear, or the shared engine assets (abilities/tilesets/prefabs/item parts).
// This assembles a self-contained root at forge/runs/<id>/world/ so the server
// can boot the run in isolation:
//
//   npm run forge:stage -- run_1234
//   WORLD_DIR=forge/runs/run_1234/world npm start
//
// It (1) synthesizes a ZoneDef per zone-graph node — a biome+seed zone is enough
// for the loader to derive its grid — merging that zone's enhancement features
// and wiring the run's mobs (placed by task.zone, read from events.jsonl) as
// spawns; (2) copies the run's mob/item/quest bodies into the engine layout;
// (3) symlinks the shared engine assets from world/ so references resolve.
//
// Known MVP limits: zone_enhancement `atmosphere` is dropped (not an engine
// ZoneDef field yet), and a generated quest's giver may not be placed, so some
// quests load but aren't offerable until a giver exists. Both are fine for
// "walk the world and see the generated zones + threats".

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadSeed } from './lib/seeds.ts';
import { readEvents, RUNS_DIR, isRunId } from './lib/persist.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WORLD = join(REPO_ROOT, 'world');

// Default spawn shape for a wired mob (no region → scattered across the zone).
const SPAWN_COUNT = 3;
const RESPAWN_SECONDS = 90;
// Quest-giver NPCs are persistent fixtures, not respawning threats.
const GIVER_RESPAWN_SECONDS = 86400;

// Shared engine assets symlinked from world/ so the run's references resolve.
const SHARED_LINKS = [
  'abilities', 'tilesets', 'prefabs', 'biome-params.json',
  'entities/items/materials.yaml', 'entities/items/archetypes.yaml', 'entities/items/affixes',
];
// Run-generated content copied into the engine layout.
const RUN_CONTENT = ['entities/mobs', 'entities/items/bases', 'quests'];

// Zone ids encode grid position (zone_X_Y / village_X_Y / city_X_Y), so a
// neighbour's direction is the delta between coords. Mirrors the world-gen
// export's DIRS convention (north = y-1).
function coordsOf(id: string): [number, number] | null {
  const m = id.match(/_(\d+)_(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Edge connections for a zone, derived from its graph links. The engine walks
 *  a player off an edge into connections[dir] (and auto-paints a portal tile),
 *  so without these every staged zone is an island. */
function connectionsFor(zoneId: string, links: string[]): Record<string, string> {
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

function copyDir(src: string, dst: string): number {
  if (!existsSync(src)) return 0;
  mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const name of readdirSync(src)) {
    const s = join(src, name), d = join(dst, name);
    if (statSync(s).isDirectory()) n += copyDir(s, d);
    else { copyFileSync(s, d); n++; }
  }
  return n;
}

/** mobId → zone, from the valid tier-3 mob artifacts recorded in events.jsonl. */
function mobPlacements(runId: string): Map<string, string[]> {
  const byZone = new Map<string, string[]>();
  for (const e of readEvents(runId) as any[]) {
    if (e.type !== 'node_done' || e.tier !== 3) continue;
    const d = e.detail;
    if (!d?.validation?.ok || d.output?.artifact_type !== 'mob') continue;
    const zone = d.input?.task?.zone as string | undefined;
    const mobId = d.output?.content?.id as string | undefined;
    if (!zone || !mobId) continue;
    const list = byZone.get(zone) ?? [];
    list.push(mobId);
    byZone.set(zone, list);
  }
  return byZone;
}

const titleize = (id: string): string =>
  id.replace(/^npc_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || id;

// --- Sprite + level reconciliation -----------------------------------------
// The client renders a mob as a colored square keyed by the tileset's sprite
// map (world/tilesets/overworld.json → sprites[id].color), falling back to
// white for any unknown id. The cascade invents sprite ids the atlas doesn't
// know (glass_hollowed, sprite_reaver_scout, npc_quest_giver), so every
// generated mob renders white. We remap each to a real atlas sprite by role.

/** Real sprite ids the engine can color — the closed vocabulary, from the tileset. */
function validSprites(): Set<string> {
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

function spriteForRole(role: string, id: string): string {
  const pool = ROLE_SPRITES[role] ?? ROLE_SPRITES.skirmisher;
  return pool[hashIndex(id, pool.length)] ?? FALLBACK_SPRITE;
}

/** Most-restrictive band (lowest maxLevel) among the zones a mob spawns in. */
function bandFor(mobId: string, spawnsByZone: Map<string, string[]>, bandByZone: Map<string, { minLevel: number; maxLevel: number }>): { minLevel: number; maxLevel: number } | undefined {
  let band: { minLevel: number; maxLevel: number } | undefined;
  for (const [zone, ids] of spawnsByZone) {
    if (!ids.includes(mobId)) continue;
    const b = bandByZone.get(zone);
    if (b && (!band || b.maxLevel < band.maxLevel)) band = b;
  }
  return band;
}

/**
 * Rewrite each copied mob template in place so it satisfies engine invariants:
 *  - sprite: remapped to a real atlas sprite when the cascade invented one
 *  - level: combat roles clamped into the band of the zone(s) they spawn in
 *           (so a level-45 mob can't end up roaming a level 1–5 zone)
 * NPC/passive levels are cosmetic, so only their sprite is touched.
 */
function reconcileMobs(mobsDir: string, spawnsByZone: Map<string, string[]>, bandByZone: Map<string, { minLevel: number; maxLevel: number }>): { sprites: number; levels: number } {
  const valid = validSprites();
  let sprites = 0, levels = 0;
  if (!existsSync(mobsDir)) return { sprites, levels };
  for (const f of readdirSync(mobsDir)) {
    if (!f.endsWith('.yaml')) continue;
    const path = join(mobsDir, f);
    const m = yaml.load(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!m?.id) continue;
    let changed = false;

    const role = String(m.role ?? 'skirmisher');
    if (typeof m.sprite !== 'string' || !valid.has(m.sprite)) {
      m.sprite = spriteForRole(role, String(m.id));
      sprites++; changed = true;
    }

    if (role !== 'npc' && role !== 'passive' && typeof m.level === 'number') {
      const band = bandFor(String(m.id), spawnsByZone, bandByZone);
      if (band) {
        const clamped = Math.min(band.maxLevel, Math.max(band.minLevel, m.level as number));
        if (clamped !== m.level) { m.level = clamped; levels++; changed = true; }
      }
    }

    if (changed) writeFileSync(path, yaml.dump(m, { lineWidth: -1, noRefs: true }), 'utf8');
  }
  return { sprites, levels };
}

/**
 * Quest givers from the run's quests/*.yaml. A quest is only offerable if a mob
 * whose template_id equals its `giver` is spawned in range, but the run never
 * produces those NPCs — so we synthesize a minimal talkable `npc` template per
 * giver and place one in the quest's zone. Returns the templates to write and a
 * per-zone set of giver ids to spawn. Givers whose zone isn't in the graph are
 * skipped (warned) — there is no synthesized zone to place them in.
 */
function questGivers(runDir: string, graphZoneIds: Set<string>): {
  templates: Map<string, Record<string, unknown>>;
  byZone: Map<string, Set<string>>;
} {
  const templates = new Map<string, Record<string, unknown>>();
  const byZone = new Map<string, Set<string>>();
  const dir = join(runDir, 'quests');
  if (!existsSync(dir)) return { templates, byZone };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.yaml')) continue;
    const q = yaml.load(readFileSync(join(dir, f), 'utf8')) as { giver?: string; zone?: string };
    const giver = q?.giver, zone = q?.zone;
    if (!giver || !zone) continue;
    if (!graphZoneIds.has(zone)) { console.warn(`[stage] quest giver '${giver}' targets non-graph zone '${zone}' — not placed`); continue; }
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

/** zone → add_features, from the run's zone_enhancements/*.yaml (atmosphere dropped). */
function zoneFeatures(runDir: string): Map<string, unknown[]> {
  const byZone = new Map<string, unknown[]>();
  const dir = join(runDir, 'zone_enhancements');
  if (!existsSync(dir)) return byZone;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.yaml')) continue;
    const doc = yaml.load(readFileSync(join(dir, f), 'utf8')) as { zone?: string; add_features?: unknown[] };
    if (doc?.zone && doc.add_features?.length) byZone.set(doc.zone, doc.add_features);
  }
  return byZone;
}

function stage(runId: string): void {
  if (!isRunId(runId)) throw new Error(`not a run id: "${runId}" (expected run_<digits>)`);
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) throw new Error(`run not found: ${runDir}`);

  const seed = loadSeed();
  const graphZoneIds = new Set(seed.graph.zones.map((z) => z.id));
  const spawnsByZone = mobPlacements(runId);
  const featuresByZone = zoneFeatures(runDir);
  const givers = questGivers(runDir, graphZoneIds);

  const out = join(runDir, 'world');
  rmSync(out, { recursive: true, force: true }); // idempotent re-stage
  mkdirSync(out, { recursive: true });

  // 1. shared engine assets (symlink to world/)
  let linked = 0;
  for (const rel of SHARED_LINKS) {
    const src = join(WORLD, rel);
    if (!existsSync(src)) { console.warn(`[stage] shared asset missing, skipping: world/${rel}`); continue; }
    const dst = join(out, rel);
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst);
    linked++;
  }

  // 2. run-generated content (copy)
  let copied = 0;
  for (const rel of RUN_CONTENT) copied += copyDir(join(runDir, rel), join(out, rel));

  // 2b. synthesize quest-giver NPC templates (skip any id a run mob already owns)
  const mobsOut = join(out, 'entities', 'mobs');
  mkdirSync(mobsOut, { recursive: true });
  let giverTemplates = 0;
  for (const [id, tmpl] of givers.templates) {
    const dst = join(mobsOut, `${id}.yaml`);
    if (existsSync(dst)) continue; // a generated mob already uses this id
    writeFileSync(dst, yaml.dump(tmpl, { lineWidth: -1, noRefs: true }), 'utf8');
    giverTemplates++;
  }

  // 2c. reconcile copied mobs against engine invariants (real sprites, in-band
  // levels) — see reconcileMobs. Needs the per-zone level bands from the graph.
  const bandByZone = new Map(seed.graph.zones.map((z) => [z.id, z.level_band]));
  const fixed = reconcileMobs(mobsOut, spawnsByZone, bandByZone);

  // 2d. guarantee the start village has life. The player spawns in the lowest-
  // tier village zone (see startingZone() in server/index.ts); a generated run
  // sometimes leaves it empty, so seed a greeter NPC + ambient critters there.
  const startVillage = seed.graph.zones
    .filter((z) => z.biome === 'village')
    .sort((a, b) => a.level_band.tier - b.level_band.tier || a.level_band.maxLevel - b.level_band.maxLevel)[0];
  const extraSpawns = new Map<string, Array<{ entity: string; count: number; respawn_seconds: number }>>();
  let villageTemplates = 0;
  if (startVillage) {
    const hasLife = (spawnsByZone.get(startVillage.id)?.length ?? 0) + (givers.byZone.get(startVillage.id)?.size ?? 0);
    if (!hasLife) {
      const lvl = Math.max(1, startVillage.level_band.minLevel);
      const greeter = { id: `npc_${startVillage.id}_greeter`, name: 'Village Elder', sprite: spriteForRole('npc', startVillage.id),
        level: 1, role: 'npc', speed: 0, behavior: 'idle', aggro_range: 0, dialogue: ['Welcome, traveler. Rest here before the road ahead.'] };
      const critter = { id: `critter_${startVillage.id}`, name: 'Village Critter', sprite: spriteForRole('passive', startVillage.id),
        level: lvl, role: 'passive', speed: 0.7, behavior: 'wander', aggro_range: 0 };
      for (const t of [greeter, critter]) {
        const dst = join(mobsOut, `${t.id}.yaml`);
        if (!existsSync(dst)) { writeFileSync(dst, yaml.dump(t, { lineWidth: -1, noRefs: true }), 'utf8'); villageTemplates++; }
      }
      extraSpawns.set(startVillage.id, [
        { entity: greeter.id, count: 1, respawn_seconds: GIVER_RESPAWN_SECONDS },
        { entity: critter.id, count: 4, respawn_seconds: RESPAWN_SECONDS },
      ]);
    }
  }

  // 3. synthesize zones from the graph (+ enhancement features + wired spawns)
  const zonesOut = join(out, 'zones');
  mkdirSync(zonesOut, { recursive: true });
  let withSpawns = 0;
  for (const z of seed.graph.zones) {
    const spawns = [
      ...(spawnsByZone.get(z.id) ?? []).map((entity) => ({ entity, count: SPAWN_COUNT, respawn_seconds: RESPAWN_SECONDS })),
      ...[...(givers.byZone.get(z.id) ?? [])].map((entity) => ({ entity, count: 1, respawn_seconds: GIVER_RESPAWN_SECONDS })),
      ...(extraSpawns.get(z.id) ?? []),
    ];
    if (spawns.length) withSpawns++;
    // Terrain features from the graph (rivers/crossings) + content features from
    // the run's zone_enhancements. Graph terrain first so it underlies decoration.
    const features = [...z.features, ...(featuresByZone.get(z.id) ?? [])];
    const connections = connectionsFor(z.id, z.links);
    const zoneDef = {
      id: z.id,
      biome: z.biome,
      seed: z.seed,
      level_band: z.level_band,
      ...(Object.keys(connections).length ? { connections } : {}),
      ...(features.length ? { features } : {}),
      ...(spawns.length ? { spawns } : {}),
    };
    // Zones are emitted as JSON to match the incumbent format (world/zones is
    // all JSON, as is the world-gen export). Content bodies stay YAML — that's
    // what the cascade authors and what the loader reads for mobs/quests/items.
    writeFileSync(join(zonesOut, `${z.id}.json`), JSON.stringify(zoneDef, null, 2), 'utf8');
  }

  console.log(`[stage] ${runId} → ${out}`);
  console.log(`[stage]   zones: ${seed.graph.zones.length} synthesized (${withSpawns} with wired spawns, linked by graph adjacency)`);
  console.log(`[stage]   content: ${copied} files copied, ${giverTemplates} quest-giver NPCs synthesized, ${linked} shared assets linked`);
  console.log(`[stage]   reconciled: ${fixed.sprites} mob sprites remapped to atlas, ${fixed.levels} levels clamped into zone band`);
  if (startVillage) console.log(`[stage]   start village: ${startVillage.id}${villageTemplates ? ` (seeded ${villageTemplates} life templates — was empty)` : ' (already had life)'}`);
  console.log(`[stage] boot it:  WORLD_DIR=${out.replace(REPO_ROOT + '/', '')} npm start`);
}

const runId = process.argv[2];
if (!runId) {
  console.error('usage: npm run forge:stage -- <run_id>');
  process.exit(1);
}
stage(runId);
