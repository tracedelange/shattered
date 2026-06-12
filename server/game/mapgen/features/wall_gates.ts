import type { FeatureOperator } from './index.ts';

export const wallGates: FeatureOperator = {
  id: 'wall_gates',
  note: 'Gates cut into the cardinal midpoints of the perimeter wall, with dirt roads routed from each gate to zone center. Best combined with city_walls.',
  phase: 'build',
  blueprint: () => [
    { type: 'stamp', at: { edge: 'north', t: 0.5 }, anchor_prefix: 'gate_n', region: 'gate_n', placement: 'perimeter', prefab: { data: 'D', legend: { D: 'door' }, anchors: { D: 'gate' } } },
    { type: 'stamp', at: { edge: 'south', t: 0.5 }, anchor_prefix: 'gate_s', region: 'gate_s', placement: 'perimeter', prefab: { data: 'D', legend: { D: 'door' }, anchors: { D: 'gate' } } },
    { type: 'stamp', at: { edge: 'west',  t: 0.5 }, anchor_prefix: 'gate_w', region: 'gate_w', placement: 'perimeter', prefab: { data: 'D', legend: { D: 'door' }, anchors: { D: 'gate' } } },
    { type: 'stamp', at: { edge: 'east',  t: 0.5 }, anchor_prefix: 'gate_e', region: 'gate_e', placement: 'perimeter', prefab: { data: 'D', legend: { D: 'door' }, anchors: { D: 'gate' } } },
    { type: 'route', from_tag: 'gate', to: { center: true }, tile: 'dirt', width: 2, through: ['tree'], through_cost: 4 },
  ],
};
