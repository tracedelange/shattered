// Validated FileOp write layer (Implementor v2, engine change #6).
//
// The Implementor never calls writeFileSync directly. It emits a list of
// FileOps; this module validates each (prefab-grid rules, path safety) and
// applies them surgically. `append_features` is the primary mutation: it
// appends entries to an existing zone file's features array without rewriting
// the file, so the frozen biome pipeline fields are never touched. The engine
// compiles each entry into placement — the Implementor never authors ops or
// coordinates.

import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import { REPO_ROOT, WORLD_DIR } from './io.ts';
import { FeatureEntrySchema, LevelBandSchema, validateZoneStub } from './zoneStub.ts';
import { BIOME_REGISTRY } from '../../server/game/mapgen/biomes/index.ts';
import type { PrefabData, ZoneDef, ZoneSpawn } from '../../shared/types.ts';

// ── Unique-NPC dedup ─────────────────────────────────────────────────────────
// Named/singleton NPCs (mob template `unique: true`) must never be spawned more
// than once per zone. The Implementor can't always see the zone's existing
// inhabitants, so this is the deterministic backstop: append_spawns skips a
// unique entity that already exists (in the zone file or the biome defaults).
const uniqueEntityCache = new Map<string, boolean>();
function isUniqueEntity(entity: string): boolean {
  const cached = uniqueEntityCache.get(entity);
  if (cached !== undefined) return cached;
  let unique = false;
  const p = join(WORLD_DIR, 'entities', 'mobs', `${entity}.yaml`);
  if (existsSync(p)) {
    try {
      const t = yaml.load(readFileSync(p, 'utf8')) as Record<string, unknown> | null;
      unique = t?.unique === true;
    } catch { /* malformed template — treat as non-unique */ }
  }
  uniqueEntityCache.set(entity, unique);
  return unique;
}

// ── Schema ───────────────────────────────────────────────────────────────────

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
    op: z.literal('append_spawns'),
    zone_id: z.string().min(1),
    spawns: z.array(SpawnEntrySchema).min(1),
  }),
  z.object({
    op: z.literal('append_features'),
    zone_id: z.string().min(1),
    features: z.array(FeatureEntrySchema).min(1),
  }),
  z.object({
    op: z.literal('patch_zone_field'),
    zone_id: z.string().min(1),
    field: z.enum(['name', 'level_band']),
    value: z.unknown(),
  }),
]);

export type FileOp = z.infer<typeof FileOpSchema>;

// ── Validators ─────────────────────────────────────────────────────────────

// A prefab wider/taller than the largest biome grid can never be stamped into
// any zone, so reject it at create time rather than letting it silently fail
// to place at render. Derived from the registry so it tracks biome dims.
const MAX_PREFAB_W = Math.max(...Object.values(BIOME_REGISTRY).map((b) => b.width));
const MAX_PREFAB_H = Math.max(...Object.values(BIOME_REGISTRY).map((b) => b.height));

/** Validate a prefab grid: rectangular, sized to fit a zone, and every char in
 *  `data` covered by the legend (anchors are a subset of the legend;
 *  whitespace/newlines are skipped). Returns an error string, or null when valid. */
export function validatePrefabGrid(prefab: Pick<PrefabData, 'data' | 'legend'>): string | null {
  if (typeof prefab.data !== 'string' || !prefab.data.length) {
    return 'prefab.data must be a non-empty string';
  }
  const rows = prefab.data.replace(/\n+$/, '').split('\n');
  const width = rows[0]?.length ?? 0;
  if (width > MAX_PREFAB_W || rows.length > MAX_PREFAB_H) {
    return `prefab grid ${width}x${rows.length} exceeds the largest zone ` +
      `(${MAX_PREFAB_W}x${MAX_PREFAB_H}) — it could never be stamped. Shrink it.`;
  }
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
  /** Non-fatal notices (e.g. duplicate unique NPCs skipped by the dedup guard). */
  warnings: string[];
}

const rel = (abs: string): string => (abs.startsWith(REPO_ROOT) ? abs.slice(REPO_ROOT.length + 1) : abs);

/**
 * Validate and apply a list of FileOps. Throws on the first validation failure
 * (coordinate boundary, invalid prefab grid, unsafe path, missing zone) before
 * touching disk for that op. When `dryRun`, validates and reports without writing.
 */
export function applyFileOps(ops: FileOp[], opts: { dryRun?: boolean } = {}): FileOpResult {
  const result: FileOpResult = { created: [], modified: [], touchedZones: [], absPaths: [], warnings: [] };
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
          validateZoneStub(cleaned, op.content);
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

      case 'append_spawns': {
        // Re-validate at apply time: spawn entries are coordinate-free —
        // `region` or nothing, never an `at`.
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
        // Dedup guard: a `unique` NPC may exist either in the zone file or only
        // in the biome's defaultSpawns (merged at load), so check both.
        const biomeDef = zf.doc.biome ? BIOME_REGISTRY[zf.doc.biome] : undefined;
        const present = new Set<string>([
          ...(zf.doc.spawns ?? []).map((s) => s.entity),
          ...((biomeDef?.defaultSpawns ?? []).map((s) => s.entity)),
        ]);
        const toAdd: ZoneSpawn[] = [];
        for (const s of op.spawns as ZoneSpawn[]) {
          if (isUniqueEntity(s.entity) && present.has(s.entity)) {
            result.warnings.push(
              `[fileOps] ${op.zone_id}: skipped duplicate unique NPC '${s.entity}' (already present) — reuse the existing one.`,
            );
            continue;
          }
          toAdd.push(s);
          present.add(s.entity); // also dedup within this same op batch
        }
        if (toAdd.length === 0) break; // nothing new — leave the file untouched
        zf.doc.spawns = [...(zf.doc.spawns ?? []), ...toAdd];
        if (!opts.dryRun) writeZoneFile(zf);
        result.modified.push(rel(zf.path));
        result.absPaths.push(zf.path);
        touched.add(op.zone_id);
        break;
      }

      case 'append_features': {
        const zf = readZoneFile(op.zone_id);
        // Append entries, de-duped by id.
        const cur = zf.doc.features ?? [];
        const existing = new Set(cur.map((f) => (typeof f === 'string' ? f : f.id)));
        const merged = [...cur];
        for (const f of op.features) {
          const id = typeof f === 'string' ? f : f.id;
          if (!existing.has(id)) { merged.push(f); existing.add(id); }
        }
        zf.doc.features = merged;
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
          throw new Error(`[fileOps] ${op.zone_id}: name must be a non-empty string.`);
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
