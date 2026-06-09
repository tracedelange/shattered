import type { BiomeDef } from './index.ts';

export const tundra: BiomeDef = {
  id: 'tundra',
  tileset: 'overworld',
  tags: ['outdoor'],
  palette: { floor: 'cracked_stone_floor', wall: 'tree', accent: 'water' },
  defaultTile: 'cracked_stone_floor',
  width: 60,
  height: 50,
  pipeline: [
    // Sparse scraggly trees
    {
      kind: 'fixed',
      id: 'tundra_trees',
      params: [
        { field: 'threshold', label: 'Tree density', min: 0.55, max: 0.85, step: 0.01, default: 0.70 },
      ],
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'tree',
        threshold: 0.70,
        scale: 4.0,
        seed: 'tundra_trees',
      },
    },
    // Frozen pools
    {
      kind: 'fixed',
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'water',
        threshold: 0.78,
        scale: 3.5,
        seed: 'tundra_ice',
        over: 'cracked_stone_floor',
      },
    },
    // Rocky dirt seams
    {
      kind: 'fixed',
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'dirt',
        threshold: 0.72,
        scale: 5.0,
        seed: 'tundra_dirt',
        over: 'cracked_stone_floor',
      },
    },
  ],
  defaultConstraints: [],
  spawnWeights: { rat: 4, deer: 2, goblin: 1 },
  featureWeights: {},
};
