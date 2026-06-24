// Region synthesis primitive — takes a RegionSpec from Tier 1 (grow mode) and
// lays out real GrownZoneNode objects stitched to the existing graph at the seam.
//
// Phase 1 (straight chain): new zones form a row at Y = seamY - 1 (one step
// north of the seam), spread east/west centered on the seam's X coordinate.
// Every new zone gets:
//   - a coordinate-based id (zone_X_Y) compatible with the stager's coordsOf()
//   - a level_band that RAMPS up from the seam's band across the region
//   - links within the east-west chain + links south to any existing neighbors
//
// The seam zone itself gets a new north link to whichever new zone sits directly
// above it — returned as `seamLinks` for the caller to patch and commit.

import { type RegionSpec } from './schemas.ts';
import { type GrownZoneNode, type GrownGraph, coordsOf } from '../grow/worldState.ts';

export interface SynthResult {
  newZones: GrownZoneNode[];
  /** The seam zone's updated links (adds a north link to the zone directly above). */
  seamLinks: string[];
}

export function synthesizeRegion(
  spec: RegionSpec,
  graph: GrownGraph,
  growthStep: number,
): SynthResult {
  const seam = graph.zones.find((z) => z.id === spec.seam_zone);
  if (!seam) throw new Error(`seam zone "${spec.seam_zone}" not in graph`);

  const seamCoords = coordsOf(seam.id);
  if (!seamCoords) throw new Error(`seam zone "${spec.seam_zone}" has non-coordinate id`);

  const [seamX, seamY] = seamCoords;
  const newY = seamY - 1; // one row north of the seam (closer to world edge)

  const n = spec.zones.length;
  const startX = seamX - Math.floor(n / 2); // center the chain on the seam's X
  const existingIds = new Set(graph.zones.map((z) => z.id));

  const regionId = `region_g${growthStep}`;

  const newZones: GrownZoneNode[] = spec.zones.map((specZone, i) => {
    const x = startX + i;
    const id = `zone_${x}_${newY}`;
    const links = buildLinks(i, n, startX, newY, seamY, existingIds);
    const level_band = levelBandFor(i, n, seam.level_band);
    return {
      id,
      biome: specZone.biome,
      seed: `grown_${id}`,
      level_band,
      links,
      features: [],
      growth_step: growthStep,
      region_id: regionId,
    };
  });

  // Patch seam: add north link to the new zone directly above it.
  const directNorthId = `zone_${seamX}_${newY}`;
  const hasDirectNorth = newZones.some((z) => z.id === directNorthId);
  const seamLinks = hasDirectNorth && !seam.links.includes(directNorthId)
    ? [...seam.links, directNorthId]
    : [...seam.links];

  return { newZones, seamLinks };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildLinks(
  i: number,
  n: number,
  startX: number,
  newY: number,
  seamY: number,
  existingIds: Set<string>,
): string[] {
  const x = startX + i;
  const links: string[] = [];
  if (i > 0)       links.push(`zone_${x - 1}_${newY}`); // west
  if (i < n - 1)   links.push(`zone_${x + 1}_${newY}`); // east
  const southId = `zone_${x}_${seamY}`;
  if (existingIds.has(southId)) links.push(southId);    // south into existing world
  return links;
}

function levelBandFor(
  i: number,
  n: number,
  seam: GrownZoneNode['level_band'],
): GrownZoneNode['level_band'] {
  const progress = n <= 1 ? 0 : i / (n - 1); // 0 (approach) → 1 (deepest)
  const ramp = Math.round(progress * 20);      // +20 levels across the region
  return { tier: seam.tier, minLevel: seam.minLevel + ramp, maxLevel: seam.maxLevel + ramp };
}
