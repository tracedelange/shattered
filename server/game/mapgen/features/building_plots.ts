import type { FeatureOperator } from './index.ts';
import type { GenOp } from '../../../../shared/types.ts';

// building_plots — the built core of a settlement: scatter N building plots,
// stamp a house at each, then connect their doors with dirt roads.
//
// This is a coupled cluster: the `stamp` emits `door` anchors, the `network`
// reads those door nodes to build an MST, and `route` carves the dirt along it.
// They must run in this order, so they live together in one build-phase feature
// rather than as separate ops scattered across the pipeline.
//
// Params are intentionally minimal:
//   count        — how many buildings to place.
//   spread        — Poisson-disk spacing between plots: low = tight, high = airy.
//   concentration — pull buildings toward a point (0 = even across the zone,
//                   higher = clustered at the point). Default point is the zone
//                   center; center_x/center_y (0..1 fractions) relocate it.
//
// Buildings are a single generic house prefab for now; prefab variety (taverns,
// blacksmiths, inns) comes later via role weighting or a prefab table.

const GENERIC_HOUSE = {
  data: 'WWWWW\nWFFFW\nDFFFW\nWFFFW\nWWWWW',
  legend: { W: 'wall', F: 'wood_floor', D: 'door' },
  anchors: { D: 'door' },
};

export const buildingPlots: FeatureOperator = {
  id: 'building_plots',
  note: 'The built core of a settlement: scatters `count` generic houses across the zone interior and links their doors with dirt roads. `spread` is the spacing between buildings — low clusters them, high disperses them.',
  phase: 'build',
  params: [
    { field: 'count',         label: 'Building count',           min: 1, max: 12, step: 1,    default: 5 },
    { field: 'spread',        label: 'Spread (low = clustered)', min: 4, max: 30, step: 1,    default: 15 },
    { field: 'concentration', label: 'Concentration toward point', min: 0, max: 6, step: 0.5, default: 0 },
    { field: 'center_x',      label: 'Point X (0–1, .5=center)', min: 0, max: 1,  step: 0.05, default: 0.5 },
    { field: 'center_y',      label: 'Point Y (0–1, .5=center)', min: 0, max: 1,  step: 0.05, default: 0.5 },
  ],
  blueprint: (p) => {
    const count = Math.max(1, Math.round(p.count));
    const spread = Math.max(4, Math.round(p.spread));
    const magnitude = Math.max(0, p.concentration ?? 0);
    const ops: GenOp[] = [
      // Scatter the plots inside the zone interior, clearing a grass disc at each.
      {
        type: 'scatter_sites',
        count,
        spacing: spread,
        seed: 'building_plots',
        id_prefix: 'plot',
        tags: ['plot'],
        over: 'grass',
        margin: 6,
        placement: 'internal',
        clear: { tile: 'grass', radius: 4 },
        // Only bias placement when asked; magnitude 0 keeps the uniform scatter.
        ...(magnitude > 0 ? { concentrate: { fx: p.center_x ?? 0.5, fy: p.center_y ?? 0.5, magnitude } } : {}),
      },
      // Stamp the generic house at each plot, rotated for variety. The door
      // cells become `door` anchors the road network connects.
      {
        type: 'stamp',
        at_tag: 'plot',
        prefab: GENERIC_HOUSE,
        rotate: 'random',
        seed: 'building_plots_stamp',
        region: 'building',
      },
      // MST road graph between the building doors.
      {
        type: 'network',
        nodes_tag: 'door',
        method: 'mst',
        extra_edges: 0.3,
        edge_tag: 'road',
      },
      // Carve dirt roads along the network edges (cutting through trees if needed).
      {
        type: 'route',
        edges: 'road',
        tile: 'dirt',
        width: 2,
        through: ['tree'],
        through_cost: 4,
      },
    ];
    return ops;
  },
};
