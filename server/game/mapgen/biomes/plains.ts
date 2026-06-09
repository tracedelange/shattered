import type { BiomeDef } from './index.ts';

export const plains: BiomeDef = {
  id: 'plains',
  tileset: 'overworld',
  tags: ['outdoor'],
  palette: { floor: 'grass', wall: 'tree', accent: 'dirt' },
  defaultTile: 'grass',
  width: 60,
  height: 50,
  pipeline: [
    {
      kind: 'fixed',
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'dirt',
        threshold: 0.76,
        scale: 3.5,
        seed: 'plains_dirt',
        over: 'grass',
      },
    },
    {
      kind: 'fixed',
      op: {
        type: 'path',
        points: [{ edge: 'west', t: 0.5 }, { edge: 'east', t: 0.5 }],
        tile: 'dirt',
        width: 2,
        jitter: 5,
        seed: 'plains_road',
      },
    },
  ],
  defaultConstraints: [],
  spawnWeights: { deer: 5, rat: 3 },
  featureWeights: {},
};
