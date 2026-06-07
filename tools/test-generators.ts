// Generator regression harness. Loads the YAML fixtures in generator-fixtures/,
// runs each through the mapgen engine, and asserts structural invariants
// (determinism + connectivity guarantees). Renders each to world/renders/
// (gitignored) for visual inspection.
//
//   npx tsx tools/test-generators.ts          # assert + render
//   npx tsx tools/test-generators.ts --no-png # assert only
//
// The fixtures live OUTSIDE world/zones so they never enter the live world
// graph; they are plain ZoneDef YAML, the same format real zones use.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadWorld } from '../server/world/loader.ts';
import { generateZoneGrid } from '../server/game/mapgen/index.ts';
import { renderZoneToFile } from '../pipeline/lib/renderZone.ts';
import type { ZoneDef } from '../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURE_DIR = join(__dirname, 'generator-fixtures');
const RENDER_DIR = join(ROOT, 'world', 'renders');

const world = loadWorld(join(ROOT, 'world'));
const blocking = world.blockingTiles;

// ── reachability helpers (independent of the engine's, so the test is a check) ──
type Grid = string[][];
function flood(grid: Grid, seed: { x: number; y: number }): Set<number> {
  const H = grid.length, W = grid[0]!.length;
  const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && !blocking.has(grid[y]![x]!);
  const reach = new Set<number>();
  let sx = seed.x, sy = seed.y;
  if (!walk(sx, sy)) {
    const nb = [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => [sx + dx!, sy + dy!]).find(([x, y]) => walk(x!, y!));
    if (!nb) return reach;
    [sx, sy] = nb as [number, number];
  }
  const q = [sy * W + sx]; reach.add(q[0]!);
  let i = 0;
  while (i < q.length) {
    const c = q[i++]!, cx = c % W, cy = (c / W) | 0;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const x = cx + dx, y = cy + dy;
      if (walk(x, y) && !reach.has(y * W + x)) { reach.add(y * W + x); q.push(y * W + x); }
    }
  }
  return reach;
}
function walkableCount(grid: Grid): number {
  let n = 0;
  for (const row of grid) for (const t of row) if (!blocking.has(t)) n++;
  return n;
}

// ── per-fixture invariant checks: (zoneGrid) => array of [label, pass] ──
type Check = (g: ReturnType<typeof generateZoneGrid>) => Array<[string, boolean]>;
const CHECKS: Record<string, Check> = {
  gen_cavern: (g) => {
    const seed = g.focal ?? { x: g.width >> 1, y: g.height >> 1 };
    const reached = flood(g.grid, seed).size;
    const total = walkableCount(g.grid);
    return [
      ['cave produced open floor', total > 200],
      [`fully connected (${reached}/${total} walkable reachable)`, reached === total],
    ];
  },
  gen_village: (g) => {
    const doors = g.blackboard.features.byTag('door');
    const well = g.bounds['well']!;
    const seed = { x: well.x + (well.w >> 1), y: well.y + (well.h >> 1) };
    const reach = flood(g.grid, seed);
    const W = g.width;
    const reachable = (p: { x: number; y: number }) =>
      [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => reach.has((p.y + dy!) * W + (p.x + dx!)));
    const connected = doors.filter((d) => d.at && reachable(d.at)).length;
    const plots = g.blackboard.features.byTag('plot').length;
    return [
      [`plots placed (${plots})`, plots >= 6],
      [`every plot stamped as a house (${doors.length}/${plots})`, doors.length === plots],
      [`all doors reachable from well (${connected}/${doors.length})`, doors.length > 0 && connected === doors.length],
    ];
  },
  gen_two_rooms: (g) => {
    const a = g.bounds['room_a']!;
    const seed = { x: a.x + (a.w >> 1), y: a.y + (a.h >> 1) };
    const reached = flood(g.grid, seed).size;
    const total = walkableCount(g.grid);
    return [
      ['both rooms exist', !!g.bounds['room_a'] && !!g.bounds['room_b']],
      [`ensure_reach joined the rooms (${reached}/${total} reachable)`, reached === total],
    ];
  },
};

const writePng = !process.argv.includes('--no-png');
let failures = 0;

for (const file of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.yaml')).sort()) {
  const def = yaml.load(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as ZoneDef;
  const g = generateZoneGrid(def, blocking);
  const checks: Array<[string, boolean]> = [];

  // Universal: determinism.
  const g2 = generateZoneGrid(def, blocking);
  checks.push(['deterministic (identical grid on re-run)', JSON.stringify(g.grid) === JSON.stringify(g2.grid)]);

  // Fixture-specific invariants.
  if (CHECKS[def.id]) checks.push(...CHECKS[def.id]!(g));

  console.log(`\n${def.id}  (${g.width}x${g.height})`);
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
    if (!pass) failures++;
  }

  if (writePng) {
    const tileset = world.tilesets[def.tileset ?? 'overworld'];
    if (tileset) {
      const out = join(RENDER_DIR, `${def.id}.png`);
      renderZoneToFile(def, tileset, out, { mobs: world.mobs, tileSize: 14 });
      console.log(`  → ${out.replace(ROOT + '/', '')}`);
    }
  }
}

console.log(failures === 0 ? '\nAll generator checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
