import type { FeatureOperator } from './index.ts';

export const campfirePit: FeatureOperator = {
  id: 'campfire_pit',
  note: 'A cracked-stone ring with a central campfire placed in the zone interior. Works in any zone type as a rest point or camp marker.',
  phase: 'decorate',
  blueprint: () => [
    {
      type: 'place',
      seed: 'feature_campfire',
      placement: 'internal',
      margin: 2,
      region: 'campfire_pit',
      prefab: {
        data: 'CCC\nCFC\nCCC',
        legend: { C: 'cracked_stone_floor', F: 'campfire' },
      },
    },
  ],
};
