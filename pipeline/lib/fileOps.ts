// Validated FileOp write layer (Implementor v2, engine change #6).
//
// The Implementor never calls writeFileSync directly. It emits a list of
// FileOps; this module validates each (enforcing the coordinate boundary and
// prefab-grid rules) and applies them surgically. `append_post_ops` is the
// primary v2 mutation: it appends ops to an existing zone file's post_ops array
// without rewriting the file, so the frozen biome pipeline fields are never
// touched.

import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import { REPO_ROOT, WORLD_DIR } from './io.ts';
import { LevelBandSchema, validateZoneStub } from './zoneStub.ts';
import type { GenOp, PrefabData, ZoneDef, ZoneSpawn } from '../../shared/types.ts';

// ── Schema ───────────────────────────────────────────────────────────────────

// post_ops are kept permissive at the schema layer — the mapgen engine is the
// source of truth for op shape. The two v2 invariants (no coordinates, valid
// prefab grids) are enforced by the validators below, not by Zod.
const PostOpSchema = z.record(z.string(), z.unknown());

// Spawn entries the Implementor may append. Coordinate-free by construction:
// no `at` field — `region` targets a named region, omitting it scatters
// zone-wide (see World._spawnOne).
const SpawnEntrySchema = z.object({
  entity: z.string().min(1),
  region: z.string().min(1).optional(),
  count: z.number().int().positive().optional(),
  respawn_seconds: z.number().positive().optional(),
  spawn_id: z.string().min(1).optional(),
}).strict();

export const FileOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    path: z.string().min(1),
    content: z.string().min(1),
  }),
  z.object({
    op: z.literal('append_post_ops'),
    zone_id: z.string().min(1),
    ops: z.array(PostOpSchema).min(1),
  }),
  z.object({
    op: z.literal('append_spawns'),
    zone_id: z.string().min(1),
    spawns: z.array(SpawnEntrySchema).min(1),
  }),
  z.object({
    op: z.literal('append_features'),
    zone_id: z.string().min(1),
    features: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    op: z.literal('patch_spawn_weights'),
    zone_id: z.string().min(1),
    weights: z.record(z.string(), z.number()),
  }),
  z.object({
    op: z.literal('patch_zone_field'),
    zone_id: z.string().min(1),
    field: z.enum(['display_name', 'level_band']),
    value: z.unknown(),
  }),
]);

export type FileOp = z.infer<typeof FileOpSchema>;

// ── Validators ─────────────────────────────────────────────────────────────

/**
 * Enforce the coordinate boundary: no `at` descriptor anywhere inside post_ops
 * may carry an `x` or `y` key. The Implementor must use SemanticAt descriptors;
 * the engine resolves them to tiles. Throws on the first violation.
 */
export function assertNoCoordinatesInPostOps(ops: unknown[], zoneId: string): void {
  const visit = (node: unknown, keyName: string | null): void => {
    if (Array.isArray(node)) {
      for (const v of node) visit(v, null);
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (keyName === 'at' && ('x' in obj || 'y' in obj)) {
        throw new Error(
          `[fileOps] ${zoneId}: post_op 'at' descriptor uses x/y coordinates ` +
          `(${JSON.stringify(obj)}). Use a SemanticAt descriptor instead ` +
          `(near_tile, near_region, in_region, on_tile, anchor_of, …).`,
        );
      }
      for (const [k, v] of Object.entries(obj)) visit(v, k);
    }
  };
  visit(ops, null);
}

/** Validate a prefab grid: rectangular, and every char in `data` covered by the
 *  legend (anchors are a subset of the legend; whitespace/newlines are skipped).
 *  Returns an error string, or null when valid. */
export function validatePrefabGrid(prefab: Pick<PrefabData, 'data' | 'legend'>): string | null {
  if (typeof prefab.data !== 'string' || !prefab.data.length) {
    return 'prefab.data must be a non-empty string';
  }
  const rows = prefab.data.replace(/\n+$/, '').split('\n');
  const width = rows[0]?.length ?? 0;
  for (let r = 0; r < rows.length; r++) {
    if (rows[r]!.length !== width) {
      return `prefab grid is not rectangular: row ${r} has length ${rows[r]!.length}, expected ${width}`;
    }
    for (const ch of rows[r]!) {
      if (!(ch in (prefab.legend ?? {}))) {
        return `prefab data uses character '${ch}' not present in legend`;
      }
    }
  }
  return null;
}

