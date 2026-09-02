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
//
// It also stores STAMPS: compact procedural-shape descriptors (see stamps.ts)
// that wildTileAt paints on top of the field so a settlement reads as an authored
// place on both client and server. They are evaluated pointwise — not baked into
// a tile map — so a whole grove is a few bytes in the atlas, not thousands of
// entries. For the central village the stamps make a GROVE of trees at the wild
// origin with a cleared mouth on each cardinal side, so the four town exits
// emerge out of the treeline (the village reads as nestled inside the grove).
// This is the previously-reserved footprint seam (R6.3) — deterministic,
// JSON-serializable, consumed identically on both sides.

import type { Direction } from '../types.ts';
import { resolveSeed } from './noise.ts';
import { type WildStamp } from './stamps.ts';
import { DANGER_RADIUS, DEFAULT_WORLD_SEED, REGION_CELL_SIZE, WILD } from './config.ts';

/** A single walkable exit between a settlement's enclosed zone and the open
 *  wilderness. The player leaves town through the zone-side portal tile at
 *  (villageX, villageY) and lands on the wilderness gate tile (wildX, wildY);
 *  stepping back onto that gate returns them to (returnX, returnY) inside the
 *  zone (just inside the same gap they left through). One gate per cardinal
 *  direction gives the village exits in all four directions (R6.6). */
export interface Gate {
  dir: Direction;
  /** Wilderness gate tile — walkable `portal`, and the return trigger. */
  wildX: number;
  wildY: number;
  /** Zone-side portal tile (painted by a `portal` post-op in the zone JSON). */
  villageX: number;
  villageY: number;
  /** Where to drop the player inside the zone on return (just inside the gap). */
  returnX: number;
  returnY: number;
}

/** A placed enclosed zone with a footprint on the wilderness field (R6.3). */
export interface Settlement {
  /** Enclosed-zone id this settlement maps to (e.g. 'zone_0_0'). */
  id: string;
  /** World-tile center of the settlement on the atlas. */
  worldX: number;
  worldY: number;
  /** Primary wilderness gate (kept for callers that want a single representative
   *  gate, e.g. the client fog-of-war reveal). Mirrors gates[0]. */
  portalX: number;
  portalY: number;
  /** All wilderness exits for this settlement, one per open direction. */
  gates: Gate[];
  /** Discovery default for the slice — the central village is always known. */
  band: number;
}

/** Bump whenever the baked footprint/gate layout changes, so disk-cached
 *  atlases from a previous shape are rejected and rebuilt (see index.ts
 *  loadOrBuildAtlas). Otherwise a stale cache silently serves the old layout. */
export const ATLAS_REV = 4;

export interface RegionAtlas {
  version: 1;
  /** Content revision of the baked layout — see ATLAS_REV. */
  rev: number;
  seed: string;
  /** Numeric seed both sides resolve the field streams from. */
  numericSeed: number;
  cellSize: number;
  dangerRadius: number;
  settlements: Settlement[];
  /** Procedural stamps painted over the field by wildTileAt (see stamps.ts).
   *  Evaluated pointwise on both sides, so authored wilderness shapes cost a
   *  few descriptors here rather than a baked per-tile map. */
  stamps: WildStamp[];
  /** Reserved (R5.2b/§10): per-cell allowed combat-axis mask, baked later. */
  // allowedAxisMask?: number[];
}

// ── Grove geometry (wild-side, centered on origin) ────────────────────────────
// A large tree grove at the wild origin, expressed as stamps: one organic `blob`
// of trees plus one `line` clearing per cardinal axis carving a grass mouth so
// the town's four exits emerge out of the grove. The gate/portal sits inside each
// mouth, so the player steps through a gap in the trees into open wild.
const GROVE_R = 48;             // nominal grove radius (edge feathers ±FEATHER)
const FEATHER = 12;             // ragged treeline band width
const GROVE_NOISE_SCALE = 26;   // grove edge lobe size (bigger = broader blobs)
const MOUTH_HALF = 1;           // mouth half-width (→ 3-tile clearing)
const MOUTH_INNER = 4;          // how far the mouth cuts back inside the gate
const MOUTH_OUTER = FEATHER + 3;// how far the mouth clears past the gate (through the edge)
const GATE_R = GROVE_R;         // gate sits at the nominal treeline

/** Build the grove as a handful of stamps (see stamps.ts): a feathered tree blob,
 *  then a grass mouth carved out to each gate. Pure in `numericSeed` so client +
 *  server evaluate an identical grove. */
function buildCentralStamps(gates: Gate[], numericSeed: number): WildStamp[] {
  const gseed = (numericSeed ^ 0x9e3779b1) >>> 0; // independent grove noise stream
  const stamps: WildStamp[] = [
    { kind: 'blob', cx: 0, cy: 0, radius: GROVE_R, feather: FEATHER, noiseScale: GROVE_NOISE_SCALE, seed: gseed, tile: 'tree' },
  ];
  // A grass mouth per gate: a segment along the gate's cardinal axis, from a few
  // tiles inside the treeline out through the ragged edge. Painted after the blob
  // so the corridor is never re-blocked. Cardinal unit vector from the gate coord.
  for (const g of gates) {
    const ux = Math.sign(g.wildX);
    const uy = Math.sign(g.wildY);
    stamps.push({
      kind: 'line',
      x0: ux * (GATE_R - MOUTH_INNER), y0: uy * (GATE_R - MOUTH_INNER),
      x1: ux * (GATE_R + MOUTH_OUTER), y1: uy * (GATE_R + MOUTH_OUTER),
      half: MOUTH_HALF, tile: 'grass',
    });
  }
  return stamps;
}

/** The four cardinal gates for the central village. Each sits recessed at the
 *  back of its grove mouth. The zone-side portal tiles (villageX/Y) are painted
 *  by matching `portal` post-ops in zone_0_0.json; the return-drop tiles sit a
 *  few tiles inside the same town gap. */
function centralGates(): Gate[] {
  return [
    { dir: 'north', wildX: 0, wildY: -GATE_R, villageX: 57, villageY: 4,   returnX: 57, returnY: 8 },
    { dir: 'south', wildX: 0, wildY: GATE_R,  villageX: 57, villageY: 110, returnX: 57, returnY: 106 },
    { dir: 'east',  wildX: GATE_R, wildY: 0,  villageX: 110, villageY: 57, returnX: 106, returnY: 57 },
    { dir: 'west',  wildX: -GATE_R, wildY: 0, villageX: 4,   villageY: 57, returnX: 8,   returnY: 57 },
  ];
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
  const gates = centralGates();
  return {
    version: 1,
    rev: ATLAS_REV,
    seed,
    numericSeed: resolveSeed(seed),
    cellSize: REGION_CELL_SIZE,
    dangerRadius: DANGER_RADIUS,
    settlements: [
      // Central village at origin. Its enclosed zone is the hand-authored
      // starting village; four gates open out through the tree grove footprint
      // in the wilderness so leaving town in any direction stays cohesive.
      {
        id: centralVillageZoneId,
        worldX: 0, worldY: 0,
        portalX: gates[0]!.wildX, portalY: gates[0]!.wildY,
        gates,
        band: 0,
      },
    ],
    stamps: buildCentralStamps(gates, resolveSeed(seed)),
  };
}

export { WILD };
