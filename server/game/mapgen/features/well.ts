import type { FeatureDef } from './index.ts';

export const well: FeatureDef = {
  id: 'well',
  note: 'A small stone well with a water tile, placed in the zone interior. Minimal footprint — fits anywhere.',
  blueprint: [
    { kind: 'fixed', op: {
      type: 'place',
      seed: 'feature_well',
      placement: 'internal',
      margin: 2,
      region: 'well',
      prefab: {
        data: 'SSS\nSWS\nSSS',
        legend: { S: 'stone_floor', W: 'water' },
      },
    }},
  ],
};
