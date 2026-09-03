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

// ── Seam dithering ─────────────────────────────────────────────────────────
// pickTileVariant solves variation *within* a material. This solves the seam
// *between* two materials: without it every biome boundary is an axis-aligned
// staircase of 32px squares, because wildTileAt is pointwise and knows nothing
// about its neighbours.
//
// The trick is to spend no new art on it. A tile sitting next to a different
// ground material sometimes renders as that neighbour's material instead, so
// the two interlock in fingers rather than meeting on a straight line. It is
// purely cosmetic — the tile id the rest of the game sees (walkability,
// pathing, server truth) is untouched, which is exactly why only tiles opted
// in with TileEntry.blend may take part: swapping a blocking or decorative
// tile would draw a lie about where the player can walk.

const SEAM_DITHER_SALT = 0x5ea3d;

// Patch size (tiles) of the dither. Deliberately much smaller than
// TILE_VARIANT_PATCH_SCALE — variants want calm multi-tile patches, a seam
// wants short interlocking fingers — but still smooth rather than white
// noise, so swapped tiles clump into peninsulas instead of static.
const SEAM_DITHER_SCALE = 2.5;

// Swap probability for a tile completely surrounded by the other material.
// Below 1 so even the deepest tile of a seam keeps a little of its own
// material showing through.
const SEAM_DITHER_STRENGTH = 0.9;

// Neighbour offsets and their pull. An edge-sharing neighbour blends twice as
// hard as a corner-sharing one, so a tile touching the other material only at
// a diagonal barely ever swaps.
const SEAM_NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 2], [1, 0, 2], [0, 1, 2], [-1, 0, 2],
  [1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1],
];
const SEAM_WEIGHT_TOTAL = 12;

const seamSeeds = new Map<string, number>();

// Scratch tally, reused across calls — this runs for every visible tile every
// frame and a fresh Map per tile showed up immediately in the render profile.
// Safe because rendering is single-threaded and the tally never escapes.
const seamIds: string[] = new Array(8);
const seamWeights: number[] = new Array(8);

/** The material to *draw* at (x, y), which is `tileId` except in the dither
 *  band along a seam with another blendable material. `neighborAt(dx, dy)`
 *  returns the tile id at the given offset (any id is fine for off-map — a
 *  tile without `blend` simply never participates).
 *
 *  Deterministic in (x, y) alone, like pickTileVariant, so it is stable across
 *  re-renders, reconnects and camera movement without persisting anything. */
export function pickSeamTile(
  tileId: string, x: number, y: number, ts: Tileset,
  neighborAt: (dx: number, dy: number) => string,
): string {
  if (!ts.tiles[tileId]?.blend) return tileId;

  let distinct = 0;
  for (const [dx, dy, w] of SEAM_NEIGHBORS) {
    const n = neighborAt(dx, dy);
    if (n === tileId || !ts.tiles[n]?.blend) continue;
    let i = 0;
    while (i < distinct && seamIds[i] !== n) i++;
    if (i === distinct) { seamIds[i] = n; seamWeights[i] = 0; distinct++; }
    seamWeights[i] += w;
  }
  if (distinct === 0) return tileId;

  // Heaviest neighbouring material wins. Ties break on the first one seen,
  // which SEAM_NEIGHBORS pins to a fixed order, so the result stays
  // deterministic rather than depending on iteration luck.
  let best = 0;
  for (let i = 1; i < distinct; i++) if (seamWeights[i]! > seamWeights[best]!) best = i;
  const other = seamIds[best]!;

  // Seeded by the *destination* material, not the pair: each material gets its
  // own field, so grass encroaches on sand where grass's field is high and
  // sand encroaches on grass where sand's is. A shared field would slide the
  // whole boundary one way instead of interlocking it.
  let seed = seamSeeds.get(other);
  if (seed === undefined) {
    seed = (SEAM_DITHER_SALT ^ hashString(other)) >>> 0;
    seamSeeds.set(other, seed);
  }
  const p = (seamWeights[best]! / SEAM_WEIGHT_TOTAL) * SEAM_DITHER_STRENGTH;
  return valueNoise(x, y, SEAM_DITHER_SCALE, seed) < p ? other : tileId;
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
