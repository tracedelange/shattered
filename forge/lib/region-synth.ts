// Region synthesis primitive — takes a RegionSpec from Tier 1 (grow mode) and
// lays out real GrownZoneNode objects stitched to the existing graph at the seam.
//
// Phase 2 (branching shapes): instead of a straight row, the region is a SPINE
// with BRANCHES. Non-`side` roles (approach → gate → dungeon → reward) form the
// spine, extending away from the seam in its open direction. `side` roles hang
// perpendicular off interior spine zones (a treasure vault / dead-end shrine).
// This is what makes a region read as a place, not "boxes in a ring".
//
// Per zone:
//   - a coordinate-based id (zone_X_Y) compatible with the stager's coordsOf()
//   - a level_band that RAMPS up with depth from the seam
//   - links derived from cardinal adjacency (spine sequence + branch-to-anchor +
//     a link back across the seam)
//
// The output array stays index-aligned with spec.zones (the caller maps role/note
// back by index), even though placement order is spine-first then branches.

import { type RegionSpec } from './schemas.ts';
import { type GrownZoneNode, type GrownGraph, coordsOf } from '../grow/worldState.ts';

export interface SynthResult {
  newZones: GrownZoneNode[];
  /** The seam zone's updated links (adds a link to each new zone bordering it). */
  seamLinks: string[];
}

type Vec = [number, number];
const N: Vec = [0, -1], S: Vec = [0, 1], E: Vec = [1, 0], W: Vec = [-1, 0];
// Preference order when choosing the spine's growth direction off the seam.
const DIR_PREF: Vec[] = [N, E, W, S];
const CARDINALS: Vec[] = [N, S, E, W];

const idFor = (c: Vec): string => `zone_${c[0]}_${c[1]}`;
const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k];

export function synthesizeRegion(
  spec: RegionSpec,
  graph: GrownGraph,
  growthStep: number,
): SynthResult {
  const seam = graph.zones.find((z) => z.id === spec.seam_zone);
  if (!seam) throw new Error(`seam zone "${spec.seam_zone}" not in graph`);

  const seamCoords = coordsOf(seam.id);
  if (!seamCoords) throw new Error(`seam zone "${spec.seam_zone}" has non-coordinate id`);

  const existingIds = new Set(graph.zones.map((z) => z.id));
  const regionId = `region_g${growthStep}`;

  // Grow in the seam's first OPEN cardinal direction (prefer north). The spine
  // marches that way; branches hang off the two perpendicular directions.
  const dir = DIR_PREF.find((d) => !existingIds.has(idFor(add(seamCoords, d)))) ?? N;
  const perps: Vec[] = dir[1] !== 0 ? [E, W] : [N, S]; // perpendicular to the spine

  // Partition indices, preserving spec order. Spine = everything that isn't a
  // pure branch; sides branch off it.
  const spineIdx = spec.zones.map((z, i) => (z.role === 'side' ? -1 : i)).filter((i) => i >= 0);
  const sideIdx = spec.zones.map((z, i) => (z.role === 'side' ? i : -1)).filter((i) => i >= 0);
  if (spineIdx.length === 0) spineIdx.push(0); // degenerate spec guard: anchor something

  const placed: Vec[] = new Array(spec.zones.length);
  const depth: number[] = new Array(spec.zones.length).fill(1);
  const occupied = new Set(existingIds);

  // ── Spine: step away from the seam, one zone per step ────────────────────────
  spineIdx.forEach((idx, k) => {
    const c = add(seamCoords, dir, k + 1);
    if (existingIds.has(idFor(c))) {
      throw new Error(`region synthesis: spine cell ${idFor(c)} already exists — seam ${seam.id} is blocked in that direction; try another seam`);
    }
    placed[idx] = c;
    depth[idx] = k + 1;
    occupied.add(idFor(c));
  });

  // ── Branches: hang each side zone off an interior spine anchor ───────────────
  // Prefer gate/dungeon anchors (the "interesting" middle of the spine).
  const anchorPool = spineIdx.filter((i) => spec.zones[i]!.role === 'gate' || spec.zones[i]!.role === 'dungeon');
  const anchors = anchorPool.length ? anchorPool : spineIdx;
  sideIdx.forEach((idx, s) => {
    const anchorIdx = anchors[s % anchors.length]!;
    const ac = placed[anchorIdx]!;
    const perp = perps[s % perps.length]!;
    placed[idx] = freeCellOutward(ac, perp, occupied);
    depth[idx] = depth[anchorIdx]!; // a side pocket sits at its anchor's difficulty
    occupied.add(idFor(placed[idx]!));
  });

  // ── Build zones (index-aligned with spec) + adjacency-derived links ──────────
  const newIds = new Set(placed.map(idFor));
  const maxDepth = spineIdx.length;
  const newZones: GrownZoneNode[] = spec.zones.map((specZone, i) => {
    const c = placed[i]!;
    const id = idFor(c);
    const links = CARDINALS
      .map((d) => idFor(add(c, d)))
      .filter((nid) => newIds.has(nid) || nid === seam.id); // siblings + back across the seam
    return {
      id,
      biome: specZone.biome,
      seed: `grown_${id}`,
      level_band: bandFor(depth[i]!, maxDepth, seam.level_band),
      links,
      features: [],
      growth_step: growthStep,
      region_id: regionId,
    };
  });

  // Seam gains a link to every new zone that borders it (normally just the spine root).
  const seamBorders = [...newIds].filter((nid) => {
    const c = coordsOf(nid);
    return c != null && CARDINALS.some((d) => idFor(add(seamCoords, d)) === nid);
  });
  const seamLinks = [...new Set([...seam.links, ...seamBorders])];

  return { newZones, seamLinks };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** First free cell stepping outward from `from` along `perp`, trying both signs
 *  at each distance before going further (so branches stay tight to the spine). */
function freeCellOutward(from: Vec, perp: Vec, occupied: Set<string>): Vec {
  for (let dist = 1; dist <= 8; dist++) {
    const a = add(from, perp, dist);
    if (!occupied.has(idFor(a))) return a;
    const b = add(from, perp, -dist);
    if (!occupied.has(idFor(b))) return b;
  }
  throw new Error('region synthesis: no free cell for a side branch near the spine');
}

function bandFor(
  depth: number,
  maxDepth: number,
  seam: GrownZoneNode['level_band'],
): GrownZoneNode['level_band'] {
  const progress = maxDepth <= 1 ? 0 : (depth - 1) / (maxDepth - 1); // 0 (root) → 1 (deepest)
  const ramp = Math.round(progress * 20);                            // +20 levels across the region
  return { tier: seam.tier, minLevel: seam.minLevel + ramp, maxLevel: seam.maxLevel + ramp };
}
