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
  /** True when width/height were bumped because seed-retry alone couldn't clear all warnings. */
  resized: boolean;
  attempts: number;
  inaccessibleTiles: number;
  accessibleDefaultTiles: number;
  /** Count of [mapgen] console warnings emitted during generation (stamp failures, unresolved routes, etc.). */
  warnings: number;
  /** Final width written to the stub (undefined = zone uses the engine default). */
  width: number | undefined;
  /** Final height written to the stub (undefined = zone uses the engine default). */
  height: number | undefined;
}

const score = (e: { inaccessibleTiles: number; accessibleDefaultTiles: number; warnings: number }): number =>
  e.inaccessibleTiles + e.accessibleDefaultTiles + e.warnings;

/**
 * Temporarily replaces console.warn to count [mapgen] warning lines emitted
 * during `fn()`. Restores the original after, even on throw.
 */
function captureMapgenWarnings<T>(fn: () => T): { result: T; warnings: number } {
  let warnings = 0;
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[mapgen]')) warnings++;
    orig.apply(console, args as Parameters<typeof orig>);
  };
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = orig;
  }
}

const DEFAULT_GRID_W = 40;
const DEFAULT_GRID_H = 30;
const SIZE_BUMP = 10;
const MAX_SIZE_BUMPS = 2;

/**
 * Retry a freshly created stub with bumped seed suffixes (`_v2` … `_v{1+max}`)
 * and keep the seed with the fewest structural issues (inaccessible tiles,
 * exposed background, and [mapgen] placement warnings). If the best seed still
 * has issues, incrementally widens the zone by SIZE_BUMP tiles in each
 * dimension (up to MAX_SIZE_BUMPS times) and retries seeds against the larger
 * canvas. Writes the stub file in place when a better seed or size is found.
 *
 * @param zoneId      Zone whose stub lives at world/zones/<id>.json.
 * @param worldDir    Absolute world/ directory (for biome-params.json).
 * @param tilesets    Loaded tilesets, keyed by name.
 * @param prefabs     Named prefab registry (post_ops stamps need it).
 * @param maxRetries  Candidate seeds to try per size tier. Default 4.
 */
export function repairZoneBySeedRetry(
  zoneId: string,
  worldDir: string,
  tilesets: Record<string, Tileset>,
  prefabs: Record<string, Prefab>,
  maxRetries = 4,
): SeedRepairResult {
  const stubPath = join(worldDir, 'zones', `${zoneId}.json`);
  const stub = JSON.parse(readFileSync(stubPath, 'utf8')) as ZoneDef & { seed?: string; width?: number; height?: number };
  const overrides = loadBiomeParamOverrides(worldDir);

  const evaluate = (seed: string, width?: number, height?: number) => {
    const candidate = { ...stub, seed, ...(width ? { width } : {}), ...(height ? { height } : {}) };
    const resolved = resolveBiomeOps(candidate, overrides, prefabs);
    const tileset = tilesets[resolved.tileset ?? 'overworld'];
    if (!tileset) throw new Error(`[zoneRepair] ${zoneId}: tileset '${resolved.tileset}' not loaded`);
    const { result, warnings } = captureMapgenWarnings(() => evaluateZoneStructure(resolved, tileset, prefabs));
    return { ...result, warnings };
  };

  const currentSeed = stub.seed ?? `${zoneId}_v1`;
  const base = currentSeed.replace(/_v\d+$/, '');
  let best = { seed: currentSeed, width: stub.width, height: stub.height, ...evaluate(currentSeed, stub.width, stub.height) };
  let attempts = 0;

  // Phase 1: seed retry at current size
  if (score(best) > 0) {
    for (let n = 2; n <= 1 + maxRetries; n++) {
      const seed = `${base}_v${n}`;
      if (seed === currentSeed) continue;
      attempts++;
      const e = evaluate(seed, stub.width, stub.height);
      if (score(e) < score(best)) best = { seed, width: stub.width, height: stub.height, ...e };
      if (score(best) === 0) break;
    }
  }

  // Phase 2: size bumps when seed retry alone didn't clear all issues
  if (score(best) > 0) {
    const baseW = stub.width ?? DEFAULT_GRID_W;
    const baseH = stub.height ?? DEFAULT_GRID_H;
    for (let bump = 1; bump <= MAX_SIZE_BUMPS && score(best) > 0; bump++) {
      const bumpW = baseW + bump * SIZE_BUMP;
      const bumpH = baseH + bump * SIZE_BUMP;
      for (let n = 1; n <= 1 + maxRetries; n++) {
        const seed = n === 1 ? best.seed : `${base}_v${n + maxRetries * bump}`;
        attempts++;
        const e = evaluate(seed, bumpW, bumpH);
        if (score(e) < score(best)) best = { seed, width: bumpW, height: bumpH, ...e };
        if (score(best) === 0) break;
      }
    }
  }

  const reseeded = best.seed !== currentSeed;
  const resized = (best.width ?? undefined) !== stub.width || (best.height ?? undefined) !== stub.height;
  if (reseeded || resized) {
    stub.seed = best.seed;
    if (best.width != null) stub.width = best.width;
    if (best.height != null) stub.height = best.height;
    writeFileSync(stubPath, JSON.stringify(stub, null, 2) + '\n', 'utf8');
  }
  return { zoneId, reseeded, resized, attempts, ...best };
}
