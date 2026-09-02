import { describe, expect, it } from 'vitest';
import {
  AFFIX_SELL_RATE, DEFAULT_STAT_SELL_WORTH, FEATURED_STOCK_MARKUP, STAT_SELL_WORTH,
} from '../../../shared/constants.ts';
import type { InventoryStack, ItemBase, RolledStats, WorldDefs } from '../../../shared/types.ts';
import { featuredPriceOf, rolledBudget, sellPriceOf } from './pricing.ts';

const sword: ItemBase = {
  id: 'iron_sword', name: 'Iron Sword', slot: 'mainhand', tags: ['sword'],
  base_damage: [4, 8], base_speed: 1, sell_value: 10,
};
const ring: ItemBase = { id: 'gold_ring', name: 'Gold Ring', slot: 'ring', tags: [], sell_value: 5 };
const questItem: ItemBase = { id: 'sigil', name: 'Sigil', slot: 'quest', tags: [], sell_value: 999 };

function rolled(over: Partial<RolledStats> = {}): RolledStats {
  return { damage: null, defense: null, scaling: null, ...over };
}

// Only itemBases is read; the rest of WorldDefs is irrelevant to pricing.
const defs = { itemBases: { iron_sword: sword, gold_ring: ring, sigil: questItem } } as unknown as WorldDefs;

function stack(baseId: string, r: RolledStats | null): InventoryStack {
  return {
    base: baseId,
    name: baseId,
    sprite: baseId,
    item: r === null ? null : {
      id: 'i1', type: 'item',
      components: { equipment: { base: baseId, affixes: [], rolled: r } },
    },
  };
}

describe('rolledBudget', () => {
  it('is zero for a roll that only reproduces the base profile', () => {
    expect(rolledBudget(rolled({ damage: [4, 8], speed: 1 }), sword)).toBe(0);
  });

  it('prices damage as the midpoint delta over the base', () => {
    // mid([6,10]) - mid([4,8]) = 2 points of damage_bonus.
    expect(rolledBudget(rolled({ damage: [6, 10] }), sword)).toBe(2 * STAT_SELL_WORTH.damage_bonus);
  });

  it('never prices a roll below its base, even when the roll is worse', () => {
    expect(rolledBudget(rolled({ damage: [1, 2], speed: 0.5 }), sword)).toBe(0);
  });

  it('prices an affix stat outright', () => {
    expect(rolledBudget(rolled({ strength: 3 }), ring)).toBe(3 * STAT_SELL_WORTH.strength);
  });

  it('falls back to the default worth for a stat the table has not been taught', () => {
    expect(rolledBudget(rolled({ moxie: 2 }), ring)).toBe(2 * DEFAULT_STAT_SELL_WORTH);
  });

  it('ignores the non-numeric roll keys', () => {
    expect(rolledBudget(rolled({ scaling: { strength: 'A' }, weapon_brand: 'fire' }), ring)).toBe(0);
  });

  it('clamps a negative (debuff-shaped) stat rather than discounting the item', () => {
    expect(rolledBudget(rolled({ strength: -5 }), ring)).toBe(0);
  });
});

describe('sellPriceOf', () => {
  it('pays base value plus the affix rate on the rolled budget', () => {
    const budget = 4 * STAT_SELL_WORTH.strength;
    expect(sellPriceOf(stack('gold_ring', rolled({ strength: 4 })), defs))
      .toBe(Math.round(5 + budget * AFFIX_SELL_RATE));
  });

  it('pays base value alone for an unrolled stack', () => {
    expect(sellPriceOf(stack('gold_ring', null), defs)).toBe(5);
  });

  it('separates two copies of one base by what their rolls added', () => {
    const plain = sellPriceOf(stack('gold_ring', rolled()), defs)!;
    const good = sellPriceOf(stack('gold_ring', rolled({ strength: 10 })), defs)!;
    expect(good).toBeGreaterThan(plain);
  });

  it('refuses quest items', () => {
    expect(sellPriceOf(stack('sigil', null), defs)).toBeNull();
  });

  it('refuses a base that no longer exists', () => {
    expect(sellPriceOf(stack('deleted_base', null), defs)).toBeNull();
  });

  it('never pays zero for something sellable', () => {
    const worthless = { ...ring, sell_value: 0 };
    const d = { itemBases: { gold_ring: worthless } } as unknown as WorldDefs;
    expect(sellPriceOf(stack('gold_ring', null), d)).toBe(1);
  });
});

describe('featuredPriceOf', () => {
  it('marks up the price the merchant would pay', () => {
    const s = stack('gold_ring', rolled({ strength: 4 }));
    expect(featuredPriceOf(s, defs)).toBe(Math.round(sellPriceOf(s, defs)! * FEATURED_STOCK_MARKUP));
  });

  it('still charges for an item the merchant would not buy', () => {
    expect(featuredPriceOf(stack('sigil', null), defs)).toBe(FEATURED_STOCK_MARKUP);
  });
});
