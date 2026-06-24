import type { FeatureOperator } from './index.ts';
import type { Direction, GenOp } from '../../../../shared/types.ts';

// A solid, impermeable frame of natural terrain wrapping the whole zone — the
// "village ringed by dense forest" border. Built with the same layered recipe
// the beach (ocean_border) uses, which is what makes that one read as organic
// rather than a hard rectangle. Per edge, reading inward from the zone boundary:
//
//   1. fill  core      — a solid `body`-deep band of the material (the bulk).
//   2. noise core      — feathers the material OUT past the body into the
//                        interior, sparse, so the inner treeline is ragged
//                        (mirrors the beach's sand-into-land feather).
//   3. noise clearing  — nibbles interior-tile clearings INTO the band, sparse,
//                        breaking up the solid inner edge (mirrors the beach's
//                        water-fingers-into-sand).
//   4. fill  core      — re-solidifies the outermost `thickness` rim LAST, so
//                        the clearings never breach it. This is the guaranteed-
//                        impermeable wall (mirrors the beach's solid water core).
//
// Gaps are carved last as walkable corridors at the chosen edge midpoints so a
// zone never seals off a real connection to its neighbours.
//
// Params are numeric (the only kind a feature operator takes), so the material
// is an index into MATERIALS. Every material's core tile is a member of
// BLOCKING_TILES — the border is impermeable by construction whatever the look.

interface BorderMaterial {
  /** Solid band tile (a blocking tile, so the rim is impermeable). */
  core: string;
  /** Interior tile nibbled in as clearings to break up the inner edge. */
  clearing: string;
}

const MATERIALS: BorderMaterial[] = [
  { core: 'tree',  clearing: 'grass' }, // 0 — forest (default)
  { core: 'wall',  clearing: 'dirt'  }, // 1 — cliffs / rocky scree
  { core: 'water', clearing: 'sand'  }, // 2 — moat / marsh with shoals
];

/** Open-ground tiles the treeline is allowed to feather over (never structures). */
const FEATHER_OVER = ['grass', 'dirt', 'sand'];

const EDGES: Direction[] = ['north', 'south', 'east', 'west'];

/** Numeric gap toggle (1 = open) → the param field for that edge. */
const GAP_FIELD: Record<Direction, string> = {
  north: 'gap_n', south: 'gap_s', east: 'gap_e', west: 'gap_w',
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const wildernessBorder: FeatureOperator = {
  id: 'wilderness_border',
  note:
    'A solid impermeable frame of natural terrain around the whole zone (a village ringed by dense forest), ' +
    'built with the beach\'s layered noise recipe for an organic edge. material: 0 forest, 1 cliffs, 2 moat. ' +
    'thickness is the impermeable rim; depth is the total band; density (0..1) trades clearings for a denser, ' +
    'more solid wall; scale sizes the noise. gap_n/s/e/w (1 = open) leave walkable corridors at edge midpoints ' +
    'to connect with neighbouring zones, gap_width tiles wide.',
  phase: 'build',
  params: [
    { field: 'material',  label: 'Material (0 forest, 1 cliffs, 2 moat)', min: 0, max: 2,  step: 1,    default: 0 },
    { field: 'thickness', label: 'Impermeable rim depth',                 min: 1, max: 6,  step: 1,    default: 2 },
    { field: 'depth',     label: 'Total border depth',                    min: 2, max: 14, step: 1,    default: 6 },
    { field: 'density',   label: 'Density (0 ragged, 1 solid wall)',      min: 0, max: 1,  step: 0.05, default: 0.6 },
    { field: 'scale',     label: 'Noise scale (lower = bigger blobs)',    min: 1, max: 6,  step: 0.5,  default: 2.5 },
    { field: 'gap_width', label: 'Gap corridor width',                    min: 1, max: 6,  step: 1,    default: 3 },
    { field: 'gap_n',     label: 'North gap open',                        min: 0, max: 1,  step: 1,    default: 1 },
    { field: 'gap_s',     label: 'South gap open',                        min: 0, max: 1,  step: 1,    default: 1 },
    { field: 'gap_e',     label: 'East gap open',                         min: 0, max: 1,  step: 1,    default: 1 },
    { field: 'gap_w',     label: 'West gap open',                         min: 0, max: 1,  step: 1,    default: 1 },
  ],
  blueprint: (p) => {
    const mat = MATERIALS[clamp(Math.round(p.material), 0, MATERIALS.length - 1)]!;
    const rim = Math.max(1, Math.round(p.thickness));
    const depth = Math.max(rim + 1, Math.round(p.depth));
    const density = clamp(p.density, 0, 1);
    const scale = p.scale;

    // Solid body is the bulk of the band; the rest is the feathered treeline.
    const body = clamp(Math.round(depth * 0.7), rim + 1, depth);

    // Higher density → higher clearing threshold (fewer holes) and lower feather
    // threshold (denser outer trees) — i.e. a more solid wall.
    const clearingThr = 0.45 + density * 0.35; // ~0.66 at default → ~34% clearings
    const featherThr   = 0.80 - density * 0.20; // ~0.68 at default → ~32% trees

    const gapWidth = Math.max(1, Math.round(p.gap_width));

    const ops: GenOp[] = [];

    for (const edge of EDGES) {
      // 1 — solid body band.
      ops.push({ type: 'fill', tile: mat.core, bounds: { edge_strip: edge, depth: body }, region: `wilderness_border_${edge}` });
      // 2 — feather the material out past the body into the interior (smooth blobs).
      ops.push({
        type: 'noise_patch', tile: mat.core, bounds: { edge_strip: edge, depth },
        over: FEATHER_OVER, threshold: featherThr, scale, seed: `wb_feather_${edge}`,
      });
      // 3 — nibble interior clearings into the band (finer noise, like the beach's fingers).
      ops.push({
        type: 'noise_patch', tile: mat.clearing, bounds: { edge_strip: edge, depth: body },
        over: mat.core, threshold: clearingThr, scale: scale * 1.4, seed: `wb_clearing_${edge}`,
      });
      // 4 — re-solidify the impermeable rim LAST so clearings never breach it.
      ops.push({ type: 'fill', tile: mat.core, bounds: { edge_strip: edge, depth: rim } });
    }

    // Carve gaps after the border so the corridors are never re-blocked.
    for (const edge of EDGES) {
      if (Math.round(p[GAP_FIELD[edge]]) !== 1) continue;
      ops.push({
        type: 'path', tile: 'dirt', width: gapWidth, seed: `wbgap_${edge}`,
        points: [
          { edge, t: 0.5, inset: 0 },
          { edge, t: 0.5, inset: depth + 2 },
        ],
      });
    }

    return ops;
  },
};
