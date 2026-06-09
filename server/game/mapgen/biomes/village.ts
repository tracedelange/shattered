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
    { id: 'inset', label: 'Wall inset', min: 0, max: 20, step: 1, default: 0 },
  ],
  pipeline: [
    // Reserve fountain and market locations before any building scatter runs.
    // scatter_sites checks bb.isFree (ANY_CLAIM) before placing, so later
    // building scatter will naturally avoid these claimed discs.
    // module tags ensure these reservations are skipped when the feature is off.
    // placement: 'internal' keeps reservations inside the wall perimeter automatically.
    {
      kind: 'fixed',
      module: 'fountain',
      op: {
        type: 'scatter_sites',
        count: 1,
        spacing: 20,
        claim_radius: 8,
        seed: 'fountain_site',
        id_prefix: 'fountain_site',
        tags: ['fountain_site'],
        over: 'grass',
        margin: 6,
        placement: 'internal',
      },
    },
    {
      kind: 'fixed',
      module: 'market_square',
      op: {
        type: 'scatter_sites',
        count: 1,
        spacing: 20,
        claim_radius: 10,
        seed: 'market_site',
        id_prefix: 'market_site',
        tags: ['market_site'],
        over: 'grass',
        margin: 8,
        placement: 'internal',
      },
    },
    // Scatter tree fringe to give the village a wooded border.
    // `over: 'grass'` ensures trees don't overwrite walls or buildings.
    // No placement constraint — trees cover the whole zone including outside walls.
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
    // Scatter building plots inside the wall perimeter.
    // placement: 'internal' restricts to the inset interior automatically.
    {
      kind: 'fixed',
      id: 'village_plots',
      params: [
        { field: 'count',   label: 'Building count', min: 1,  max: 30, step: 1, default: 5  },
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
          { role: 'tavern',     weight: 1, max: 1, module: 'tavern'     },
          { role: 'blacksmith', weight: 1, max: 1, module: 'blacksmith' },
          { role: 'inn',        weight: 1, max: 1, module: 'inn'        },
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
  defaultConstraints: [
    {
      feature: 'fountain',
      anchor: 'zone_center',
      priority: 'preferred',
      blueprint: [
        { kind: 'fixed', op: {
          type: 'stamp',
          at_tag: 'fountain_site',
          region: 'fountain',
          only_free: true,
          prefab: {
            data: '.SSS.\nSWWWS\nSWWWS\nSWWWS\n.SSS.',
            legend: { S: 'stone_floor', W: 'water' },
          },
        }},
        { kind: 'fixed', op: {
          type: 'route',
          from: { region: 'fountain' },
          to: { center: true },
          tile: 'dirt',
          width: 1,
          through: ['tree'],
          through_cost: 4,
        }},
      ],
    },
    {
      feature: 'guard_tower',
      anchor: 'zone_corner',
      priority: 'optional',
      blueprint: [
        { kind: 'fixed', op: { type: 'stamp', at: { edge: 'north', t: 0.05 }, region: 'tower_nw', placement: 'perimeter', prefab: { data: 'WWW\nWCW\nWWW', legend: { W: 'wall', C: 'stone_floor' } } }},
        { kind: 'fixed', op: { type: 'stamp', at: { edge: 'north', t: 0.95 }, region: 'tower_ne', placement: 'perimeter', prefab: { data: 'WWW\nWCW\nWWW', legend: { W: 'wall', C: 'stone_floor' } } }},
        { kind: 'fixed', op: { type: 'stamp', at: { edge: 'south', t: 0.05 }, region: 'tower_sw', placement: 'perimeter', prefab: { data: 'WWW\nWCW\nWWW', legend: { W: 'wall', C: 'stone_floor' } } }},
        { kind: 'fixed', op: { type: 'stamp', at: { edge: 'south', t: 0.95 }, region: 'tower_se', placement: 'perimeter', prefab: { data: 'WWW\nWCW\nWWW', legend: { W: 'wall', C: 'stone_floor' } } }},
      ],
    },
    {
      feature: 'city_walls',
      anchor: 'zone_perimeter',
      priority: 'optional',
      blueprint: [
        { kind: 'fixed', op: { type: 'fill', tile: 'grass', only_over: 'tree', placement: 'internal' } },
        { kind: 'fixed', op: { type: 'path', seed: 'wall_n', points: [{ edge: 'north', t: 0 }, { edge: 'north', t: 1 }], tile: 'wall', width: 1, placement: 'perimeter' }},
        { kind: 'fixed', op: { type: 'path', seed: 'wall_s', points: [{ edge: 'south', t: 0 }, { edge: 'south', t: 1 }], tile: 'wall', width: 1, placement: 'perimeter' }},
        { kind: 'fixed', op: { type: 'path', seed: 'wall_w', points: [{ edge: 'west',  t: 0 }, { edge: 'west',  t: 1 }], tile: 'wall', width: 1, placement: 'perimeter' }},
        { kind: 'fixed', op: { type: 'path', seed: 'wall_e', points: [{ edge: 'east',  t: 0 }, { edge: 'east',  t: 1 }], tile: 'wall', width: 1, placement: 'perimeter' }},
      ],
    },
    {
      feature: 'wall_gates',
      anchor: 'zone_perimeter',
      priority: 'optional',
      blueprint: [
        { kind: 'fixed', op: { type: 'stamp', at: { edge: 'north', t: 0.5 }, anchor_prefix: 'gate_n', region: 'gate_n', placement: 'perimeter', prefab: { data: 'D', legend: { D: 'door' }, anchors: { D: 'gate' } } }},
        { kind: 'fixed', op: { type: 'stamp', at: { edge: 'south', t: 0.5 }, anchor_prefix: 'gate_s', region: 'gate_s', placement: 'perimeter', prefab: { data: 'D', legend: { D: 'door' }, anchors: { D: 'gate' } } }},
        { kind: 'fixed', op: { type: 'stamp', at: { edge: 'west',  t: 0.5 }, anchor_prefix: 'gate_w', region: 'gate_w', placement: 'perimeter', prefab: { data: 'D', legend: { D: 'door' }, anchors: { D: 'gate' } } }},
        { kind: 'fixed', op: { type: 'stamp', at: { edge: 'east',  t: 0.5 }, anchor_prefix: 'gate_e', region: 'gate_e', placement: 'perimeter', prefab: { data: 'D', legend: { D: 'door' }, anchors: { D: 'gate' } } }},
        { kind: 'fixed', op: {
          type: 'route',
          from_tag: 'gate',
          to: { center: true },
          tile: 'dirt',
          width: 2,
          through: ['tree'],
          through_cost: 4,
        }},
      ],
    },
    {
      feature: 'market_square',
      anchor: 'zone_center',
      priority: 'optional',
      note: 'Open marketplace/bazaar with stalls and gathering space',
      blueprint: [
        { kind: 'fixed', op: {
          type: 'stamp',
          at_tag: 'market_site',
          region: 'market',
          only_free: true,
          prefab: {
            data: 'SSSSSSSSS\nSFFFFFFFFS\nSFFFFFFFFS\nSFFFFFFFFS\nSFFFFFFFFS\nSFFFFFFFFS\nSFFFFFFFFS\nSFFFFFFFFS\nSSSSSSSss',
            legend: { S: 'stone_floor', F: 'wood_floor' },
          },
        }},
        { kind: 'fixed', op: {
          type: 'route',
          from: { region: 'market' },
          to: { center: true },
          tile: 'dirt',
          width: 2,
          through: ['tree'],
          through_cost: 4,
        }},
      ],
    },
  ],
  spawnWeights: { villager: 6, guard: 2, merchant: 1 },
  featureWeights: { well: 1, notice_board: 1, market_stall: 2 },
};
