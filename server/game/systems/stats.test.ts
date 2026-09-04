import { describe, expect, it } from 'vitest';
import { makeItem, makePlayer } from '../entities.ts';
import { attackCooldown, effectiveStat, weaponSpeed } from './stats.ts';
import { makeStack } from './inventory.ts';
import type { ItemBase, PlayerEntity, WorldDefs } from '../../../shared/types.ts';

const FAST: ItemBase = { id: 'fast_dagger', name: 'Fast Dagger', slot: 'mainhand', tags: [], base_speed: 1.5 };
const SLOW: ItemBase = { id: 'slow_maul', name: 'Slow Maul', slot: 'mainhand', tags: [], base_speed: 0.65 };
const EVEN: ItemBase = { id: 'plain_sword', name: 'Plain Sword', slot: 'mainhand', tags: [], base_speed: 1 };
const RING: ItemBase = { id: 'plain_ring', name: 'Plain Ring', slot: 'ring', tags: [] };

const defs = { itemBases: { fast_dagger: FAST, slow_maul: SLOW, plain_sword: EVEN, plain_ring: RING } } as unknown as WorldDefs;
const BASE_TICKS = 15;

/** `rolled: false` mimics a staple bought off a shop shelf — no rolled item, so
 *  the weapon's speed can only come from its base. */
function holding(baseId?: string, opts: { rolled?: boolean; amulet?: number } = {}): PlayerEntity {
  const p = makePlayer({ zone: 'test', x: 0, y: 0, klass: 'fighter' });
  if (baseId) {
    const speed = defs.itemBases[baseId]!.base_speed;
    p.components.equipment.mainhand = {
      base: baseId, name: baseId, sprite: 'item_sword',
      item: opts.rolled === false ? null : makeItem({ base: baseId, rolled: { damage: [1, 2], defense: null, scaling: null, speed } }),
    };
  }
  if (opts.amulet !== undefined) {
    p.components.equipment.amulet = {
      base: 'amulet', name: 'amulet', sprite: 'item_misc',
      item: makeItem({ base: 'amulet', rolled: { damage: null, defense: null, scaling: null, speed: opts.amulet } }),
    };
  }
  return p;
}

describe('weapon speed is a multiplier, not a bonus', () => {
  // The bug this pins: a weapon's base_speed was summed onto the actor's base
  // 1.0, so equipping anything was a large speed buff and the maul — the slowest
  // weapon in the game — made its wielder faster than bare fists.
  it('never lets a weapon change movement speed', () => {
    const unarmed = effectiveStat(holding(), 'speed');
    for (const id of ['fast_dagger', 'slow_maul', 'plain_sword']) {
      expect(effectiveStat(holding(id), 'speed')).toBe(unarmed);
    }
  });

  it('makes a slow weapon slower to swing than bare hands, and a fast one faster', () => {
    const unarmed = attackCooldown(holding(), BASE_TICKS, defs);
    expect(attackCooldown(holding('slow_maul'), BASE_TICKS, defs)).toBeGreaterThan(unarmed);
    expect(attackCooldown(holding('fast_dagger'), BASE_TICKS, defs)).toBeLessThan(unarmed);
    expect(attackCooldown(holding('plain_sword'), BASE_TICKS, defs)).toBe(unarmed);
  });

  it('orders weapons by their declared speed', () => {
    const fast = attackCooldown(holding('fast_dagger'), BASE_TICKS, defs);
    const even = attackCooldown(holding('plain_sword'), BASE_TICKS, defs);
    const slow = attackCooldown(holding('slow_maul'), BASE_TICKS, defs);
    expect(fast).toBeLessThan(even);
    expect(even).toBeLessThan(slow);
  });

  // Same lesson as attack_ability: a staple shop purchase has item: null, so
  // anything read only off the roll would swing at a flat rate.
  it('reads the base when the weapon has no rolled item', () => {
    expect(weaponSpeed(holding('slow_maul', { rolled: false }), defs)).toBe(SLOW.base_speed);
    expect(attackCooldown(holding('slow_maul', { rolled: false }), BASE_TICKS, defs))
      .toBe(attackCooldown(holding('slow_maul'), BASE_TICKS, defs));
  });

  it('is 1 for an empty hand and for a base the world no longer defines', () => {
    expect(weaponSpeed(holding(), defs)).toBe(1);
    const p = holding('plain_sword', { rolled: false });
    p.components.equipment.mainhand!.base = 'deleted_base';
    expect(weaponSpeed(p, defs)).toBe(1);
  });

  // Speed on a non-weapon slot is still an honest bonus — it was never the
  // broken case, and it should keep affecting both movement and attacks.
  it('keeps speed on other slots additive, for movement and attacks alike', () => {
    const bare = effectiveStat(holding(), 'speed');
    expect(effectiveStat(holding(undefined, { amulet: 0.2 }), 'speed')).toBeCloseTo(bare + 0.2);
    expect(attackCooldown(holding(undefined, { amulet: 0.2 }), BASE_TICKS, defs))
      .toBeLessThan(attackCooldown(holding(), BASE_TICKS, defs));
  });
});

describe('makeStack stamps the base speed the client predicts from', () => {
  // The client has no item defs, so it reads the weapon's swing rate off the
  // stack. Without the stamp a shop staple — which has no rolled item to carry
  // `speed` — predicts a flat cadence while the server enforces the weapon's,
  // and every attack the client sends in the gap is silently dropped.
  it('carries base_speed onto a stack built with no rolled item', () => {
    const stack = makeStack(defs, 'slow_maul', null);
    expect(stack.base_speed).toBe(SLOW.base_speed);
  });

  it('agrees with the speed the server actually swings at', () => {
    const stack = makeStack(defs, 'slow_maul', null);
    const p = holding('slow_maul', { rolled: false });
    expect(weaponSpeed(p, defs)).toBe(stack.base_speed);
  });

  // Absent is meaningful: no stamp means "no weapon speed", which is 1x.
  it('leaves base_speed absent for a base that declares none', () => {
    expect(makeStack(defs, 'plain_ring', null).base_speed).toBeUndefined();
  });
});
