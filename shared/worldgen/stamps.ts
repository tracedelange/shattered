// Wild/overworld stamp primitives — compact, pure, pointwise procedural shapes
// that paint tiles on top of the continuous field (see field.ts wildTileAt).
//
// A stamp is a small JSON-serializable DESCRIPTOR, not a materialized tile map:
// membership is evaluated on demand as a pure function of (x, y), exactly like
// the field itself. So a grove that would be ~7k baked tiles is a handful of
// bytes in the atlas, computed identically on client + server (the determinism
// contract holds because both sides run this same code on the same descriptor).
//
// Stamps compose in order — later stamps override earlier ones where they
// overlap (paint semantics), so e.g. a `blob` of trees plus a few `line`
// clearings gives a grove with paths carved through it. These are the reusable
// building blocks for future authored wilderness features (thickets, ponds,
// rock outcrops, roads, ruins…).

import { octaveNoise } from './noise.ts';

/** An organic filled disc: paints `tile` inside a radius whose edge is perturbed
 *  by noise, so it reads as a ragged natural blob rather than a clean circle.
 *  feather = 0 gives a hard circle. The workhorse for groves/thickets/ponds. */
export interface BlobStamp {
  kind: 'blob';
  cx: number;
  cy: number;
  /** Nominal radius; the edge thins out across [radius-feather, radius+feather]. */
  radius: number;
  /** Width of the ragged edge band (0 = hard circle). */
  feather: number;
  /** Edge-noise lobe size (bigger = broader, smoother lobes). */
  noiseScale: number;
  seed: number;
  tile: string;
}

/** A straight thick segment: paints `tile` within `half` tiles of the line from
 *  (x0,y0) to (x1,y1) — a road, corridor, or a mouth carved through a blob. */
export interface LineStamp {
  kind: 'line';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Half-width → (2*half + 1) tiles thick. */
  half: number;
  tile: string;
}

export type WildStamp = BlobStamp | LineStamp;

function blobCovers(s: BlobStamp, x: number, y: number): boolean {
  const d = Math.hypot(x - s.cx, y - s.cy);
  if (s.feather <= 0) return d <= s.radius;
  const inner = s.radius - s.feather;
  if (d <= inner) return true;
  if (d > s.radius + s.feather) return false;
  // Across the feather band the required noise value ramps 0→1, so trees thin
  // from solid at the core edge to sparse at the rim.
  const t = (d - inner) / (2 * s.feather);
  return octaveNoise(x, y, 4, s.noiseScale, 0.5, 2, s.seed) > t;
}

function lineCovers(s: LineStamp, x: number, y: number): boolean {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - s.x0) * dx + (y - s.y0) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = s.x0 + t * dx;
  const py = s.y0 + t * dy;
  return Math.hypot(x - px, y - py) <= s.half;
}

/** Topmost stamp covering (x,y) wins (paint order). Returns the tile id, or null
 *  if no stamp covers the point (fall through to the field). */
export function stampTileAt(x: number, y: number, stamps: readonly WildStamp[]): string | null {
  let out: string | null = null;
  for (const s of stamps) {
    if (s.kind === 'blob' ? blobCovers(s, x, y) : lineCovers(s, x, y)) out = s.tile;
  }
  return out;
}
