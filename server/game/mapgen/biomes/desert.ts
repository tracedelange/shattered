import type { BiomeDef } from './index.ts';

export const desert: BiomeDef = {
  id: 'desert',
  tileset: 'overworld',
  tags: ['outdoor'],
  palette: { floor: 'dirt', wall: 'cracked_wall', accent: 'stone_floor' },
  defaultTile: 'dirt',
  width: 60,
  height: 50,
  basePipeline: [
    // Rocky outcrops
    {
      kind: 'fixed',
      id: 'desert_rock',
      params: [
        { field: 'threshold', label: 'Rock density', min: 0.50, max: 0.80, step: 0.01, default: 0.62 },
      ],
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'stone_floor',
        threshold: 0.62,
        scale: 6.0,
        seed: 'desert_rock',
        over: 'dirt',
      },
    },
    // Cracked stone patches
    {
      kind: 'fixed',
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'cracked_stone_floor',
        threshold: 0.74,
        scale: 3.5,
        seed: 'desert_crack',
        over: 'stone_floor',
      },
    },
  ],
  features: [],
  spawnWeights: { goblin: 3, rat: 5 },
};
