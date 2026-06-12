// Verifies Implementor-v2 pipeline changes: the validated FileOp write layer
// (#6) and the ZoneContext builder (#7).
//
//   npx tsx tools/test-fileops.ts

import { join } from 'node:path';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { applyFileOps, validatePrefabGrid } from '../pipeline/lib/fileOps.ts';
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

  console.log('\napplyFileOps (#6)');
  // append_features (string + object entries) + patch_zone_field.
  const res = applyFileOps([
    {
      op: 'append_features', zone_id: ZONE_ID,
      features: ['fountain', { id: 'sewer_entrance', portal_to: 'zone_40_40' }],
    },
    { op: 'patch_zone_field', zone_id: ZONE_ID, field: 'display_name', value: 'Test Hamlet' },
  ]);
  const doc = JSON.parse(readFileSync(ZONE_PATH, 'utf8'));
  check('string feature appended', doc.features?.includes('fountain'));
  check('object feature appended', doc.features?.some(
    (f: unknown) => typeof f === 'object' && (f as { id: string }).id === 'sewer_entrance'));
  check('display_name patched', doc.display_name === 'Test Hamlet');
  check('result reports modified zone', res.touchedZones.includes(ZONE_ID));
  check('context lists prefab feature as active',
    buildZoneContext(ZONE_ID)?.features.includes('sewer_entrance') === true);

  // Re-appending the same ids is a no-op (dedup by id).
  applyFileOps([
    { op: 'append_features', zone_id: ZONE_ID, features: [{ id: 'fountain' }, 'sewer_entrance'] },
  ]);
  const dedup = JSON.parse(readFileSync(ZONE_PATH, 'utf8'));
  check('duplicate feature ids dropped', dedup.features.length === 2);

  // Bad level_band patch rejected.
  throws('patch_zone_field level_band requires shape', () =>
    applyFileOps([{ op: 'patch_zone_field', zone_id: ZONE_ID, field: 'level_band', value: 'tier2' }]),
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
    features: [
      'campfire_pit',
      { id: 'guard_tower', enabled: false },
      { id: 'sewer_entrance', portal_to: ZONE_ID, transition: 'ascend' },
      { id: 'shrine_idol', in_region: 'room_0' },
    ],
  });
  check('valid stub accepted',
    (() => { validateZoneStub('world/zones/cellar_test.json', goodStub); return true; })());
  throws('stub with generation ops rejected', () =>
    validateZoneStub('world/zones/cellar_test.json', JSON.stringify({
      id: 'cellar_test', biome: 'dungeon', seed: 's', ops: [{ type: 'cave' }],
    })));
  throws('stub with post_ops rejected', () =>
    validateZoneStub('world/zones/cellar_test.json', JSON.stringify({
      id: 'cellar_test', biome: 'dungeon', seed: 's',
      post_ops: [{ type: 'scatter', bounds: { all: true }, tile: 'dirt', count: 4, seed: 's' }],
    })));
  throws('stub with unknown feature-entry key rejected', () =>
    validateZoneStub('world/zones/cellar_test.json', JSON.stringify({
      id: 'cellar_test', biome: 'dungeon', seed: 's',
      features: [{ id: 'x', at: { x: 1, y: 1 } }],
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
