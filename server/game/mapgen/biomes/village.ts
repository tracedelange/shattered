import type { BiomeDef } from './index.ts';

export const village: BiomeDef = {
  id: 'village',
  tileset: 'overworld',
  tags: ['outdoor'],
  palette: { floor: 'stone_floor', wall: 'wall', accent: 'wood_floor' },
  defaultTile: 'grass',
  width: 60,
  height: 50,
  zoneParams: [
    // { id: 'inset', label: 'Wall inset', min: 0, max: 20, step: 1, default: 6 },
  ],
  // Always-on terrain skeleton. The fountain/market reservations now live in
  // their feature operators (reserve phase, which runs before this) so building
  // scatter still avoids them.
  basePipeline: [
    // Scatter a tree fringe to give the village a wooded border.
    // `over: 'grass'` ensures trees don't overwrite walls or buildings.
    {
      kind: 'fixed',
      id: 'tree_fringe',
      params: [
        { field: 'threshold', label: 'Tree density', min: 0.30, max: 0.80, step: 0.01, default: 0.55 },
      ],
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'tree',
        threshold: 0.55,
        scale: 5.0,
        seed: 'village_tree_fringe',
        over: 'grass',
      },
    },
    // Buildings + connecting roads now live in the `building_plots` feature
    // (build phase), so the plot scatter, stamp, road network and route ops
    // moved out of the base pipeline. See features/building_plots.ts.

    // Add scattered dirt patches to grass for visual texture variety.
    {
      kind: 'fixed',
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'dirt',
        threshold: 0.78,
        scale: 3.0,
        seed: 'village_grass_texture',
        over: 'grass',
      },
    },
  ],
  // Feature operators placed via the phased pass. fountain/market reserve their
  // discs (reserve phase) before building scatter; towers/walls/gates are build
  // phase; the fountain/market basins fill in the decorate phase.
  features: [
    { id: 'building_plots', priority: 'required' },
    { id: 'fountain',      priority: 'preferred' },
    { id: 'market_square', priority: 'optional' },
    // { id: 'guard_tower',   priority: 'optional' },
    // { id: 'city_walls',    priority: 'optional' },
    // { id: 'wall_gates',    priority: 'optional' },
  ],
  defaultPostOps: [
    {
      type: 'stamp' as const,
      at: { in_region: 'market_site_1_market' },
      prefab: 'village_notice_board',
      region: 'notice_board',
      overwrite: 'biome' as const,
    },
  ],
  defaultSpawns: [
    { entity: 'village_board', region: 'notice_board', count: 1, respawn_seconds: 86400 },
  ],
};
