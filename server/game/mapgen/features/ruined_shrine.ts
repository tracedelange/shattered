import type { FeatureOperator } from './index.ts';

export const ruinedShrine: FeatureOperator = {
  id: 'ruined_shrine',
  note: 'A small crumbled stone chamber placed in the zone interior. Suggests prior habitation or a forgotten cult — adds mystery and a lore anchor.',
  phase: 'decorate',
  blueprint: () => [
    {
      type: 'place',
      seed: 'feature_shrine',
      placement: 'internal',
      margin: 2,
      region: 'ruined_shrine',
      rotate: true,
      anchor_prefix: 'shrine',
      prefab: {
        data: '#####\n#...#\n#.W.#\n#...#\n##D##',
        legend: { '#': 'cracked_wall', '.': 'cracked_stone_floor', W: 'water', D: 'door' },
        anchors: { D: 'door' },
      },
    },
  ],
};
