// Shared tileset helpers. Both the client renderer (hex strings → canvas) and
// the pipeline PNG renderer (RGB tuples → raw pixels) need to read tile and
// sprite colors out of a Tileset. Keep that flatten-the-map logic here.
//
// Fallback colors are caller-specified — the client may want a less alarming
// default for missing sprites in-game, while the pipeline renderer wants
// magenta everywhere so missing assets shout at you in the PNG.

import type { Tileset } from './types.ts';
import { hashString, valueNoise } from './worldgen/noise.ts';

export function buildTileColorMap(ts: Tileset): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ts.tiles).map(([k, v]) => [k, v.color]),
  );
}

// Fixed salt — tile variant choice is a cosmetic rendering detail, not part of
// the world seed, so it doesn't need to vary per-world. Same (tileId, x, y)
// always picks the same variant, so it's stable across re-renders/reconnects
// without persisting anything.
const TILE_VARIANT_SALT = 0x7a11e;

// Feature size (tiles) of a variant "patch". Picking a variant per-tile from
// an independent per-position hash is white noise — every tile edge is a
// coin flip, so it reads as static/salt-and-pepper instead of organic ground.
// Sampling a smooth, low-frequency noise field instead (same valueNoise used
// for elevation/temperature) gives neighboring tiles correlated values, so a
// variant shows up as a multi-tile patch, the way real terrain actually
// varies. Bigger = calmer/larger patches; smaller = more frequent switching.
const TILE_VARIANT_PATCH_SCALE = 8;

// tileId → derived variant seed. Tile ids are a small fixed vocabulary.
const variantSeeds = new Map<string, number>();

/** Deterministic per-position variant index for a tile with a sprite-variant
 *  library (see TileEntry.variants). Both client and any future tooling that
 *  needs to agree on "which variant is this tile" (e.g. a world-gen preview)
 *  can call this and get the same answer.
 *
 *  `weights` (see TileEntry.variantWeights) skews which variant a given patch
 *  of noise lands on — e.g. make the busiest/most-distinctive variant rarer
 *  than the calm default — without reintroducing per-tile noise, since it's
 *  just a non-uniform split of the same smooth noise range. Omitted or
 *  mismatched length falls back to a uniform split. */
export function pickTileVariant(
  tileId: string, x: number, y: number, variantCount: number, weights?: number[],
): number {
  if (variantCount <= 1) return 0;
  // Memoized: this is called for every visible tile every frame, and hashing
  // the id string per call showed up as the hot path in the render loop.
  let seed = variantSeeds.get(tileId);
  if (seed === undefined) {
    seed = (TILE_VARIANT_SALT ^ hashString(tileId)) >>> 0;
    variantSeeds.set(tileId, seed);
  }
  const n = valueNoise(x, y, TILE_VARIANT_PATCH_SCALE, seed); // smooth [0, 1)

  if (!weights || weights.length !== variantCount) {
    return Math.min(variantCount - 1, Math.floor(n * variantCount));
  }
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const target = n * total;
  let acc = 0;
  for (let i = 0; i < variantCount; i++) {
    acc += weights[i]!;
    if (target < acc) return i;
  }
  return variantCount - 1; // floating-point edge case at target ≈ total
}

export function buildSpriteColorMap(ts: Tileset): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ts.sprites).map(([k, v]) => [k, v.color]),
  );
}

/** Parse "#rrggbb" (or "rrggbb") to an RGB tuple. Returns magenta on bad input. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [255, 0, 255];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
