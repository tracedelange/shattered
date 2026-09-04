import { describe, expect, it } from 'vitest';
import { makeItem, makePlayer, makeMob } from '../entities.ts';
import { UNARMED_ATTACK_ID, WEAPON_ATTACK_ID } from '../../../shared/constants.ts';
import { UNARMED_STRIKE, attackAbilityFor, attackRange } from './abilities.ts';
import type { AbilityDef, ClassId, ItemBase, MobEntity, MobTemplate, PlayerEntity } from '../../../shared/types.ts';
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

function base(id: string, attackAbility?: string): ItemBase {
  const b: ItemBase = { id, name: id, slot: 'mainhand', tags: [], base_damage: [1, 2] };
  if (attackAbility) b.attack_ability = attackAbility;
  return b;
}

// Only defs.abilities and defs.itemBases are read; the rest of World is
// irrelevant to attack resolution.
function world(abilities: Record<string, AbilityDef>): World {
  const itemBases = { plain_sword: base('plain_sword'), plain_staff: base('plain_staff', 'staff_bolt'), odd_relic: base('odd_relic', 'no_such_ability') };
  return { defs: { abilities, itemBases } } as unknown as World;
}
const FULL = world({ [UNARMED_ATTACK_ID]: UNARMED, [WEAPON_ATTACK_ID]: SWING, staff_bolt: BOLT });

/** A player holding nothing, or holding the named base. The item is rolled with
 *  no attack hint of its own on purpose: how a weapon attacks must come from the
 *  base, so these stacks deliberately look like a staple shop purchase. */
function player(klass: ClassId, baseId?: string): PlayerEntity {
  const p = makePlayer({ zone: 'test', x: 0, y: 0, klass });
  if (baseId) {
    p.components.equipment.mainhand = {
      base: baseId, name: baseId, sprite: 'item_sword',
      item: makeItem({ base: baseId, rolled: { damage: [1, 2], defense: null, scaling: null } }),
    };
  }
  return p;
}

const TEMPLATE = { id: 't', name: 'Test Mob', sprite: 's', level: 1, role: 'soldier' } as MobTemplate;
function mob(): MobEntity {
  return makeMob(TEMPLATE, { zone: 'test', x: 0, y: 0 });
}

describe('attackAbilityFor', () => {
  it('uses the ability the equipped weapon\'s base names', () => {
    expect(attackAbilityFor(FULL, player('wizard', 'plain_staff')).id).toBe('staff_bolt');
  });

  // The bug this replaced: a staple bought off a shop shelf has item: null, so
  // anything read off the roll rather than the base made a staff swing.
  it('bolts for a staff with no rolled item at all', () => {
    const p = player('wizard', 'plain_staff');
    p.components.equipment.mainhand!.item = null;
    expect(attackAbilityFor(FULL, p).id).toBe('staff_bolt');
  });

  // The default that keeps every hand-authored weapon working without being
  // annotated. Reading as bare fists while holding a sword is the failure here.
  it('swings for a weapon whose base names no ability', () => {
    expect(attackAbilityFor(FULL, player('fighter', 'plain_sword')).id).toBe(WEAPON_ATTACK_ID);
    expect(attackAbilityFor(FULL, player('wizard', 'plain_sword')).id).toBe(WEAPON_ATTACK_ID);
  });

  // The point of the redesign: reach comes from the weapon, never the class.
  // An empty-handed wizard is a brawler like anyone else.
  it('is unarmed for any class with an empty mainhand', () => {
    for (const klass of ['fighter', 'rogue', 'wizard'] as ClassId[]) {
      expect(attackAbilityFor(FULL, player(klass)).id).toBe(UNARMED_ATTACK_ID);
    }
  });

  it('does not let the class change what a weapon does', () => {
    expect(attackAbilityFor(FULL, player('fighter', 'plain_staff')).id).toBe('staff_bolt');
    expect(attackAbilityFor(FULL, player('wizard', 'plain_sword')).id).toBe(WEAPON_ATTACK_ID);
  });

  it('resolves mobs to unarmed — they carry no equipment', () => {
    expect(attackAbilityFor(FULL, mob()).id).toBe(UNARMED_ATTACK_ID);
  });

  // A weapon naming an ability the world doesn't define must still swing, not
  // drop its wielder to bare fists (and never leave them unable to attack).
  it('falls back to a swing when the named ability is missing', () => {
    expect(attackAbilityFor(FULL, player('fighter', 'odd_relic')).id).toBe(WEAPON_ATTACK_ID);
  });

  it('swings for a base the world no longer defines', () => {
    expect(attackAbilityFor(FULL, player('fighter', 'deleted_base')).id).toBe(WEAPON_ATTACK_ID);
  });

  it('falls back to the code constant when the world defines no attack abilities', () => {
    expect(attackAbilityFor(world({}), player('fighter'))).toBe(UNARMED_STRIKE);
    expect(attackAbilityFor(world({}), player('fighter', 'plain_sword'))).toBe(UNARMED_STRIKE);
  });
});

describe('attackRange', () => {
  it('is the reach of whatever the actor attacks with', () => {
    expect(attackRange(FULL, player('wizard', 'plain_staff'))).toBe(BOLT.targeting.range);
    expect(attackRange(FULL, player('fighter', 'plain_sword'))).toBe(1);
  });

  it('is melee for every empty-handed actor', () => {
    expect(attackRange(FULL, player('wizard'))).toBe(1);
    expect(attackRange(FULL, mob())).toBe(1);
  });

  // Reach is read off the def, so retuning staff_bolt.yaml retunes the game
  // without touching code — assert the wiring, not today's number.
  it('tracks the def rather than a hardcoded number', () => {
    const w = world({ [UNARMED_ATTACK_ID]: UNARMED, staff_bolt: ability('staff_bolt', 7) });
    expect(attackRange(w, player('wizard', 'plain_staff'))).toBe(7);
  });
});
