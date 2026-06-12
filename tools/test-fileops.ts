// Verifies Implementor-v2 pipeline changes: the validated FileOp write layer
// (#6) and the ZoneContext builder (#7).
//
//   npx tsx tools/test-fileops.ts

import { join } from 'node:path';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import {
  applyFileOps, assertNoCoordinatesInPostOps, validatePrefabGrid,
} from '../pipeline/lib/fileOps.ts';
import { buildZoneContext } from '../pipeline/lib/context.ts';
import { validateZoneStub } from '../pipeline/lib/zoneStub.ts';

const ROOT = join(import.meta.dirname, '..');
const ZONE_ID = '__test_fileops_zone';
const ZONE_PATH = join(ROOT, 'world', 'zones', `${ZONE_ID}.json`);

let failures = 0;
const check = (label: string, pass: boolean): void => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failures++;
};
const throws = (label: string, fn: () => void): void => {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(label, threw);
};

// A minimal village-like zone written to disk for the FileOp / context tests.
const baseZone = {
  id: ZONE_ID,
  biome: 'village',
  seed: 'fileops_test',
  default_tile: 'grass',
  width: 24,
  height: 18,
};
writeFileSync(ZONE_PATH, JSON.stringify(baseZone, null, 2) + '\n');

try {
  console.log('\nvalidators');
  throws('append_post_ops with x/y at is rejected', () =>
    assertNoCoordinatesInPostOps([{ type: 'stamp', at: { x: 3, y: 4 }, prefab: 'x' }], ZONE_ID),
  );
  // Nested coordinate (portal.at) also rejected.
  throws('nested x/y at is rejected', () =>
    assertNoCoordinatesInPostOps([{ type: 'portal', at: { y: 9 }, target_zone: 'z' }], ZONE_ID),
  );
  check('semantic at passes coordinate check',
    (() => { assertNoCoordinatesInPostOps([{ type: 'stamp', at: { near_tile: 'grass' }, prefab: 'x' }], ZONE_ID); return true; })());
  check('rectangular prefab grid valid', validatePrefabGrid({ data: 'SSS\nSDS\nSSS', legend: { S: 'stone_floor', D: 'portal' } }) === null);
  check('ragged prefab grid rejected', validatePrefabGrid({ data: 'SSS\nSD', legend: { S: 'a', D: 'b' } }) !== null);
  check('uncovered char rejected', validatePrefabGrid({ data: 'SX', legend: { S: 'a' } }) !== null);
  // Oversized prefab (wider than the largest biome grid) rejected at create time.
  check('oversized prefab grid rejected', validatePrefabGrid({ data: 'S'.repeat(100), legend: { S: 'stone_floor' } }) !== null);

  console.log('\nbuildZoneContext (#7)');
  const ctx = buildZoneContext(ZONE_ID);
  check('context built for known zone', !!ctx);
  check('unknown zone returns null', buildZoneContext('__nope__') === null);
  check('biome surfaced', ctx?.biome === 'village');
  check('named_regions derived from grid', (ctx?.named_regions.length ?? 0) > 0);
  check('tile_types_present derived from grid', (ctx?.tile_types_present.length ?? 0) > 0);
  check('existing_post_ops counts (0 initially)', ctx?.existing_post_ops === 0);

  console.log('\napplyFileOps (#6)');
  // append_post_ops + append_features + patch_zone_field.
  const region = buildZoneContext(ZONE_ID)!.named_regions[0]!;
  const res = applyFileOps([
    { op: 'append_post_ops', zone_id: ZONE_ID, ops: [{ type: 'stamp', at: { in_region: region }, prefab: 'sewer_entrance' } as never] },
    { op: 'append_features', zone_id: ZONE_ID, features: ['fountain'] },
    { op: 'patch_zone_field', zone_id: ZONE_ID, field: 'display_name', value: 'Test Hamlet' },
  ]);
  const doc = JSON.parse(readFileSync(ZONE_PATH, 'utf8'));
  check('post_ops appended', Array.isArray(doc.post_ops) && doc.post_ops.length === 1);
  check('features appended', doc.features?.includes('fountain'));
  check('display_name patched', doc.display_name === 'Test Hamlet');
  check('result reports modified zone', res.touchedZones.includes(ZONE_ID));
  check('context now counts 1 post_op', buildZoneContext(ZONE_ID)?.existing_post_ops === 1);

  // Bad level_band patch rejected.
  throws('patch_zone_field level_band requires shape', () =>
    applyFileOps([{ op: 'patch_zone_field', zone_id: ZONE_ID, field: 'level_band', value: 'tier2' }]),
  );
  // append_post_ops with coordinates rejected by applyFileOps too.
  throws('applyFileOps rejects x/y post_op', () =>
    applyFileOps([{ op: 'append_post_ops', zone_id: ZONE_ID, ops: [{ type: 'stamp', at: { x: 1, y: 1 }, prefab: 'p' } as never] }]),
  );

  console.log('\nappend_spawns');
  applyFileOps([
    { op: 'append_spawns', zone_id: ZONE_ID, spawns: [{ entity: 'rat', count: 3 }, { entity: 'citizen', region: 'market' }] },
  ]);
  const spawnDoc = JSON.parse(readFileSync(ZONE_PATH, 'utf8'));
  check('spawns appended', Array.isArray(spawnDoc.spawns) && spawnDoc.spawns.length === 2);
  check('zone-wide spawn has no region', spawnDoc.spawns[0].region === undefined);
  throws('append_spawns rejects at coordinates', () =>
    applyFileOps([{ op: 'append_spawns', zone_id: ZONE_ID, spawns: [{ entity: 'rat', at: { x: 1, y: 1 } } as never] }]),
  );

  console.log('\nvalidateZoneStub');
  const goodStub = JSON.stringify({
    id: 'cellar_test', biome: 'dungeon', seed: 'cellar_test_v1',
    display_name: 'Test Cellar',
    level_band: { tier: 1, minLevel: 1, maxLevel: 5 },
    spawn_point: { focal: true },
    connections: { surface: ZONE_ID },
    spawns: [{ entity: 'rat', count: 4, respawn_seconds: 90 }],
    post_ops: [{ type: 'scatter', bounds: { all: true }, tile: 'dirt', count: 4, seed: 's', over: ['stone_floor'] }],
  });
  check('valid stub accepted',
    (() => { validateZoneStub('world/zones/cellar_test.json', goodStub); return true; })());
  throws('stub with generation ops rejected', () =>
    validateZoneStub('world/zones/cellar_test.json', JSON.stringify({
      id: 'cellar_test', biome: 'dungeon', seed: 's', ops: [{ type: 'cave' }],
    })));
  throws('stub with width/height rejected', () =>
    validateZoneStub('world/zones/cellar_test.json', JSON.stringify({
      id: 'cellar_test', biome: 'dungeon', seed: 's', width: 50, height: 50,
    })));
  throws('stub with unknown biome rejected', () =>
    validateZoneStub('world/zones/cellar_test.json', JSON.stringify({
      id: 'cellar_test', biome: 'volcano', seed: 's',
    })));
  throws('stub id/filename mismatch rejected', () =>
    validateZoneStub('world/zones/cellar_test.json', JSON.stringify({
      id: 'other_id', biome: 'dungeon', seed: 's',
    })));
  throws('stub spawn with x/y rejected', () =>
    validateZoneStub('world/zones/cellar_test.json', JSON.stringify({
      id: 'cellar_test', biome: 'dungeon', seed: 's', spawns: [{ entity: 'rat', at: { x: 1, y: 1 } }],
    })));
  throws('create file_op routes zone files through stub validation', () =>
    applyFileOps([{
      op: 'create', path: 'world/zones/__stub_reject.json',
      content: JSON.stringify({ id: '__stub_reject', biome: 'dungeon', seed: 's', ops: [] }),
    }]),
  );
} finally {
  rmSync(ZONE_PATH, { force: true });
}

console.log(failures === 0 ? '\nAll fileOps/context checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
