import type { BiomeDef } from './index.ts';

export const swamp: BiomeDef = {
  id: 'swamp',
  tileset: 'overworld',
  tags: ['outdoor'],
  palette: { floor: 'grass', wall: 'tree', accent: 'water' },
  defaultTile: 'grass',
  width: 60,
  height: 50,
  basePipeline: [
    // Dense tree coverage
    {
      kind: 'fixed',
      id: 'swamp_trees',
      params: [
        { field: 'threshold', label: 'Tree density', min: 0.25, max: 0.60, step: 0.01, default: 0.38 },
      ],
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'tree',
        threshold: 0.38,
        scale: 4.5,
        seed: 'swamp_trees',
      },
    },
    // Standing water patches
    {
      kind: 'fixed',
      id: 'swamp_water',
      params: [
        { field: 'threshold', label: 'Water density', min: 0.55, max: 0.80, step: 0.01, default: 0.66 },
      ],
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'water',
        threshold: 0.66,
        scale: 5.0,
        seed: 'swamp_water',
        over: 'grass',
      },
    },
    // Muddy dirt seams through the wet ground
    {
      kind: 'fixed',
      op: {
        type: 'path',
        points: [{ edge: 'west', t: 0.5 }, { edge: 'east', t: 0.5 }],
        tile: 'dirt',
        width: 1,
        jitter: 6,
        seed: 'swamp_path',
      },
    },
  ],
  features: [],
};
