// Validated shape for LLM-created zone files (Implementor v2).
//
// New zones are biome stubs: the biome pipeline owns the grid, so a zone file
// written by the Implementor may only carry identity, difficulty, connection,
// and content fields. The schema is strict() so anything else is rejected —
// most importantly `ops` / `width` / `height` / `default_tile` / `tileset`,
// which would bypass the frozen generation pipeline (the cellar_21_12 failure
// mode: a hand-authored op-list zone masquerading as a stub).

import { basename } from 'node:path';
import { z } from 'zod';
import { BIOME_REGISTRY } from '../../server/game/mapgen/biomes/index.ts';
import type { ZoneDef } from '../../shared/types.ts';

export const LevelBandSchema = z.object({
  tier: z.number().int().min(1).max(5),
  minLevel: z.number().int(),
  maxLevel: z.number().int(),
});

// Coordinate boundary: `at` placement is deliberately absent — LLM spawns are
// region-based (or zone-wide scatter when region is omitted).
const StubSpawnSchema = z.object({
  entity: z.string().min(1),
  region: z.string().min(1).optional(),
  count: z.number().int().positive().optional(),
  respawn_seconds: z.number().positive().optional(),
  spawn_id: z.string().min(1).optional(),
}).strict();

const SpawnPointSchema = z.union([
  z.object({ focal: z.literal(true) }).strict(),
  z.object({ region: z.string().min(1) }).strict(),
]);

export const NewZoneStubSchema = z.object({
  id: z.string().min(1),
  biome: z.string().refine((b) => b in BIOME_REGISTRY, {
    message: `biome must be one of: ${Object.keys(BIOME_REGISTRY).sort().join(', ')}`,
  }),
  seed: z.string().min(1),
  display_name: z.string().optional(),
  name: z.string().optional(),
  level_band: LevelBandSchema.optional(),
  spawn_point: SpawnPointSchema.optional(),
  connections: z.record(z.string(), z.string()).optional(),
  spawn_weights: z.record(z.string(), z.number()).optional(),
  features: z.union([
    z.array(z.string()),
    z.record(z.string(), z.unknown()),
  ]).optional(),
  post_ops: z.array(z.record(z.string(), z.unknown())).optional(),
  spawns: z.array(StubSpawnSchema).optional(),
  tags: z.array(z.string()).optional(),
}).strict();

export type NewZoneStub = z.infer<typeof NewZoneStubSchema>;

/**
 * Parse and validate an LLM-written zone file body. Throws with a repairable
 * message on JSON parse failure, schema violation, or id/filename mismatch.
 * Returns the parsed stub so callers can run further checks (e.g. the
 * coordinate boundary on post_ops).
 */
export function validateZoneStub(relPath: string, content: string): NewZoneStub {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`[zoneStub] ${relPath}: not valid JSON — ${(err as Error).message}`);
  }
  const result = NewZoneStubSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `[zoneStub] ${relPath}: zone files are biome stubs (id, biome, seed, ` +
      `display_name, level_band, spawn_point, connections, spawn_weights, ` +
      `features, post_ops, spawns). The grid is generated from biome+seed — ` +
      `ops/width/height/default_tile/tileset are not allowed.\n${issues}`,
    );
  }
  const expectedId = basename(relPath).replace(/\.json$/, '');
  if (result.data.id !== expectedId) {
    throw new Error(`[zoneStub] ${relPath}: id '${result.data.id}' must match filename '${expectedId}'`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// NewZoneSpec — the minimal shape the LLM emits for a zone_connect sub-zone.
// Everything mechanical (seed, spawn_point, connections, level_band) is
// derived by the host in buildZoneStubFromSpec; the model supplies only the
// creative fields. Spawns are zone-wide by construction: the generated region
// names of a zone that does not exist yet are unknowable.
// ---------------------------------------------------------------------------

const SpecSpawnSchema = z.object({
  entity: z.string().min(1),
  count: z.number().int().positive().optional(),
  respawn_seconds: z.number().positive().optional(),
  spawn_id: z.string().min(1).optional(),
}).strict();

export const NewZoneSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  biome: z.string().refine((b) => b in BIOME_REGISTRY, {
    message: `biome must be one of: ${Object.keys(BIOME_REGISTRY).sort().join(', ')}`,
  }),
  display_name: z.string().min(1),
  /** The existing zone this sub-zone hangs off. Must exist in the world. */
  parent_zone: z.string().min(1),
  /** Non-cardinal connection label naming the way back (default "surface"). */
  connection_label: z.string().regex(/^(?!north$|south$|east$|west$)[a-z_]+$/, {
    message: 'connection_label must be a non-cardinal snake_case label (e.g. surface, cellar)',
  }).optional(),
  /** Explicit band, or omit to inherit the parent zone's. */
  level_band: LevelBandSchema.optional(),
  spawn_weights: z.record(z.string(), z.number()).optional(),
  spawns: z.array(SpecSpawnSchema).optional(),
  /** One sentence for the lore bible; the host builds the rest of the entry. */
  lore_summary: z.string().min(1),
}).strict();

export type NewZoneSpec = z.infer<typeof NewZoneSpecSchema>;

/**
 * Derive the full on-disk stub from a NewZoneSpec and its parent zone def.
 * Pure: returns the stub object; the caller serializes and writes it.
 */
export function buildZoneStubFromSpec(spec: NewZoneSpec, parent: ZoneDef): NewZoneStub {
  return {
    id: spec.id,
    biome: spec.biome,
    seed: `${spec.id}_v1`,
    display_name: spec.display_name,
    ...(spec.level_band ?? parent.level_band
      ? { level_band: spec.level_band ?? parent.level_band }
      : {}),
    spawn_point: { focal: true },
    connections: { [spec.connection_label ?? 'surface']: spec.parent_zone },
    ...(spec.spawn_weights ? { spawn_weights: spec.spawn_weights } : {}),
    ...(spec.spawns ? { spawns: spec.spawns } : {}),
  };
}
