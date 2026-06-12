import type { FeatureOperator } from './index.ts';

export const guardTower: FeatureOperator = {
  id: 'guard_tower',
  note: 'Four small stone towers stamped at the perimeter corners. Works alongside city_walls to fortify a zone boundary.',
  phase: 'build',
  blueprint: () => [
    { type: 'stamp', at: { edge: 'north', t: 0.05 }, region: 'tower_nw', placement: 'perimeter', prefab: { data: 'WWW\nWCW\nWWW', legend: { W: 'wall', C: 'stone_floor' } } },
    { type: 'stamp', at: { edge: 'north', t: 0.95 }, region: 'tower_ne', placement: 'perimeter', prefab: { data: 'WWW\nWCW\nWWW', legend: { W: 'wall', C: 'stone_floor' } } },
    { type: 'stamp', at: { edge: 'south', t: 0.05 }, region: 'tower_sw', placement: 'perimeter', prefab: { data: 'WWW\nWCW\nWWW', legend: { W: 'wall', C: 'stone_floor' } } },
    { type: 'stamp', at: { edge: 'south', t: 0.95 }, region: 'tower_se', placement: 'perimeter', prefab: { data: 'WWW\nWCW\nWWW', legend: { W: 'wall', C: 'stone_floor' } } },
  ],
};
