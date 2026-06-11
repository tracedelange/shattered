// Verifies the Phase-2 host-side pipeline pieces: referential validation,
// new-zone spec materialization, and the programmatic seed-retry repair.
//
//   npx tsx tools/test-pipeline-validation.ts

import { join } from 'node:path';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { loadWorld } from '../server/world/loader.ts';
import { validateReferences } from '../pipeline/lib/refValidate.ts';
import { NewZoneSpecSchema, buildZoneStubFromSpec, validateZoneStub } from '../pipeline/lib/zoneStub.ts';
import { repairZoneBySeedRetry } from '../pipeline/lib/zoneRepair.ts';
import { evaluateZoneStructure } from '../pipeline/lib/renderZone.ts';
import type { ImplementerOutput } from '../pipeline/lib/schemas.ts';

const ROOT = join(import.meta.dirname, '..');
const WORLD = join(ROOT, 'world');

let failures = 0;
const check = (label: string, pass: boolean): void => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failures++;
};

const defs = loadWorld(WORLD);
const someZone = Object.keys(defs.zones)[0]!;
const someMob = Object.keys(defs.mobs)[0]!;

const base = (over: Partial<ImplementerOutput>): ImplementerOutput =>
  ({ files: [], ...over }) as ImplementerOutput;

console.log('\nvalidateReferences');
check('clean empty output passes', validateReferences(base({ notes: 'noop' }), defs).length === 0);

check('unknown spawn entity flagged', validateReferences(base({
  file_ops: [{ op: 'append_spawns', zone_id: someZone, spawns: [{ entity: 'no_such_mob' }] }],
}), defs).length === 1);

check('existing mob passes', validateReferences(base({
  file_ops: [{ op: 'append_spawns', zone_id: someZone, spawns: [{ entity: someMob }] }],
}), defs).length === 0);

check('mob created in same response passes', validateReferences(base({
  files: [{ path: 'world/entities/mobs/test_wolf.yaml', op: 'write', body: 'id: test_wolf\nsprite: rat_01\n' }],
  file_ops: [{ op: 'append_spawns', zone_id: someZone, spawns: [{ entity: 'test_wolf' }] }],
}), defs).length === 0);

check('unknown sprite on created mob flagged', validateReferences(base({
  files: [{ path: 'world/entities/mobs/test_wolf.yaml', op: 'write', body: 'id: test_wolf\nsprite: no_such_sprite\n' }],
}), defs).length === 1);

check('sprite via tileset_update passes', validateReferences(base({
  files: [{ path: 'world/entities/mobs/test_wolf.yaml', op: 'write', body: 'id: test_wolf\nsprite: wolf_01\n' }],
  tileset_update: { tileset: 'overworld', sprites_add: { wolf_01: { color: '#777777' } } },
}), defs).length === 0);

check('unknown loot item flagged', validateReferences(base({
  files: [{ path: 'world/entities/mobs/test_wolf.yaml', op: 'write', body: 'id: test_wolf\nsprite: rat_01\nloot_table:\n  - { item: no_such_item, chance: 0.5 }\n' }],
}), defs).length === 1);

check('unknown stamped prefab flagged', validateReferences(base({
  file_ops: [{ op: 'append_post_ops', zone_id: someZone, ops: [{ type: 'stamp', at: { near_tile: 'grass' }, prefab: 'no_such_prefab' }] }],
}), defs).length === 1);

check('portal to spec-created zone passes', validateReferences(base({
  new_zones: [{ id: 'test_cellar', biome: 'dungeon', display_name: 'T', parent_zone: someZone, lore_summary: 's' }],
  file_ops: [{ op: 'append_post_ops', zone_id: someZone, ops: [{ type: 'portal', at: { anchor_of: 'cellar_entrance', anchor: 'descend' }, target_zone: 'test_cellar' }] }],
}), defs).length === 0);

check('quest with unknown giver flagged', validateReferences(base({
  files: [{ path: 'world/quests/test_q.yaml', op: 'write', body: 'id: test_q\ngiver: no_such_npc\nzone: ' + someZone + '\n' }],
}), defs).length === 1);

check('quest collect_count unknown item flagged', validateReferences(base({
  files: [{ path: 'world/quests/test_q.yaml', op: 'write', body: `id: test_q\ngiver: ${someMob}\nzone: ${someZone}\nstages:\n  - id: s1\n    text: t\n    objective: { kind: collect_count, item_base: no_such_item, target: 3 }\n` }],
}), defs).length === 1);

console.log('\nNewZoneSpec → stub');
const spec = NewZoneSpecSchema.parse({
  id: 'test_cellar',
  biome: 'dungeon',
  display_name: 'Test Cellar',
  parent_zone: someZone,
  spawns: [{ entity: someMob, count: 3 }],
  lore_summary: 'A test cellar.',
});
const parent = defs.zones[someZone]!;
const stub = buildZoneStubFromSpec(spec, parent);
check('seed derived from id', stub.seed === 'test_cellar_v1');
check('connection label defaults to surface', stub.connections?.surface === someZone);
check('level_band inherited from parent', JSON.stringify(stub.level_band) === JSON.stringify(parent.level_band));
check('spawn_point is focal', JSON.stringify(stub.spawn_point) === JSON.stringify({ focal: true }));
check('stub passes validateZoneStub',
  (() => { validateZoneStub('world/zones/test_cellar.json', JSON.stringify(stub)); return true; })());
check('cardinal connection_label rejected',
  !NewZoneSpecSchema.safeParse({ ...spec, connection_label: 'north' }).success);
check('spec with region spawn rejected',
  !NewZoneSpecSchema.safeParse({ ...spec, spawns: [{ entity: someMob, region: 'r' }] }).success);

console.log('\nseed-retry repair');
const REPAIR_ID = '__test_seed_repair';
const repairPath = join(WORLD, 'zones', `${REPAIR_ID}.json`);
writeFileSync(repairPath, JSON.stringify({
  id: REPAIR_ID, biome: 'dungeon', seed: `${REPAIR_ID}_v1`,
  spawn_point: { focal: true }, connections: { surface: someZone },
}, null, 2) + '\n');
try {
  const freshDefs = loadWorld(WORLD);
  const evalResult = evaluateZoneStructure(freshDefs.zones[REPAIR_ID]!, freshDefs.tilesets['dungeon'] ?? freshDefs.tilesets['overworld']!, freshDefs.prefabs);
  check('evaluateZoneStructure returns counts', Number.isFinite(evalResult.inaccessibleTiles));
  const r = repairZoneBySeedRetry(REPAIR_ID, WORLD, freshDefs.tilesets, freshDefs.prefabs);
  check('repair returns a result', r.zoneId === REPAIR_ID);
  check('repair leaves a valid stub on disk',
    (() => { validateZoneStub(`world/zones/${REPAIR_ID}.json`, readFileSync(repairPath, 'utf8')); return true; })());
  if (r.reseeded) {
    check('reseeded stub records the new seed', (JSON.parse(readFileSync(repairPath, 'utf8')) as { seed: string }).seed === r.seed);
  } else {
    check('clean zone keeps its seed', r.seed === `${REPAIR_ID}_v1`);
  }
} finally {
  rmSync(repairPath, { force: true });
}

console.log(failures === 0 ? '\nAll pipeline-validation checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
