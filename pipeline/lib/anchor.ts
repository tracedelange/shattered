// Anchor selection — shared by the gardener (per-pass auto-anchor) and the loop
// (sticky-saturation rotation). An "anchor" is the settlement whose radius-N
// neighborhood a run focuses on; development emerges region-by-region rather
// than as a thin global wash.

import type { WorldDefs } from '../../shared/types.ts';
import { isSettlement, type WorldMetrics } from './worldMetrics.ts';

// Undirected adjacency over the connections graph. Edges are treated as
// UNDIRECTED: sub-zones (caves, sewers, dens) link only back up to their parent
// via a non-cardinal key, and loadWorld doesn't add the reverse link (the
// engine synthesizes that portal at runtime). Walking the reverse edge here
// pulls those sub-zones in. Cardinal links are already symmetric, so this
// changes nothing for the overworld grid.
function buildAdjacency(defs: WorldDefs): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  };
  for (const [id, zone] of Object.entries(defs.zones)) {
    for (const target of Object.values(zone.connections ?? {})) {
      if (!target) continue;
      link(id, target);
      link(target, id);
    }
  }
  return adj;
}

// BFS the connections graph from anchorId, up to `radius` hops.
export function buildNeighborhood(defs: WorldDefs, anchorId: string, radius: number): Set<string> {
  const adj = buildAdjacency(defs);
  const neighborhood = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: anchorId, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (neighborhood.has(item.id)) continue;
    if (!defs.zones[item.id]) continue;
    neighborhood.add(item.id);
    if (item.depth >= radius) continue;
    for (const neighborId of adj.get(item.id) ?? []) {
      if (!neighborhood.has(neighborId)) {
        queue.push({ id: neighborId, depth: item.depth + 1 });
      }
    }
  }
  return neighborhood;
}

/** Hop-distance from `center` to every reachable zone (BFS, unbounded).
 *  Zones in a disconnected component are absent from the map. */
export function centerDistances(defs: WorldDefs, center: string): Map<string, number> {
  const adj = buildAdjacency(defs);
  const dist = new Map<string, number>();
  if (!defs.zones[center]) return dist;
  const queue: string[] = [center];
  dist.set(center, 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = dist.get(id)!;
    for (const neighborId of adj.get(id) ?? []) {
      if (!dist.has(neighborId) && defs.zones[neighborId]) {
        dist.set(neighborId, d + 1);
        queue.push(neighborId);
      }
    }
  }
  return dist;
}

/** Total development across a neighborhood (sum of per-zone development score). */
export function neighborhoodDevScore(neighborhood: Set<string>, metrics: WorldMetrics): number {
  const devById = new Map(metrics.zones.map((z) => [z.id, z.development]));
  let score = 0;
  for (const id of neighborhood) score += devById.get(id) ?? 0;
  return score;
}

export interface AnchorPick {
  anchorId: string;
  score: number;
  /** Hop-distance from the center (0 when no center given). */
  distance: number;
}

/**
 * Choose the next settlement to anchor on.
 *
 * - With a `center`: STRICT outward expansion — primary sort is hop-distance
 *   from the center (nearest first), tie-broken by least development, then id.
 *   Growth radiates ring-by-ring from the starting village; a far empty region
 *   is never developed before a closer one.
 * - Without a `center`: least-developed neighborhood globally (the gardener's
 *   per-pass behavior), tie-broken by id.
 *
 * `exclude` skips already-saturated settlements (sticky loop). Returns null
 * when no eligible settlement remains.
 */
export function pickAutoAnchor(
  defs: WorldDefs,
  metrics: WorldMetrics,
  radius: number,
  opts: { exclude?: Set<string>; center?: string | null } = {},
): AnchorPick | null {
  const exclude = opts.exclude ?? new Set<string>();
  const settlements = Object.values(defs.zones).filter(isSettlement).filter((s) => !exclude.has(s.id));
  if (settlements.length === 0) return null;

  const dist = opts.center ? centerDistances(defs, opts.center) : null;

  let best: AnchorPick | null = null;
  for (const s of settlements) {
    const hood = buildNeighborhood(defs, s.id, radius);
    const score = neighborhoodDevScore(hood, metrics);
    const distance = dist ? (dist.get(s.id) ?? Infinity) : 0;
    const cand: AnchorPick = { anchorId: s.id, score, distance };
    if (best === null || isBetter(cand, best)) best = cand;
  }
  return best;
}

// Lower distance wins; then lower dev score; then lexicographically smaller id.
function isBetter(a: AnchorPick, b: AnchorPick): boolean {
  if (a.distance !== b.distance) return a.distance < b.distance;
  if (a.score !== b.score) return a.score < b.score;
  return a.anchorId < b.anchorId;
}

/**
 * Frontier selection for outward world fill (sticky loop). Returns the
 * undeveloped zone (development score 0) of ANY type — wilderness or an
 * undeveloped settlement — nearest the center in connection hops, tie-broken
 * by id. As the developed blob grows, the chosen zone's score rises above 0
 * and the frontier moves one ring outward.
 *
 * `exclude` skips zones already marked saturated (so a dead zone the gardener
 * couldn't develop — score still 0 — isn't re-picked forever). Zones in a
 * component disconnected from the center are unreachable and never chosen.
 * Returns null when no reachable undeveloped zone remains.
 */
export function pickFrontierAnchor(
  defs: WorldDefs,
  metrics: WorldMetrics,
  center: string,
  exclude: Set<string> = new Set(),
): AnchorPick | null {
  const devById = new Map(metrics.zones.map((z) => [z.id, z.development]));
  const dist = centerDistances(defs, center);

  let best: AnchorPick | null = null;
  for (const id of Object.keys(defs.zones)) {
    if (exclude.has(id)) continue;
    if ((devById.get(id) ?? 0) !== 0) continue; // only the undeveloped frontier
    const distance = dist.get(id) ?? Infinity;
    if (!Number.isFinite(distance)) continue; // unreachable from center
    if (best === null || distance < best.distance || (distance === best.distance && id < best.anchorId)) {
      best = { anchorId: id, score: 0, distance };
    }
  }
  return best;
}