/** Scan post_ops for inline prefabs (stamp/place) and validate each grid. Throws on the first invalid one. */
function assertValidInlinePrefabs(ops: unknown[], zoneId: string): void {
  for (const op of ops) {
    const o = op as Record<string, unknown>;
    const candidates: unknown[] = [o.prefab];
    if (o.role_prefabs && typeof o.role_prefabs === 'object') {
      candidates.push(...Object.values(o.role_prefabs as Record<string, unknown>));
    }
    for (const c of candidates) {
      // String refs are named prefabs resolved at load — nothing to validate here.
      if (!c || typeof c !== 'object') continue;
      const p = c as { data?: unknown; legend?: unknown };
      if (typeof p.data !== 'string') continue;
      const err = validatePrefabGrid(p as PrefabData);
      if (err) throw new Error(`[fileOps] ${zoneId}: inline ${String(o.type)} prefab invalid — ${err}`);
    }
  }
}

// ── Zone file IO (format-preserving) ─────────────────────────────────────────

interface ZoneFile { path: string; format: 'json' | 'yaml'; doc: ZoneDef & Record<string, unknown> }

/** Locate an existing zone file (json preferred, then yaml) and parse it. */
function readZoneFile(zoneId: string): ZoneFile {
  const jsonPath = join(WORLD_DIR, 'zones', `${zoneId}.json`);
  const yamlPath = join(WORLD_DIR, 'zones', `${zoneId}.yaml`);
  if (existsSync(jsonPath)) {
    return { path: jsonPath, format: 'json', doc: JSON.parse(readFileSync(jsonPath, 'utf8')) };
  }
  if (existsSync(yamlPath)) {
    return { path: yamlPath, format: 'yaml', doc: yaml.load(readFileSync(yamlPath, 'utf8')) as ZoneFile['doc'] };
  }
  throw new Error(`[fileOps] zone '${zoneId}' not found (looked for ${zoneId}.json / .yaml in world/zones/).`);
}

function writeZoneFile(zf: ZoneFile): void {
  const body = zf.format === 'json'
    ? JSON.stringify(zf.doc, null, 2) + '\n'
    : yaml.dump(zf.doc, { lineWidth: -1, noRefs: true });
  writeFileSync(zf.path, body, 'utf8');
}

// ── Path safety (mirrors implementer.validatePath, plus prefabs + json) ──────

const ALLOWED_CREATE_PREFIXES = [
  'world/zones/', 'world/entities/', 'world/quests/', 'world/prefabs/', 'world/lore/',
];

