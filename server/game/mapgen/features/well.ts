import type { FeatureOperator } from './index.ts';

export const well: FeatureOperator = {
  id: 'well',
  note: 'A small stone well with a water tile, placed in the zone interior. Minimal footprint — fits anywhere.',
  phase: 'decorate',
  blueprint: () => [
    {
      type: 'place',
      seed: 'feature_well',
      placement: 'internal',
      margin: 2,
      region: 'well',
      prefab: {
        data: 'SSS\nSWS\nSSS',
        legend: { S: 'stone_floor', W: 'water' },
      },
    },
  ],
};
