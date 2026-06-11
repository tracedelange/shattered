// Referential validation of an ImplementerOutput against the loaded world.
//
// Catches the silent-failure class where the LLM references something that
// does not exist: a spawned mob with no template, a stamped prefab that was
// never created, a sprite/tile the tileset doesn't define, a quest giver who
// is never spawned. Each is cheap to check host-side and expensive to ship —
// a broken spawn costs a whole opportunity cycle to notice and fix.
//
// Pure: returns a list of human/LLM-readable error strings. The caller feeds
// them into the one-shot repair path.

import yaml from 'js-yaml';
import type { WorldDefs, QuestDef } from '../../shared/types.ts';
import type { ImplementerOutput } from './schemas.ts';

interface Refs {
  mobs: Set<string>;
  items: Set<string>;
  prefabs: Set<string>;
  zones: Set<string>;
  tiles: Set<string>;
  sprites: Set<string>;
  spawnIds: Set<string>;
}

/** IDs available after this response is applied: world state + created files. */
function collectRefs(out: ImplementerOutput, defs: WorldDefs): Refs {
  const refs: Refs = {
    mobs: new Set(Object.keys(defs.mobs)),
    items: new Set(Object.keys(defs.itemBases)),
    prefabs: new Set(Object.keys(defs.prefabs)),
    zones: new Set(Object.keys(defs.zones)),
    tiles: new Set<string>(),
    sprites: new Set<string>(),
    spawnIds: new Set<string>(),
  };

  for (const ts of Object.values(defs.tilesets)) {
    for (const t of Object.keys(ts.tiles)) refs.tiles.add(t);
    for (const s of Object.keys(ts.sprites)) refs.sprites.add(s);
  }
  for (const z of Object.values(defs.zones)) {
    for (const s of z.spawns ?? []) if (s.spawn_id) refs.spawnIds.add(s.spawn_id);
  }

  // Entries created in this same response.
  for (const t of Object.keys(out.tileset_update?.tiles_add ?? {})) refs.tiles.add(t);
  for (const s of Object.keys(out.tileset_update?.sprites_add ?? {})) refs.sprites.add(s);
  for (const z of out.new_zones ?? []) refs.zones.add(z.id);

  const fileId = (path: string): string => path.replace(/^.*\//, '').replace(/\.(ya?ml|json)$/, '');
  const allFiles = [
    ...out.files.map((f) => ({ path: f.path, content: f.body })),
    ...(out.file_ops ?? []).flatMap((fo) => (fo.op === 'create' ? [{ path: fo.path, content: fo.content }] : [])),
  ];
  for (const f of allFiles) {
    const p = f.path.replace(/^\.\/+/, '');
    if (p.startsWith('world/entities/mobs/')) refs.mobs.add(fileId(p));
    else if (p.startsWith('world/entities/items/')) refs.items.add(fileId(p));
    else if (p.startsWith('world/prefabs/')) refs.prefabs.add(fileId(p));
    else if (p.startsWith('world/zones/')) refs.zones.add(fileId(p));
  }
  return refs;
}

function safeYaml(body: string): Record<string, unknown> | null {
  try {
    const d = yaml.load(body);
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeJson(body: string): Record<string, unknown> | null {
  try {
    const d = JSON.parse(body);
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Check one spawn list (zone stub, spec, or append_spawns op). */
function checkSpawnEntities(
  spawns: Array<{ entity?: unknown }>,
  refs: Refs,
  where: string,
  errors: string[],
): void {
  for (const s of spawns) {
    const e = typeof s.entity === 'string' ? s.entity : '';
    if (e && !refs.mobs.has(e)) {
      errors.push(
        `${where}: spawn entity '${e}' does not exist in world/entities/mobs/ ` +
        `and is not created in this response`,
      );
    }
  }
}

function checkSpawnWeights(
  weights: Record<string, unknown> | undefined,
  refs: Refs,
  where: string,
  errors: string[],
): void {
  for (const id of Object.keys(weights ?? {})) {
    if (!refs.mobs.has(id)) {
      errors.push(`${where}: spawn_weights mob '${id}' does not exist and is not created in this response`);
    }
  }
}

/** Walk post_ops: prefab refs, portal targets, painted tiles, inline legends. */
function checkPostOps(ops: unknown[], refs: Refs, where: string, errors: string[]): void {
  for (const raw of ops) {
    const op = raw as Record<string, unknown>;
    if (typeof op.prefab === 'string' && !refs.prefabs.has(op.prefab)) {
      errors.push(`${where}: prefab '${op.prefab}' does not exist in world/prefabs/ and is not created in this response`);
    }
    if (op.prefab && typeof op.prefab === 'object') {
      const legend = (op.prefab as { legend?: Record<string, string> }).legend ?? {};
      for (const tile of Object.values(legend)) {
        if (!refs.tiles.has(tile)) {
          errors.push(`${where}: inline prefab legend tile '${tile}' is not in any tileset or tileset_update`);
        }
      }
    }
    if (typeof op.target_zone === 'string' && !refs.zones.has(op.target_zone)) {
      errors.push(`${where}: portal target_zone '${op.target_zone}' does not exist and is not created in this response`);
    }
    for (const key of ['tile', 'carve'] as const) {
      if (typeof op[key] === 'string' && !refs.tiles.has(op[key] as string)) {
        errors.push(`${where}: ${key} '${op[key]}' is not in any tileset or tileset_update`);
      }
    }
  }
}

function checkMobTemplate(doc: Record<string, unknown>, refs: Refs, where: string, errors: string[]): void {
  if (typeof doc.sprite === 'string' && !refs.sprites.has(doc.sprite)) {
    errors.push(
      `${where}: sprite '${doc.sprite}' is not in any tileset — add it via ` +
      `tileset_update.sprites_add or use an existing sprite`,
    );
  }
  const loot = Array.isArray(doc.loot_table) ? doc.loot_table : [];
  for (const entry of loot as Array<{ item?: unknown }>) {
    const item = typeof entry?.item === 'string' ? entry.item : '';
    if (item && !refs.items.has(item)) {
      errors.push(`${where}: loot_table item '${item}' does not exist in world/entities/items/ and is not created in this response`);
    }
  }
  const shop = Array.isArray(doc.shop) ? doc.shop : [];
  for (const entry of shop as Array<{ item?: unknown }>) {
    const item = typeof entry?.item === 'string' ? entry.item : '';
    if (item && !refs.items.has(item)) {
      errors.push(`${where}: shop item '${item}' does not exist and is not created in this response`);
    }
  }
}

function checkQuest(doc: QuestDef, refs: Refs, where: string, errors: string[]): void {
  if (doc.giver && !refs.mobs.has(doc.giver) && !refs.spawnIds.has(doc.giver)) {
    errors.push(`${where}: giver '${doc.giver}' matches no mob template or spawn_id and is not created in this response`);
  }
  if (doc.zone && !refs.zones.has(doc.zone)) {
    errors.push(`${where}: zone '${doc.zone}' does not exist`);
  }
  for (const stage of doc.stages ?? []) {
    const obj = stage.objective;
    if (!obj) continue;
    const at = `${where} stage '${stage.id}'`;
    if ('template_id' in obj && obj.template_id && !refs.mobs.has(obj.template_id)) {
      errors.push(`${at}: objective template_id '${obj.template_id}' does not exist and is not created in this response`);
    }
    if (obj.kind === 'collect_count' && !refs.items.has(obj.item_base)) {
      errors.push(`${at}: objective item_base '${obj.item_base}' does not exist and is not created in this response`);
    }
    if (obj.kind === 'talk' && !refs.mobs.has(obj.target_template)) {
      errors.push(`${at}: objective target_template '${obj.target_template}' does not exist and is not created in this response`);
    }
    if ('zone' in obj && obj.zone && !refs.zones.has(obj.zone)) {
      errors.push(`${at}: objective zone '${obj.zone}' does not exist`);
    }
  }
  for (const r of doc.rewards ?? []) {
    if (r.item && !refs.items.has(r.item)) {
      errors.push(`${where}: reward item '${r.item}' does not exist and is not created in this response`);
    }
  }
}

/**
 * Validate every cross-reference in the output against the world plus the
 * output itself. Returns error strings; empty means clean.
 */
export function validateReferences(out: ImplementerOutput, defs: WorldDefs): string[] {
  const refs = collectRefs(out, defs);
  const errors: string[] = [];

  // New-zone specs.
  for (const spec of out.new_zones ?? []) {
    const where = `new_zones['${spec.id}']`;
    if (!defs.zones[spec.parent_zone]) {
      errors.push(`${where}: parent_zone '${spec.parent_zone}' does not exist`);
    }
    checkSpawnEntities(spec.spawns ?? [], refs, where, errors);
    checkSpawnWeights(spec.spawn_weights, refs, where, errors);
  }

  // file_ops against existing zones.
  for (const fo of out.file_ops ?? []) {
    if (fo.op === 'append_spawns') {
      checkSpawnEntities(fo.spawns, refs, `file_ops append_spawns(${fo.zone_id})`, errors);
    } else if (fo.op === 'patch_spawn_weights') {
      checkSpawnWeights(fo.weights, refs, `file_ops patch_spawn_weights(${fo.zone_id})`, errors);
    } else if (fo.op === 'append_post_ops') {
      checkPostOps(fo.ops, refs, `file_ops append_post_ops(${fo.zone_id})`, errors);
    }
  }

  // Created/modified files by kind.
  const allFiles = [
    ...out.files.map((f) => ({ path: f.path.replace(/^\.\/+/, ''), content: f.body })),
    ...(out.file_ops ?? []).flatMap((fo) =>
      fo.op === 'create' ? [{ path: fo.path.replace(/^\.\/+/, ''), content: fo.content }] : []),
  ];
  for (const f of allFiles) {
    if (f.path.startsWith('world/entities/mobs/')) {
      const doc = safeYaml(f.content);
      if (doc) checkMobTemplate(doc, refs, f.path, errors);
    } else if (f.path.startsWith('world/quests/')) {
      const doc = safeYaml(f.content);
      if (doc) checkQuest(doc as QuestDef, refs, f.path, errors);
    } else if (f.path.startsWith('world/zones/')) {
      const doc = safeJson(f.content);
      if (doc) {
        const where = f.path;
        checkSpawnEntities(Array.isArray(doc.spawns) ? (doc.spawns as Array<{ entity?: unknown }>) : [], refs, where, errors);
        checkSpawnWeights(doc.spawn_weights as Record<string, unknown> | undefined, refs, where, errors);
        if (Array.isArray(doc.post_ops)) checkPostOps(doc.post_ops, refs, where, errors);
      }
    }
  }

  return errors;
}
