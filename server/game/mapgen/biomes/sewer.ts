import type { BiomeDef } from './index.ts';

export const sewer: BiomeDef = {
  id: 'sewer',
  tileset: 'overworld',
  tags: ['indoor', 'underground', 'aquatic'],
  palette: { floor: 'stone_floor', wall: 'wall', accent: 'water' },
  defaultTile: 'wall',
  width: 40,
  height: 30,
  basePipeline: [
    {
      kind: 'fixed',
      id: 'sewer_cave',
      params: [
        { field: 'fill',       label: 'Tunnel density',   min: 0.35, max: 0.65, step: 0.01, default: 0.50 },
        { field: 'iterations', label: 'Smoothing passes', min: 2,    max: 7,    step: 1,    default: 4    },
      ],
      op: {
        type: 'cave',
        floor: 'stone_floor',
        wall: 'wall',
        seed: 'sewer_cave',
        fill: 0.5,
        iterations: 4,
        min_pocket: 8,
        connect: true,
        tunnel_width: 2,
        region: 'sewer_main',
      },
    },
    {
      kind: 'fixed',
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'water',
        threshold: 0.72,
        scale: 4.0,
        seed: 'sewer_water',
        over: 'stone_floor',
      },
    },
  ],
  features: [],
};
