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

import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadSeed } from './lib/seeds.ts';
import { readEvents, RUNS_DIR, isRunId } from './lib/persist.ts';
import {
  reconcileMobs, questGivers, writeGiverTemplates, zoneFeatures, buildWiredZoneDef,
  spriteForRole, type Spawn,
  RESPAWN_SECONDS, GIVER_RESPAWN_SECONDS,
} from './lib/wire-zones.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WORLD = join(REPO_ROOT, 'world');

// Shared engine assets symlinked from world/ so the run's references resolve.
const SHARED_LINKS = [
  'abilities', 'tilesets', 'prefabs', 'biome-params.json',
  'entities/items/materials.yaml', 'entities/items/archetypes.yaml', 'entities/items/affixes',
];
// Run-generated content copied into the engine layout.
const RUN_CONTENT = ['entities/mobs', 'entities/items/bases', 'quests'];

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
  const giverTemplates = writeGiverTemplates(mobsOut, givers.templates);

  // 2c. reconcile copied mobs: remap invented sprites to the atlas, and collect
  // each mob's authored level/role so spawns can be leveled per zone below.
  const fixed = reconcileMobs(mobsOut);

  // 2d. guarantee the start village has life. The player spawns in the lowest-
  // tier village zone (see startingZone() in server/index.ts); a generated run
  // sometimes leaves it empty, so seed a greeter NPC + ambient critters there.
  const startVillage = seed.graph.zones
    .filter((z) => z.biome === 'village')
    .sort((a, b) => a.level_band.tier - b.level_band.tier || a.level_band.maxLevel - b.level_band.maxLevel)[0];
  const extraSpawns = new Map<string, Spawn[]>();
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

  // 3. synthesize zones from the graph (+ enhancement features + wired spawns).
  // Zones are emitted as JSON to match the incumbent format (world/zones is all
  // JSON, as is the world-gen export). Content bodies stay YAML — that's what the
  // cascade authors and what the loader reads for mobs/quests/items.
  const zonesOut = join(out, 'zones');
  mkdirSync(zonesOut, { recursive: true });
  const wireCtx = {
    mobMeta: fixed.meta,
    placements: spawnsByZone,
    giverByZone: givers.byZone,
    featuresByZone,
    extraSpawns,
  };
  let withSpawns = 0, leveled = 0, droppedFeatures = 0;
  for (const z of seed.graph.zones) {
    const { def, stats } = buildWiredZoneDef(z, wireCtx);
    if (stats.hasSpawns) withSpawns++;
    leveled += stats.leveled;
    droppedFeatures += stats.dropped;
    writeFileSync(join(zonesOut, `${z.id}.json`), JSON.stringify(def, null, 2), 'utf8');
  }

  console.log(`[stage] ${runId} → ${out}`);
  console.log(`[stage]   zones: ${seed.graph.zones.length} synthesized (${withSpawns} with wired spawns, linked by graph adjacency)`);
  console.log(`[stage]   content: ${copied} files copied, ${giverTemplates} quest-giver NPCs synthesized, ${linked} shared assets linked`);
  console.log(`[stage]   reconciled: ${fixed.sprites} mob sprites remapped to atlas, ${leveled} spawns leveled to their zone band, ${droppedFeatures} biome-mismatched features dropped`);
  if (startVillage) console.log(`[stage]   start village: ${startVillage.id}${villageTemplates ? ` (seeded ${villageTemplates} life templates — was empty)` : ' (already had life)'}`);
  console.log(`[stage] boot it:  WORLD_DIR=${out.replace(REPO_ROOT + '/', '')} npm start`);
}

const runId = process.argv[2];
if (!runId) {
  console.error('usage: npm run forge:stage -- <run_id>');
  process.exit(1);
}
stage(runId);
