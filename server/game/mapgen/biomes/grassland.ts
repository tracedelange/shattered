import type { BiomeDef } from './index.ts';

export const grassland: BiomeDef = {
  id: 'grassland',
  tileset: 'overworld',
  tags: ['outdoor'],
  palette: { floor: 'grass', wall: 'tree', accent: 'dirt' },
  defaultTile: 'grass',
  width: 60,
  height: 50,
  pipeline: [
    {
      kind: 'fixed',
      id: 'grassland_trees',
      params: [
        { field: 'threshold', label: 'Tree density', min: 0.40, max: 0.75, step: 0.01, default: 0.55 },
      ],
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'tree',
        threshold: 0.55,
        scale: 5.0,
        seed: 'grassland_trees',
      },
    },
    {
      kind: 'fixed',
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'dirt',
        threshold: 0.74,
        scale: 3.0,
        seed: 'grassland_dirt',
        over: 'grass',
      },
    },
    {
      kind: 'weighted',
      choices: [
        {
          weight: 2,
          op: {
            type: 'path',
            points: [{ edge: 'west', t: 0.5 }, { edge: 'east', t: 0.5 }],
            tile: 'dirt',
            width: 1,
            jitter: 4,
            seed: 'grassland_trail',
          },
        },
        {
          weight: 1,
          op: { type: 'fill', bounds: { rect: { x: 0, y: 0, w: 0, h: 0 } }, tile: 'grass' },
        },
      ],
    },
  ],
  defaultConstraints: [],
  spawnWeights: { deer: 4, goblin: 3, rat: 2 },
  featureWeights: {},
};
