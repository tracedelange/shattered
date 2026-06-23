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
        id: giver, name: titleize(giver), sprite: 'npc_quest_giver',
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

  // 3. synthesize zones from the graph (+ enhancement features + wired spawns)
  const zonesOut = join(out, 'zones');
  mkdirSync(zonesOut, { recursive: true });
  let withSpawns = 0;
  for (const z of seed.graph.zones) {
    const spawns = [
      ...(spawnsByZone.get(z.id) ?? []).map((entity) => ({ entity, count: SPAWN_COUNT, respawn_seconds: RESPAWN_SECONDS })),
      ...[...(givers.byZone.get(z.id) ?? [])].map((entity) => ({ entity, count: 1, respawn_seconds: GIVER_RESPAWN_SECONDS })),
    ];
    if (spawns.length) withSpawns++;
    // Terrain features from the graph (rivers/crossings) + content features from
    // the run's zone_enhancements. Graph terrain first so it underlies decoration.
    const features = [...z.features, ...(featuresByZone.get(z.id) ?? [])];
    const zoneDef = {
      id: z.id,
      biome: z.biome,
      seed: z.seed,
      level_band: z.level_band,
      ...(features.length ? { features } : {}),
      ...(spawns.length ? { spawns } : {}),
    };
    writeFileSync(join(zonesOut, `${z.id}.yaml`), yaml.dump(zoneDef, { lineWidth: -1, noRefs: true }), 'utf8');
  }

  console.log(`[stage] ${runId} → ${out}`);
  console.log(`[stage]   zones: ${seed.graph.zones.length} synthesized (${withSpawns} with wired spawns)`);
  console.log(`[stage]   content: ${copied} files copied, ${giverTemplates} quest-giver NPCs synthesized, ${linked} shared assets linked`);
  console.log(`[stage] boot it:  WORLD_DIR=${out.replace(REPO_ROOT + '/', '')} npm start`);
}

const runId = process.argv[2];
if (!runId) {
  console.error('usage: npm run forge:stage -- <run_id>');
  process.exit(1);
}
stage(runId);
