// Region atlas — the prebaked structural/semantic layer (docs/rework.md §5.2).
// Generated once server-side at world creation and shipped to clients as a
// static asset (R5.2a/R8.8). It is the single in-game MAP object and the
// engine's structural query surface.
//
// This module is PURE (no fs) so it bundles cleanly into the client. The
// server owns disk-caching + serving it (see server/game/wilderness.ts).
//
// For the vertical slice the atlas stores the settlement registry + danger
// parameters; danger itself is computable pointwise from origin (field.ts), so
// no per-cell danger bake is needed yet. Per-cell baking (allowed_axis_mask,
// macro elevation) is a reserved seam — see R5.2b.

import { resolveSeed } from './noise.ts';
import { DANGER_RADIUS, DEFAULT_WORLD_SEED, REGION_CELL_SIZE, WILD } from './config.ts';

/** A placed enclosed zone with a footprint on the wilderness field (R6.3). */
export interface Settlement {
  /** Enclosed-zone id this settlement maps to (e.g. 'zone_0_0'). */
  id: string;
  /** World-tile center of the settlement on the atlas. */
  worldX: number;
  worldY: number;
  /** The wilderness-side portal/gate tile (rendered as 'portal', walkable).
   *  Stepping onto it returns the player to this settlement's enclosed zone. */
  portalX: number;
  portalY: number;
  /** Discovery default for the slice — the central village is always known. */
  band: number;
}

export interface RegionAtlas {
  version: 1;
  seed: string;
  /** Numeric seed both sides resolve the field streams from. */
  numericSeed: number;
  cellSize: number;
  dangerRadius: number;
  settlements: Settlement[];
  /** Reserved (R5.2b/§10): per-cell allowed combat-axis mask, baked later. */
  // allowedAxisMask?: number[];
}

/**
 * Build the atlas deterministically from a seed. Pure — same seed → same atlas.
 * The slice places a single central village at origin whose enclosed zone is the
 * hand-authored starting village; the same registry supports N settlements at
 * higher bands with no structural change (R9.2).
 */
export function buildAtlas(
  seed: string = DEFAULT_WORLD_SEED,
  centralVillageZoneId = 'zone_0_0',
): RegionAtlas {
  return {
    version: 1,
    seed,
    numericSeed: resolveSeed(seed),
    cellSize: REGION_CELL_SIZE,
    dangerRadius: DANGER_RADIUS,
    settlements: [
      // Central village at origin; its wilderness gate sits a few tiles south so
      // the player steps out of town into the open and back through the same gate.
      { id: centralVillageZoneId, worldX: 0, worldY: 0, portalX: 0, portalY: 8, band: 0 },
    ],
  };
}

export { WILD };
