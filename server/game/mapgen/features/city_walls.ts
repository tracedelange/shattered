import type { FeatureOperator } from './index.ts';

export const cityWalls: FeatureOperator = {
  id: 'city_walls',
  note: 'A single-tile-wide perimeter wall running along the zone inset boundary. Requires the zone to have a non-zero inset to be visible.',
  phase: 'build',
  blueprint: () => [
    // Clear trees from the interior so the wall is not buried in forest.
    { type: 'fill', tile: 'grass', only_over: 'tree', placement: 'internal' },
    { type: 'path', seed: 'wall_n', points: [{ edge: 'north', t: 0 }, { edge: 'north', t: 1 }], tile: 'wall', width: 1, placement: 'perimeter' },
    { type: 'path', seed: 'wall_s', points: [{ edge: 'south', t: 0 }, { edge: 'south', t: 1 }], tile: 'wall', width: 1, placement: 'perimeter' },
    { type: 'path', seed: 'wall_w', points: [{ edge: 'west',  t: 0 }, { edge: 'west',  t: 1 }], tile: 'wall', width: 1, placement: 'perimeter' },
    { type: 'path', seed: 'wall_e', points: [{ edge: 'east',  t: 0 }, { edge: 'east',  t: 1 }], tile: 'wall', width: 1, placement: 'perimeter' },
  ],
};
