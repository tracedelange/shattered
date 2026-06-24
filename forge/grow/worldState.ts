// forge/grow/worldState.ts — types and I/O for the persistent grown-world state.
//
// world-grown/ layout (all files here are grown artifacts, not forge run artifacts):
//   graph.json       append-only zone graph; the growable artifact
//   blueprint.json   cumulative storyline + lore + per-region records
//   grammar/         living library (archetypes.yaml, factions.yaml); frozen per step
//   zones/           staged ZoneDef files, accumulating
//   entities/        staged mob/item bodies, accumulating
//   quests/          staged quest bodies, accumulating
//   prefabs/         symlink → world/prefabs (shared)
//   abilities/       symlink → world/abilities (shared)
//   tilesets/        symlink → world/tilesets (shared)
//   biome-params.json symlink → world/biome-params.json (shared)
//
// graph.json is a superset of ZoneGraphSchema — same zone node shape, plus
// grow-mode metadata per zone.  blueprint.json is the Tier-1 "story so far."

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ZoneNodeSchema } from '../lib/seeds.ts';

// ── Graph ─────────────────────────────────────────────────────────────────────

export const GrownZoneNodeSchema = ZoneNodeSchema.extend({
  /** Which growth step added this zone (0 = seed). */
  growth_step: z.number().int().min(0).default(0),
  /** Region id this zone belongs to (undefined on seed zones). */
  region_id: z.string().optional(),
});

export const GrownGraphSchema = z.object({
  /** Monotonically increasing; 0 = the seed world. */
  generation: z.number().int().min(0),
  seeded_at: z.string(),
  zones: z.array(GrownZoneNodeSchema),
});

export type GrownZoneNode = z.infer<typeof GrownZoneNodeSchema>;
export type GrownGraph = z.infer<typeof GrownGraphSchema>;

// ── Blueprint ─────────────────────────────────────────────────────────────────

export const RegionRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  growth_step: z.number().int().min(1),
  seam_zone: z.string(),
  motif: z.string(),
  lore_paragraph: z.string(),
  zone_ids: z.array(z.string()),
});

export const GrownBlueprintSchema = z.object({
  initialized_at: z.string(),
  storyline: z.string(),
  /** Ordered lore additions, one entry per grow step. */
  lore_history: z.array(z.string()),
  regions: z.array(RegionRecordSchema),
});

export type RegionRecord = z.infer<typeof RegionRecordSchema>;
export type GrownBlueprint = z.infer<typeof GrownBlueprintSchema>;

// ── I/O ───────────────────────────────────────────────────────────────────────

export interface GrownWorldState {
  graph: GrownGraph;
  blueprint: GrownBlueprint;
  worldDir: string;
}

export function grownWorldDir(): string {
  // Allow override for testing; default to <repo-root>/world-grown/.
  if (process.env.GROWN_WORLD_DIR) return process.env.GROWN_WORLD_DIR;
  // __dirname is forge/grow/, so repo root is two levels up.
  return join(import.meta.dirname, '..', '..', 'world-grown');
}

export function isInitialized(worldDir: string): boolean {
  return existsSync(join(worldDir, 'graph.json')) && existsSync(join(worldDir, 'blueprint.json'));
}

export function loadGrownState(worldDir?: string): GrownWorldState {
  const dir = worldDir ?? grownWorldDir();
  const graph = GrownGraphSchema.parse(
    JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')),
  );
  const blueprint = GrownBlueprintSchema.parse(
    JSON.parse(readFileSync(join(dir, 'blueprint.json'), 'utf8')),
  );
  return { graph, blueprint, worldDir: dir };
}

export function saveGraph(worldDir: string, graph: GrownGraph): void {
  writeFileSync(join(worldDir, 'graph.json'), JSON.stringify(graph, null, 2));
}

export function saveBlueprint(worldDir: string, blueprint: GrownBlueprint): void {
  writeFileSync(join(worldDir, 'blueprint.json'), JSON.stringify(blueprint, null, 2));
}

/** Zones on the frontier: have at least one cardinal direction with no neighbor.
 *  Uses coordinate arithmetic on zone_X_Y ids (supports negative coords for
 *  northward growth). Seed zones have no "forward links" to non-existent zones, so
 *  the simpler link-based check misses them — this coord-based check catches all. */
export function frontierZones(graph: GrownGraph): GrownZoneNode[] {
  const ids = new Set(graph.zones.map((z) => z.id));
  const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  return graph.zones.filter((z) => {
    const c = coordsOf(z.id);
    if (!c) return false;
    return DIRS.some(([dx, dy]) => !ids.has(`zone_${c[0] + dx}_${c[1] + dy}`));
  });
}

/** Parse zone_X_Y id into [X, Y] coords. Supports negative values. */
export function coordsOf(id: string): [number, number] | null {
  const m = id.match(/_(-?\d+)_(-?\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Derive cardinal connections from a zone's link list (mirrors forge/stage.ts). */
export function connectionsFor(zoneId: string, links: string[]): Record<string, string> {
  const self = coordsOf(zoneId);
  if (!self) return {};
  const [x, y] = self;
  const out: Record<string, string> = {};
  for (const link of links) {
    const c = coordsOf(link);
    if (!c) continue;
    const dx = c[0] - x, dy = c[1] - y;
    if      (dx === 0 && dy === -1) out.north = link;
    else if (dx === 0 && dy === 1)  out.south = link;
    else if (dx === -1 && dy === 0) out.west  = link;
    else if (dx === 1  && dy === 0) out.east  = link;
  }
  return out;
}

// ── Zone + artifact staging ────────────────────────────────────────────────────

import { join as pathJoin, dirname as pathDirname } from 'node:path';
import { mkdirSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import yaml from 'js-yaml';

/** Write a zone definition JSON into world-grown/zones/. */
export function stageZoneDef(worldDir: string, zoneDef: Record<string, unknown>): void {
  const dir = pathJoin(worldDir, 'zones');
  mkdirSync(dir, { recursive: true });
  fsWriteFileSync(
    pathJoin(dir, `${String(zoneDef.id)}.json`),
    JSON.stringify(zoneDef, null, 2),
    'utf8',
  );
}

/** Write a YAML artifact (mob/item/quest/zone_enhance) into world-grown/. */
export function stageArtifact(worldDir: string, filename: string, content: unknown): void {
  const dst = pathJoin(worldDir, filename);
  mkdirSync(pathDirname(dst), { recursive: true });
  fsWriteFileSync(dst, yaml.dump(content, { lineWidth: -1, noRefs: true }), 'utf8');
}
