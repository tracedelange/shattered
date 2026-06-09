import type { BiomeDef } from './index.ts';

export const forest: BiomeDef = {
  id: 'forest',
  tileset: 'overworld',
  tags: ['outdoor'],
  palette: { floor: 'grass', wall: 'tree', accent: 'dirt' },
  defaultTile: 'grass',
  width: 60,
  height: 50,
  pipeline: [
    {
      kind: 'fixed',
      id: 'forest_trees',
      params: [
        { field: 'threshold', label: 'Tree density', min: 0.25, max: 0.70, step: 0.01, default: 0.42 },
      ],
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'tree',
        threshold: 0.42,
        scale: 4.5,
        seed: 'forest_trees',
      },
    },
    {
      kind: 'fixed',
      op: {
        type: 'path',
        points: [
          { edge: 'west', t: 0.5 },
          { edge: 'east', t: 0.5 },
        ],
        tile: 'dirt',
        width: 2,
        jitter: 4,
        seed: 'forest_trail',
      },
    },
    {
      kind: 'weighted',
      choices: [
        {
          weight: 2,
          op: {
            type: 'path',
            points: [{ edge: 'north', t: 0.5 }, { edge: 'south', t: 0.5 }],
            tile: 'dirt',
            width: 1,
            jitter: 3,
            seed: 'forest_branch',
          },
        },
        {
          weight: 1,
          op: {
            type: 'fill',
            bounds: { rect: { x: 0, y: 0, w: 0, h: 0 } },
            tile: 'grass',
          },
        },
      ],
    },
  ],
  defaultConstraints: [
    { feature: 'clearing', anchor: 'zone_center', priority: 'preferred' },
  ],
  spawnWeights: { deer: 4, goblin: 3, rat: 2, squirrel: 2 },
  featureWeights: { clearing: 1, ancient_tree: 2 },
};
