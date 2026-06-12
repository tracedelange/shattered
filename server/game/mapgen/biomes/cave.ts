import type { BiomeDef } from './index.ts';

export const cave: BiomeDef = {
  id: 'cave',
  tileset: 'dungeon',
  tags: ['underground'],
  palette: { floor: 'stone_floor', wall: 'wall', accent: 'cracked_stone_floor' },
  defaultTile: 'wall',
  width: 50,
  height: 40,
  basePipeline: [
    {
      kind: 'fixed',
      id: 'cave_main',
      params: [
        { field: 'fill',       label: 'Wall density',     min: 0.30, max: 0.65, step: 0.01, default: 0.45 },
        { field: 'iterations', label: 'Smoothing passes', min: 2,    max: 8,    step: 1,    default: 5    },
      ],
      op: {
        type: 'cave',
        floor: 'stone_floor',
        wall: 'wall',
        seed: 'cave_main',
        fill: 0.45,
        iterations: 5,
        min_pocket: 12,
        connect: true,
        tunnel_width: 2,
        region: 'cave_main',
      },
    },
    {
      kind: 'fixed',
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'cracked_stone_floor',
        threshold: 0.7,
        scale: 3.5,
        seed: 'cave_cracks',
        over: 'stone_floor',
      },
    },
  ],
  features: [],
};
