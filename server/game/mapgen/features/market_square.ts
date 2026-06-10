import type { FeatureOperator } from './index.ts';

// Open marketplace. Two-phase like the fountain: a reserve disc holds interior
// space before buildings scatter, then the stone-and-wood plaza is stamped onto
// it and linked to zone center.
export const marketSquare: FeatureOperator = {
  id: 'market_square',
  note: 'An open stone-and-wood marketplace at the zone interior. Reserves its spot before buildings. A commerce anchor and gathering space.',
  blueprint: () => ({
    reserve: [
      {
        type: 'scatter_sites',
        count: 1,
        spacing: 20,
        claim_radius: 10,
        seed: 'market_site',
        id_prefix: 'market_site',
        tags: ['market_site'],
        over: 'grass',
        margin: 8,
        placement: 'internal',
      },
    ],
    decorate: [
      {
        type: 'stamp',
        at_tag: 'market_site',
        region: 'market',
        only_free: true,
        prefab: {
          data: 'SSSSSSSSS\nSFFFFFFFS\nSFFFFFFFS\nSFFFFFFFS\nSFFFFFFFS\nSFFFFFFFS\nSFFFFFFFS\nSFFFFFFFS\nSSSSSSSSSS',
          legend: { S: 'stone_floor', F: 'wood_floor' },
        },
      },
      {
        type: 'route',
        from: { region: 'market' },
        to: { center: true },
        tile: 'dirt',
        width: 2,
        through: ['tree'],
        through_cost: 4,
      },
    ],
  }),
};
