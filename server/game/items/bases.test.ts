import { describe, expect, it } from 'vitest';
import type { Archetype, Material } from '../../../shared/types.ts';
import { composeBases } from './bases.ts';

const wood: Material = {
  id: 'oak', name: 'Oak', class: 'wood', min_ilvl: 1, dmg_mult: 1.5, value_mult: 2,
} as Material;

const staff: Archetype = {
  id: 'staff', name: 'Staff', slot: 'mainhand', material_classes: ['wood'],
  tags: ['melee', 'staff'], base_damage: [3, 6], attack_range: 4, base_value: 14,
};

const sword: Archetype = {
  id: 'sword', name: 'Sword', slot: 'mainhand', material_classes: ['wood'],
  tags: ['melee', 'blade'], base_damage: [4, 8], base_value: 10,
};

describe('composeBases', () => {
  // Reach has to survive the material cross-product the same way base_speed and
  // scaling do — a field the archetype declares but composeBases forgets to copy
  // vanishes silently, leaving every composed staff a melee weapon.
  it('carries attack_range through to the composed base', () => {
    const [base] = composeBases([wood], [staff]);
    expect(base!.attack_range).toBe(staff.attack_range);
  });

  it('leaves attack_range absent for archetypes that do not declare it', () => {
    const [base] = composeBases([wood], [sword]);
    expect(base!.attack_range).toBeUndefined();
  });

  it('does not scale reach by the material damage multiplier', () => {
    const [base] = composeBases([wood], [staff]);
    expect(base!.base_damage).not.toEqual(staff.base_damage); // material did scale damage
    expect(base!.attack_range).toBe(4);
  });
});
