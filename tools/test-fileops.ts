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

  console.log('\nbuildZoneContext (#7)');
  const ctx = buildZoneContext(ZONE_ID);
  check('context built for known zone', !!ctx);
  check('unknown zone returns null', buildZoneContext('__nope__') === null);
  check('biome surfaced', ctx?.biome === 'village');
  check('named_regions derived from grid', (ctx?.named_regions.length ?? 0) > 0);
  check('tile_types_present derived from grid', (ctx?.tile_types_present.length ?? 0) > 0);
  check('spawn_weights inherits biome defaults', Object.keys(ctx?.spawn_weights ?? {}).length > 0);
  check('existing_post_ops counts (0 initially)', ctx?.existing_post_ops === 0);

  console.log('\napplyFileOps (#6)');
  // append_post_ops + append_features + patch_spawn_weights + patch_zone_field.
  const region = buildZoneContext(ZONE_ID)!.named_regions[0]!;
  const res = applyFileOps([
    { op: 'append_post_ops', zone_id: ZONE_ID, ops: [{ type: 'stamp', at: { in_region: region }, prefab: 'sewer_entrance' } as never] },
    { op: 'append_features', zone_id: ZONE_ID, features: ['fountain'] },
    { op: 'patch_spawn_weights', zone_id: ZONE_ID, weights: { citizen: 5 } },
    { op: 'patch_zone_field', zone_id: ZONE_ID, field: 'display_name', value: 'Test Hamlet' },
  ]);
  const doc = JSON.parse(readFileSync(ZONE_PATH, 'utf8'));
  check('post_ops appended', Array.isArray(doc.post_ops) && doc.post_ops.length === 1);
  check('features appended', doc.features?.includes('fountain'));
  check('spawn_weights patched', doc.spawn_weights?.citizen === 5);
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
} finally {
  rmSync(ZONE_PATH, { force: true });
}

console.log(failures === 0 ? '\nAll fileOps/context checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
