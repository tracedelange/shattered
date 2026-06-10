import type { BiomeDef } from './index.ts';

export const dungeon: BiomeDef = {
  id: 'dungeon',
  tileset: 'dungeon',
  tags: ['indoor', 'underground'],
  palette: { floor: 'stone_floor', wall: 'wall', accent: 'cracked_stone_floor' },
  defaultTile: 'wall',
  width: 40,
  height: 30,
  basePipeline: [
    {
      kind: 'fixed',
      id: 'dungeon_bsp',
      params: [
        { field: 'min_room',  label: 'Min room size', min: 3, max: 8,  step: 1, default: 4 },
        { field: 'max_room',  label: 'Max room size', min: 5, max: 14, step: 1, default: 9 },
        { field: 'max_depth', label: 'BSP depth',     min: 2, max: 6,  step: 1, default: 4 },
      ],
      op: {
        type: 'bsp',
        floor: 'stone_floor',
        wall: 'wall',
        seed: 'dungeon_bsp',
        min_room: 4,
        max_room: 9,
        max_depth: 4,
        margin: 1,
        corridor_width: 1,
        region_prefix: 'room',
        tags: ['room'],
      },
    },
    {
      kind: 'fixed',
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'cracked_stone_floor',
        threshold: 0.75,
        scale: 3.0,
        seed: 'dungeon_cracks',
        over: 'stone_floor',
      },
    },
  ],
  features: [],
  spawnWeights: { goblin: 6, hobgoblin: 2, rat: 4 },
};
