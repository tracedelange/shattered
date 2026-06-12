import type { FeatureOperator } from './index.ts';

// Fountain. Two-phase: a reserve disc claims interior space before buildings
// scatter (so they avoid it), then the basin is stamped onto that reserved site
// and a short path links it to zone center. Works in any zone — the reserve
// simply sits unused if nothing competes for the space.
export const fountain: FeatureOperator = {
  id: 'fountain',
  note: 'A stone fountain with a water basin at the zone interior. Reserves its spot before buildings, so it always has room. A social focal point and landmark.',
  blueprint: () => ({
    reserve: [
      {
        type: 'scatter_sites',
        count: 1,
        spacing: 20,
        claim_radius: 8,
        seed: 'fountain_site',
        id_prefix: 'fountain_site',
        tags: ['fountain_site'],
        over: 'grass',
        margin: 6,
        placement: 'internal',
      },
    ],
    decorate: [
      {
        type: 'stamp',
        at_tag: 'fountain_site',
        region: 'fountain',
        only_free: true,
        prefab: {
          data: '.SSS.\nSWWWS\nSWWWS\nSWWWS\n.SSS.',
          legend: { S: 'stone_floor', W: 'water' },
        },
      },
      {
        // Route from the reserved site tag, not the stamped region: the stamp
        // registers its region as `<site_id>_fountain` (at_tag prefixing), so a
        // bare `region: 'fountain'` ref never resolves.
        type: 'route',
        from_tag: 'fountain_site',
        to: { center: true },
        tile: 'dirt',
        width: 1,
        through: ['tree'],
        through_cost: 4,
      },
    ],
  }),
};
