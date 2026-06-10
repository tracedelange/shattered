// Verifies the Implementor-v2 engine foundation: named prefab lookup, semantic
// placement descriptors, the portal post-op, and World-level portal synthesis.
//
//   npx tsx tools/test-postops.ts

import { join } from 'node:path';
import { generateZoneGrid } from '../server/game/mapgen/index.ts';
import { loadWorld } from '../server/world/loader.ts';
import { World } from '../server/game/world.ts';
import type { ZoneDef } from '../shared/types.ts';

const ROOT = join(import.meta.dirname, '..');
const world = loadWorld(join(ROOT, 'world'));
const blocking = world.blockingTiles;

let failures = 0;
const check = (label: string, pass: boolean): void => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failures++;
};

// A small village-like surface zone: open grass interior bordered by a wall, with
// a building region the entrance should land near.
const surface: ZoneDef = {
  id: 'village_test',
  default_tile: 'grass',
  width: 20,
  height: 16,
  ops: [
    // A 1-tile wall border so near_tile margin keeps placement off the edge.
    { type: 'region', id: 'wall_border', shape: { kind: 'rect', w: 20, h: 16 }, at: { x: 0, y: 0 }, walls: { tile: 'wall' } },
    { type: 'region', id: 'building_0', shape: { kind: 'rect', w: 4, h: 4 }, at: { x: 4, y: 4 }, floor: 'wood_floor', walls: { tile: 'wall' } },
  ],
  post_ops: [
    { type: 'stamp', at: { near_tile: 'grass', near_region: 'building', margin: 1 }, prefab: 'sewer_entrance' },
    { type: 'portal', at: { anchor_of: 'sewer_entrance', anchor: 'descend' }, target_zone: 'sewer_test', transition: 'descend' },
  ],
  connections: {},
};

console.log('\nprefab registry');
check('sewer_entrance loaded from world/prefabs/', !!world.prefabs['sewer_entrance']);

console.log('\nsemantic placement + portal post-op');
const g = generateZoneGrid(surface, blocking, world.prefabs);

// Count stone_floor tiles — the prefab footprint (8 stone + 1 portal center).
let stone = 0, portal = 0;
for (const row of g.grid) for (const t of row) { if (t === 'stone_floor') stone++; if (t === 'portal') portal++; }
check(`prefab stamped (8 stone_floor tiles, got ${stone})`, stone === 8);
check(`portal tile painted at descend anchor (1 portal, got ${portal})`, portal === 1);
check(`postOpPortals records target zone`, g.postOpPortals.length === 1 && g.postOpPortals[0]!.toZone === 'sewer_test');
check(`portal carries transition`, g.postOpPortals[0]!.transition === 'descend');

// Determinism.
const g2 = generateZoneGrid(surface, blocking, world.prefabs);
check('deterministic (identical grid on re-run)', JSON.stringify(g.grid) === JSON.stringify(g2.grid));

// Footprint-aware placement: a stamp targeting a region that already holds an
// occupied (claimed) feature must place AROUND it, never overwrite it. This is
// the well-on-fountain collision regression.
console.log('\nfootprint-aware placement (no overwrite of existing features)');
const plaza: ZoneDef = {
  id: 'plaza_test',
  default_tile: 'grass',
  width: 24,
  height: 18,
  ops: [
    { type: 'region', id: 'market', shape: { kind: 'rect', w: 10, h: 10 }, at: { x: 6, y: 4 }, floor: 'stone_floor' },
    // A fountain at the market centre: 3x3 water, claimed BUILDING (place default).
    { type: 'stamp', at: { region: 'market', anchor: 'center' }, claim: 'building',
      prefab: { data: 'WWW\nWWW\nWWW', legend: { W: 'water' } } },
  ],
  post_ops: [
    // Drop a 3x3 well into the market — must avoid the fountain's claimed tiles.
    { type: 'stamp', at: { center_of_region: 'market' },
      prefab: { data: 'ccc\nc.c\nccc', legend: { c: 'cracked_stone_floor', '.': 'wood_floor' } } },
  ],
  connections: {},
};
const gp = generateZoneGrid(plaza, blocking);
let water = 0, wellCenters = 0;
for (const row of gp.grid) for (const t of row) { if (t === 'water') water++; if (t === 'wood_floor') wellCenters++; }
// If the well had overwritten the fountain, some of the 9 water tiles would be gone.
check(`fountain preserved (9 water tiles intact, got ${water})`, water === 9);
check('well was placed (its wood_floor centre exists)', wellCenters === 1);
check('well placed inside the market region', (() => {
  const m = gp.bounds['market'];
  if (!m) return false;
  for (let y = 0; y < gp.height; y++) for (let x = 0; x < gp.width; x++) {
    if (gp.grid[y]![x] === 'wood_floor') return x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h;
  }
  return false;
})());

console.log('\nWorld portal synthesis (outbound + auto return)');
const sewer: ZoneDef = {
  id: 'sewer_test',
  default_tile: 'wall',
  width: 16,
  height: 12,
  ops: [
    { type: 'cave', floor: 'stone_floor', wall: 'wall', seed: 'sewer_test', region: 'main' },
  ],
  spawn_point: { region: 'main_anchor' },
  connections: { surface: 'village_test' },
};

const w = new World();
w.setDefinitions({
  ...world,
  zones: { village_test: surface, sewer_test: sewer },
});

const surfacePortals = w.zones['village_test']!.def.portals ?? [];
const sewerPortals = w.zones['sewer_test']!.def.portals ?? [];
const outbound = surfacePortals.find(p => p.to?.zone === 'sewer_test');
const inbound = sewerPortals.find(p => p.to?.zone === 'village_test');
check('outbound portal wired to sewer spawn point', !!outbound && outbound.to.x >= 0);
check('return portal auto-synthesized in sewer', !!inbound && inbound.transition === 'ascend');

console.log(failures === 0 ? '\nAll post-op checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
