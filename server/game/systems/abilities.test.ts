import { describe, expect, it } from 'vitest';
import { makeItem, makePlayer, makeMob } from '../entities.ts';
import { UNARMED_ATTACK_ID, WEAPON_ATTACK_ID } from '../../../shared/constants.ts';
import { UNARMED_STRIKE, attackAbilityFor, attackRange } from './abilities.ts';
import type { AbilityDef, ClassId, MobEntity, MobTemplate, PlayerEntity, RolledStats } from '../../../shared/types.ts';
import type { World } from '../world.ts';

function ability(id: string, range: number): AbilityDef {
  return {
    id, name: id, targeting: { shape: 'target', range },
    cast: { cost: {}, cooldown_ticks: 0 },
    effects: [{ kind: 'damage', base: [1, 1], from_weapon: true }],
    weapon_attack: true,
  };
}

const UNARMED = ability(UNARMED_ATTACK_ID, 1);
const SWING = ability(WEAPON_ATTACK_ID, 1);
const BOLT = ability('staff_bolt', 4);

// Only defs.abilities is read; the rest of World is irrelevant to attack resolution.
function world(abilities: Record<string, AbilityDef>): World {
  return { defs: { abilities } } as unknown as World;
}
const FULL = world({ [UNARMED_ATTACK_ID]: UNARMED, [WEAPON_ATTACK_ID]: SWING, staff_bolt: BOLT });

/** A player holding nothing, or holding a weapon that names `attackAbility`
 *  (pass null for a weapon whose base names none — the unannotated case). */
function player(klass: ClassId, attackAbility?: string | null): PlayerEntity {
  const p = makePlayer({ zone: 'test', x: 0, y: 0, klass });
  if (attackAbility !== undefined) {
    const rolled = { damage: [1, 2], defense: null, scaling: null } as RolledStats;
    if (attackAbility !== null) rolled.attack_ability = attackAbility;
    p.components.equipment.mainhand = {
      base: 'test_weapon', name: 'Test Weapon', sprite: 'item_sword',
      item: makeItem({ base: 'test_weapon', rolled }),
    };
  }
  return p;
}

const TEMPLATE = { id: 't', name: 'Test Mob', sprite: 's', level: 1, role: 'soldier' } as MobTemplate;
function mob(): MobEntity {
  return makeMob(TEMPLATE, { zone: 'test', x: 0, y: 0 });
}

describe('attackAbilityFor', () => {
  it('uses the ability the equipped weapon names', () => {
    expect(attackAbilityFor(FULL, player('wizard', 'staff_bolt')).id).toBe('staff_bolt');
  });

  // The default that keeps every hand-authored weapon working without being
  // annotated. Reading as bare fists while holding a sword is the failure here.
  it('swings for a weapon that names no ability', () => {
    expect(attackAbilityFor(FULL, player('fighter', null)).id).toBe(WEAPON_ATTACK_ID);
    expect(attackAbilityFor(FULL, player('wizard', null)).id).toBe(WEAPON_ATTACK_ID);
  });

  // The point of the redesign: reach comes from the weapon, never the class.
  // An empty-handed wizard is a brawler like anyone else.
  it('is unarmed for any class with an empty mainhand', () => {
    for (const klass of ['fighter', 'rogue', 'wizard'] as ClassId[]) {
      expect(attackAbilityFor(FULL, player(klass)).id).toBe(UNARMED_ATTACK_ID);
    }
  });

  it('does not let the class change what a weapon does', () => {
    expect(attackAbilityFor(FULL, player('fighter', 'staff_bolt')).id).toBe('staff_bolt');
    expect(attackAbilityFor(FULL, player('wizard', WEAPON_ATTACK_ID)).id).toBe(WEAPON_ATTACK_ID);
  });

  it('resolves mobs to unarmed — they carry no equipment', () => {
    expect(attackAbilityFor(FULL, mob()).id).toBe(UNARMED_ATTACK_ID);
  });

  // A weapon naming an ability the world doesn't define must still swing, not
  // drop its wielder to bare fists (and never leave them unable to attack).
  it('falls back to a swing when the named ability is missing', () => {
    expect(attackAbilityFor(FULL, player('fighter', 'no_such_ability')).id).toBe(WEAPON_ATTACK_ID);
  });

  it('falls back to the code constant when the world defines no attack abilities', () => {
    expect(attackAbilityFor(world({}), player('fighter'))).toBe(UNARMED_STRIKE);
    expect(attackAbilityFor(world({}), player('fighter', null))).toBe(UNARMED_STRIKE);
  });
});

describe('attackRange', () => {
  it('is the reach of whatever the actor attacks with', () => {
    expect(attackRange(FULL, player('wizard', 'staff_bolt'))).toBe(BOLT.targeting.range);
    expect(attackRange(FULL, player('fighter', null))).toBe(1);
  });

  it('is melee for every empty-handed actor', () => {
    expect(attackRange(FULL, player('wizard'))).toBe(1);
    expect(attackRange(FULL, mob())).toBe(1);
  });

  // Reach is read off the def, so retuning staff_bolt.yaml retunes the game
  // without touching code — assert the wiring, not today's number.
  it('tracks the def rather than a hardcoded number', () => {
    const w = world({ [UNARMED_ATTACK_ID]: UNARMED, staff_bolt: ability('staff_bolt', 7) });
    expect(attackRange(w, player('wizard', 'staff_bolt'))).toBe(7);
  });
});