function resolveCreatePath(rel: string): string {
  const cleaned = rel.replace(/^\.\/+/, '');
  if (cleaned.startsWith('/') || cleaned.includes('..')) {
    throw new Error(`[fileOps] unsafe create path: ${rel}`);
  }
  if (!ALLOWED_CREATE_PREFIXES.some((p) => cleaned.startsWith(p))) {
    throw new Error(`[fileOps] create path outside allowed dirs: ${rel}`);
  }
  if (!/\.(ya?ml|json)$/.test(cleaned)) {
    throw new Error(`[fileOps] create path must end in .yaml/.json: ${rel}`);
  }
  return join(REPO_ROOT, cleaned);
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface FileOpResult {
  /** Repo-relative paths created. */
  created: string[];
  /** Repo-relative paths modified in place. */
  modified: string[];
  /** Zone ids whose grid changed (for re-render). */
  touchedZones: string[];
  /** Absolute paths touched (for git staging). */
  absPaths: string[];
}

const rel = (abs: string): string => (abs.startsWith(REPO_ROOT) ? abs.slice(REPO_ROOT.length + 1) : abs);

/**
 * Validate and apply a list of FileOps. Throws on the first validation failure
 * (coordinate boundary, invalid prefab grid, unsafe path, missing zone) before
 * touching disk for that op. When `dryRun`, validates and reports without writing.
 */
export function applyFileOps(ops: FileOp[], opts: { dryRun?: boolean } = {}): FileOpResult {
  const result: FileOpResult = { created: [], modified: [], touchedZones: [], absPaths: [] };
  const touched = new Set<string>();

  for (const op of ops) {
    switch (op.op) {
      case 'create': {
        const abs = resolveCreatePath(op.path);
        const cleaned = op.path.replace(/^\.\/+/, '');
        // Validate prefab grids at create time so a broken prefab never lands.
        if (cleaned.startsWith('world/prefabs/') && op.path.endsWith('.json')) {
          const parsed = JSON.parse(op.content) as PrefabData;
          const err = validatePrefabGrid(parsed);
          if (err) throw new Error(`[fileOps] prefab ${op.path} invalid — ${err}`);
        }
        // Mob YAML files must have a valid role field.
        if (cleaned.startsWith('world/entities/mobs/') && /\.ya?ml$/.test(cleaned)) {
          const parsed = yaml.load(op.content) as Record<string, unknown>;
          const validRoles = ['skirmisher', 'brute', 'tank', 'pest', 'soldier', 'npc', 'passive'];
          const required = ['id', 'name', 'sprite', 'level', 'role', 'speed', 'behavior', 'aggro_range'];
          for (const field of required) {
            if (parsed[field] == null) throw new Error(`[fileOps] mob ${op.path} missing required field "${field}"`);
          }
          if (!validRoles.includes(parsed.role as string)) {
            throw new Error(`[fileOps] mob ${op.path} invalid role "${parsed.role}". Must be one of: ${validRoles.join(', ')}`);
          }
        }
        // Zone files must be v2 biome stubs — never hand-authored op-list zones.
        if (cleaned.startsWith('world/zones/')) {
          const stub = validateZoneStub(cleaned, op.content);
          if (stub.post_ops) {
            assertNoCoordinatesInPostOps(stub.post_ops, stub.id);
            assertValidInlinePrefabs(stub.post_ops, stub.id);
          }
        }
        const existed = existsSync(abs);
        if (!opts.dryRun) writeFileSync(abs, op.content.endsWith('\n') ? op.content : op.content + '\n', 'utf8');
        (existed ? result.modified : result.created).push(rel(abs));
        result.absPaths.push(abs);
        if (op.path.includes('world/zones/')) {
          touched.add(op.path.replace(/^.*world\/zones\//, '').replace(/\.(ya?ml|json)$/, ''));
        }
        break;
      }

      case 'append_post_ops': {
        assertNoCoordinatesInPostOps(op.ops, op.zone_id);
        assertValidInlinePrefabs(op.ops, op.zone_id);
        const zf = readZoneFile(op.zone_id);
        zf.doc.post_ops = [...(zf.doc.post_ops ?? []), ...(op.ops as unknown as GenOp[])];
        if (!opts.dryRun) writeZoneFile(zf);
        result.modified.push(rel(zf.path));
        result.absPaths.push(zf.path);
        touched.add(op.zone_id);
        break;
      }

      case 'append_spawns': {
        // Re-validate at apply time (mirrors append_post_ops): spawn entries
        // are coordinate-free — `region` or nothing, never an `at`.
        for (const s of op.spawns) {
          const bad = SpawnEntrySchema.safeParse(s);
          if (!bad.success) {
            throw new Error(
              `[fileOps] ${op.zone_id}: invalid spawn entry ${JSON.stringify(s)} — ` +
              bad.error.issues.map((i) => i.message).join('; '),
            );
          }
        }
        const zf = readZoneFile(op.zone_id);
        zf.doc.spawns = [...(zf.doc.spawns ?? []), ...(op.spawns as ZoneSpawn[])];
        if (!opts.dryRun) writeZoneFile(zf);
        result.modified.push(rel(zf.path));
        result.absPaths.push(zf.path);
        touched.add(op.zone_id);
        break;
      }

      case 'append_features': {
        const zf = readZoneFile(op.zone_id);
        const cur = zf.doc.features;
        if (cur && !Array.isArray(cur)) {
          // Override-map form: enable each feature with biome defaults.
          for (const f of op.features) if (!(f in cur)) cur[f] = true;
          zf.doc.features = cur;
        } else {
          // Array (or absent) form: append ids, de-duped.
          const existing = new Set(cur ?? []);
          const merged = [...(cur ?? [])];
          for (const f of op.features) if (!existing.has(f)) { merged.push(f); existing.add(f); }
          zf.doc.features = merged;
        }
        if (!opts.dryRun) writeZoneFile(zf);
        result.modified.push(rel(zf.path));
        result.absPaths.push(zf.path);
        touched.add(op.zone_id);
        break;
      }

      case 'patch_spawn_weights': {
        const zf = readZoneFile(op.zone_id);
        zf.doc.spawn_weights = { ...(zf.doc.spawn_weights ?? {}), ...op.weights };
        if (!opts.dryRun) writeZoneFile(zf);
        result.modified.push(rel(zf.path));
        result.absPaths.push(zf.path);
        touched.add(op.zone_id);
        break;
      }

      case 'patch_zone_field': {
        if (op.field === 'level_band') {
          const parsed = LevelBandSchema.safeParse(op.value);
          if (!parsed.success) {
            throw new Error(`[fileOps] ${op.zone_id}: level_band must be { tier, minLevel, maxLevel } — ${parsed.error.message}`);
          }
        } else if (typeof op.value !== 'string' || !op.value) {
          throw new Error(`[fileOps] ${op.zone_id}: display_name must be a non-empty string.`);
        }
        const zf = readZoneFile(op.zone_id);
        (zf.doc as Record<string, unknown>)[op.field] = op.value;
        if (!opts.dryRun) writeZoneFile(zf);
        result.modified.push(rel(zf.path));
        result.absPaths.push(zf.path);
        touched.add(op.zone_id);
        break;
      }
    }
  }

  result.touchedZones = [...touched];
  // De-dup path lists while preserving order.
  result.created = [...new Set(result.created)];
  result.modified = [...new Set(result.modified)];
  result.absPaths = [...new Set(result.absPaths)];
  return result;
}
