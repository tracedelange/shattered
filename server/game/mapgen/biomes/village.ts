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
    // Scatter building plots inside the wall perimeter. Roles weight which
    // special buildings appear (tavern/blacksmith/inn) alongside generic houses.
    {
      kind: 'fixed',
      id: 'village_plots',
      params: [
        { field: 'count',   label: 'Building count', min: 1,  max: 10, step: 1, default: 5  },
        { field: 'spacing', label: 'Plot spacing',   min: 4,  max: 40, step: 1, default: 15 },
      ],
      op: {
        type: 'scatter_sites',
        count: 5,
        spacing: 15,
        seed: 'village_plots',
        id_prefix: 'plot',
        tags: ['plot'],
        over: 'grass',
        margin: 6,
        placement: 'internal',
        clear: { tile: 'grass', radius: 4 },
        roles: [
          { role: 'tavern',     weight: 1, max: 1 },
          { role: 'blacksmith', weight: 1, max: 1 },
          { role: 'inn',        weight: 1, max: 1 },
          { role: 'generic',    weight: 2 },
        ],
      },
    },
    // Stamp a building at each plot. Role-specific prefabs override the
    // default for sites tagged 'tavern', 'blacksmith', or 'inn'.
    {
      kind: 'fixed',
      op: {
        type: 'stamp',
        at_tag: 'plot',
        prefab: {
          data: 'WWWWW\nWFFFW\nDFFFW\nWFFFW\nWWWWW',
          legend: { W: 'wall', F: 'wood_floor', D: 'door' },
          anchors: { D: 'door' },
        },
        role_prefabs: {
          tavern: {
            data: 'WWWWWWW\nWFFFFFW\nWFCFCFW\nDFFFFFW\nWFCFCFW\nWFFFFFW\nWWWWWWW',
            legend: { W: 'wall', F: 'wood_floor', D: 'door', C: 'campfire' },
            anchors: { D: 'door' },
          },
          blacksmith: {
            data: 'WWWWW\nWSSCW\nDSSSW\nWSSCW\nWWWWW',
            legend: { W: 'wall', S: 'stone_floor', D: 'door', C: 'campfire' },
            anchors: { D: 'door' },
          },
          inn: {
            data: 'WWWWWWW\nWFFFFFW\nDFFFFFW\nWFFFFFW\nWWWWWWW',
            legend: { W: 'wall', F: 'wood_floor', D: 'door' },
            anchors: { D: 'door' },
          },
        },
        rotate: 'random',
        seed: 'village_buildings',
        region: 'building',
      },
    },
    // Build an MST road network between building doors.
    {
      kind: 'fixed',
      op: {
        type: 'network',
        nodes_tag: 'door',
        method: 'mst',
        extra_edges: 0.3,
        edge_tag: 'road',
      },
    },
    // Carve dirt roads along the network edges.
    {
      kind: 'fixed',
      op: {
        type: 'route',
        edges: 'road',
        tile: 'dirt',
        width: 2,
        through: ['tree'],
        through_cost: 4,
      },
    },
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
