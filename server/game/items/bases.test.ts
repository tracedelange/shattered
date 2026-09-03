import { describe, expect, it } from 'vitest';
import type { Archetype, Material } from '../../../shared/types.ts';
import { composeBases } from './bases.ts';

const wood: Material = {
  id: 'oak', name: 'Oak', class: 'wood', min_ilvl: 1, dmg_mult: 1.5, value_mult: 2,
} as Material;

const staff: Archetype = {
  id: 'staff', name: 'Staff', slot: 'mainhand', material_classes: ['wood'],
  tags: ['melee', 'staff'], base_damage: [3, 6], attack_ability: 'staff_bolt', base_value: 14,
};

const sword: Archetype = {
  id: 'sword', name: 'Sword', slot: 'mainhand', material_classes: ['wood'],
  tags: ['melee', 'blade'], base_damage: [4, 8], base_value: 10,
};

describe('composeBases', () => {
  // The attack ability has to survive the material cross-product the same way
  // base_speed and scaling do — a field the archetype declares but composeBases
  // forgets to copy vanishes silently, leaving every composed staff swinging
  // like a club.
  it('carries attack_ability through to the composed base', () => {
    const [base] = composeBases([wood], [staff]);
    expect(base!.attack_ability).toBe(staff.attack_ability);
  });

  // Absent is meaningful: it's what routes a weapon to unarmed_strike.
  it('leaves attack_ability absent for archetypes that do not declare it', () => {
    const [base] = composeBases([wood], [sword]);
    expect(base!.attack_ability).toBeUndefined();
  });

  it('does not vary the attack by material, the way damage varies', () => {
    const [worn] = composeBases([wood], [staff]);
    const [yew] = composeBases([{ ...wood, id: 'yew', name: 'Yew', dmg_mult: 1.4 }], [staff]);
    expect(worn!.base_damage).not.toEqual(yew!.base_damage); // material did scale damage
    expect(worn!.attack_ability).toBe(yew!.attack_ability);
  });
});
