import type { FeatureDef } from './index.ts';

export const fountain: FeatureDef = {
  id: 'fountain',
  note: 'A stone fountain with a water basin placed in the zone interior. Adds a social focal point and visual landmark.',
  blueprint: [
    { kind: 'fixed', op: {
      type: 'place',
      seed: 'feature_fountain',
      placement: 'internal',
      margin: 4,
      region: 'fountain',
      prefab: {
        data: '.SSS.\nSWWWS\nSWWWS\nSWWWS\n.SSS.',
        legend: { S: 'stone_floor', W: 'water' },
      },
    }},
  ],
};
