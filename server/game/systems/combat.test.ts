import { describe, expect, it } from 'vitest';
import { makeItem, makePlayer } from '../entities.ts';
import { CLASS_ATTACK_RANGE, basicAttackRange } from '../../../shared/constants.ts';
import { attackRange } from './combat.ts';
import { BASIC_ATTACK, basicAttackFor } from './abilities.ts';
import type { ClassId, PlayerEntity, RolledStats } from '../../../shared/types.ts';

function player(klass: ClassId, weaponRange?: number): PlayerEntity {
  const p = makePlayer({ zone: 'test', x: 0, y: 0, klass });
  if (weaponRange !== undefined) {
    const rolled = { damage: [1, 2], defense: null, scaling: null, attack_range: weaponRange } as RolledStats;
    p.components.equipment.mainhand = {
      base: 'test_weapon', name: 'Test Weapon', sprite: 'item_sword',
      item: makeItem({ base: 'test_weapon', rolled }),
    };
  }
  return p;
}

describe('basicAttackRange', () => {
  // The rule is "the better of the two", not "the weapon wins" — a wizard who
  // picks up a dagger must not lose the reach that defines the class.
  it('takes the greater of the class floor and the weapon', () => {
    expect(basicAttackRange('wizard', 1)).toBe(CLASS_ATTACK_RANGE.wizard);
    expect(basicAttackRange('fighter', 6)).toBe(6);
    expect(basicAttackRange('wizard', 6)).toBe(6);
  });

  it('never returns less than melee', () => {
    expect(basicAttackRange('fighter', undefined)).toBe(1);
    expect(basicAttackRange(undefined, undefined)).toBe(1);
    expect(basicAttackRange('fighter', 0)).toBe(1);
  });
});

describe('attackRange', () => {
  // makePlayer grants no starting gear, so this is the case that decides whether
  // a brand-new wizard plays as a caster or as a puncher.
  it('gives an unarmed wizard its class reach', () => {
    expect(attackRange(player('wizard'))).toBe(CLASS_ATTACK_RANGE.wizard);
    expect(CLASS_ATTACK_RANGE.wizard).toBeGreaterThan(1);
  });

  it('keeps unarmed melee classes at melee', () => {
    expect(attackRange(player('fighter'))).toBe(1);
    expect(attackRange(player('rogue'))).toBe(1);
  });

  it('lets a ranged weapon extend a melee class', () => {
    expect(attackRange(player('fighter', 4))).toBe(4);
  });

  it('does not let a melee weapon shorten a wizard', () => {
    expect(attackRange(player('wizard', 1))).toBe(CLASS_ATTACK_RANGE.wizard);
  });
});

describe('basicAttackFor', () => {
  it('carries the actor reach into the ability the executor range-gates on', () => {
    expect(basicAttackFor(player('wizard')).targeting.range).toBe(CLASS_ATTACK_RANGE.wizard);
    expect(basicAttackFor(player('fighter', 6)).targeting.range).toBe(6);
  });

  it('reuses the shared def unchanged for melee, leaving it unmutated', () => {
    expect(basicAttackFor(player('fighter'))).toBe(BASIC_ATTACK);
    basicAttackFor(player('wizard'));
    expect(BASIC_ATTACK.targeting.range).toBe(1);
  });
});
