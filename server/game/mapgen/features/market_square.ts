import type { FeatureDef } from './index.ts';

export const marketSquare: FeatureDef = {
  id: 'market_square',
  note: 'An open stone-and-wood marketplace placed in the zone interior. Adds a commerce anchor and gathering space.',
  blueprint: [
    { kind: 'fixed', op: {
      type: 'place',
      seed: 'feature_market',
      placement: 'internal',
      margin: 5,
      region: 'market',
      prefab: {
        data: 'SSSSSSSSS\nSFFFFFFFFS\nSFFFFFFFFS\nSFFFFFFFFS\nSFFFFFFFFS\nSFFFFFFFFS\nSFFFFFFFFS\nSFFFFFFFFS\nSSSSSSSSS',
        legend: { S: 'stone_floor', F: 'wood_floor' },
      },
    }},
  ],
};
