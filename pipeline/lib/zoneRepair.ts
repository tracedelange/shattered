// Programmatic structural repair for newly created zone stubs.
//
// A stub's grid is a pure function of biome + seed, so when a generated zone
// has stranded walkable tiles or exposed background, the cheapest fix is a
// different seed — no LLM involved. This module retries deterministic seed
// suffixes, scores each candidate with the same walkability analysis the
// renderer uses, and persists the best one. Replaces the former render-repair
// LLM pass for run-created zones (existing zones are never touched: their
// seeds are frozen).

import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateZoneStructure } from './renderZone.ts';
import { loadBiomeParamOverrides, resolveBiomeOps } from '../../server/world/loader.ts';
import type { Prefab, Tileset, ZoneDef } from '../../shared/types.ts';

export interface SeedRepairResult {
  zoneId: string;
  /** Seed the zone ended up with (unchanged when no candidate beat it). */
  seed: string;
  /** True when the stub file was rewritten with a better seed. */
  reseeded: boolean;
  attempts: number;
  inaccessibleTiles: number;
  accessibleDefaultTiles: number;
}

const score = (e: { inaccessibleTiles: number; accessibleDefaultTiles: number }): number =>
  e.inaccessibleTiles + e.accessibleDefaultTiles;

/**
 * Retry a freshly created stub with bumped seed suffixes (`_v2` … `_v{1+max}`)
 * and keep the seed with the fewest structural issues. Writes the stub file
 * in place when a better seed is found. Returns the final state either way.
 *
 * @param zoneId      Zone whose stub lives at world/zones/<id>.json.
 * @param worldDir    Absolute world/ directory (for biome-params.json).
 * @param tilesets    Loaded tilesets, keyed by name.
 * @param prefabs     Named prefab registry (post_ops stamps need it).
 * @param maxRetries  Candidate seeds to try beyond the current one. Default 4.
 */
export function repairZoneBySeedRetry(
  zoneId: string,
  worldDir: string,
  tilesets: Record<string, Tileset>,
  prefabs: Record<string, Prefab>,
  maxRetries = 4,
): SeedRepairResult {
  const stubPath = join(worldDir, 'zones', `${zoneId}.json`);
  const stub = JSON.parse(readFileSync(stubPath, 'utf8')) as ZoneDef & { seed?: string };
  const overrides = loadBiomeParamOverrides(worldDir);

  const evaluate = (seed: string) => {
    const resolved = resolveBiomeOps({ ...stub, seed }, overrides);
    const tileset = tilesets[resolved.tileset ?? 'overworld'];
    if (!tileset) throw new Error(`[zoneRepair] ${zoneId}: tileset '${resolved.tileset}' not loaded`);
    return evaluateZoneStructure(resolved, tileset, prefabs);
  };

  const currentSeed = stub.seed ?? `${zoneId}_v1`;
  const base = currentSeed.replace(/_v\d+$/, '');
  let best = { seed: currentSeed, ...evaluate(currentSeed) };
  let attempts = 0;

  if (score(best) > 0) {
    for (let n = 2; n <= 1 + maxRetries; n++) {
      const seed = `${base}_v${n}`;
      if (seed === currentSeed) continue;
      attempts++;
      const e = evaluate(seed);
      if (score(e) < score(best)) best = { seed, ...e };
      if (score(best) === 0) break;
    }
  }

  const reseeded = best.seed !== currentSeed;
  if (reseeded) {
    stub.seed = best.seed;
    writeFileSync(stubPath, JSON.stringify(stub, null, 2) + '\n', 'utf8');
  }
  return { zoneId, seed: best.seed, reseeded, attempts, ...best };
}
