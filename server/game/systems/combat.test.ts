import { describe, expect, it } from 'vitest';
import { makeItem, makePlayer } from '../entities.ts';
import { effectiveDamageRange } from './combat.ts';
import { SCALING_COEFFS } from '../../../shared/constants.ts';
import type { ClassId, ItemBase, PlayerEntity, RolledStats, WorldDefs } from '../../../shared/types.ts';

// A melee weapon and a caster weapon with different profiles, so a test can tell
// which one's numbers are actually being read.
const SWORD: ItemBase = {
  id: 'plain_sword', name: 'Plain Sword', slot: 'mainhand', tags: [],
  base_damage: [4, 7], scaling: { strength: 'D' },
};
const STAFF: ItemBase = {
  id: 'plain_staff', name: 'Plain Staff', slot: 'mainhand', tags: [],
  base_damage: [3, 6], scaling: { intelligence: 'C' },
};
// A hand-authored weapon that declares no scaling at all — several world bases
// look like this, and they must not lose their base damage over it.
const CLUB: ItemBase = { id: 'plain_club', name: 'Plain Club', slot: 'mainhand', tags: [], base_damage: [5, 5] };

const defs = { itemBases: { plain_sword: SWORD, plain_staff: STAFF, plain_club: CLUB } } as unknown as WorldDefs;

/** `rolled: false` mimics every weapon that never passed through generateItem —
 *  a staple bought off a shop shelf, a /give, a character saved before the roll
 *  existed. Its stack carries `item: null`, so the base is the only source of
 *  damage and scaling there is. */
function holding(baseId?: string, opts: { rolled?: boolean; klass?: ClassId; extra?: Partial<RolledStats> } = {}): PlayerEntity {
  const p = makePlayer({ zone: 'test', x: 0, y: 0, klass: opts.klass ?? 'fighter' });
  if (baseId) {
    const base = defs.itemBases[baseId]!;
    p.components.equipment.mainhand = {
      base: baseId, name: baseId, sprite: 'item_sword',
      item: opts.rolled === false ? null : makeItem({
        base: baseId,
        rolled: { damage: base.base_damage ?? null, defense: null, scaling: base.scaling ?? null, ...opts.extra },
      }),
    };
  }
  return p;
}

describe('weapon damage comes from the weapon', () => {
  // The bug this pins: damage was read off the rolled instance alone, so a
  // weapon with no roll contributed neither its base damage nor its scaling and
  // swung for bare-fist damage — which at low level is *higher* than a starter
  // weapon's, making the weapon a downgrade the moment you equipped it.
  it('reads the base when the weapon carries no roll', () => {
    for (const id of ['plain_sword', 'plain_staff', 'plain_club']) {
      expect(effectiveDamageRange(holding(id, { rolled: false }), defs))
        .toEqual(effectiveDamageRange(holding(id), defs));
    }
  });

  it('spans the weapon\'s own damage range, not the actor\'s', () => {
    const [lo, hi] = effectiveDamageRange(holding('plain_sword', { rolled: false }), defs);
    expect(hi - lo).toBe(SWORD.base_damage![1] - SWORD.base_damage![0]);
  });

  it('still swings for a base the world no longer defines', () => {
    const p = holding('plain_sword', { rolled: false });
    p.components.equipment.mainhand!.base = 'deleted_base';
    const [lo] = effectiveDamageRange(p, defs);
    expect(lo).toBeGreaterThan(0);
  });

  // The point of the weapon-attack redesign: the class picks nothing about how
  // you hit. Same stats + same weapon = same damage, whoever is holding it.
  it('does not let the class change what a weapon hits for', () => {
    const stats = { strength: 7, dexterity: 7, intelligence: 7, constitution: 7 };
    for (const id of ['plain_sword', 'plain_staff']) {
      const ranges = (['fighter', 'rogue', 'wizard'] as ClassId[]).map((klass) => {
        const p = holding(id, { rolled: false, klass });
        Object.assign(p.components.stats, stats);
        return effectiveDamageRange(p, defs);
      });
      expect(ranges[1]).toEqual(ranges[0]);
      expect(ranges[2]).toEqual(ranges[0]);
    }
  });

  it('scales an unrolled weapon by the stat its base names', () => {
    const smart = holding('plain_staff', { rolled: false });
    const before = effectiveDamageRange(smart, defs);
    smart.components.stats.intelligence = (smart.components.stats.intelligence ?? 0) + 10;
    const after = effectiveDamageRange(smart, defs);
    expect(after[0] - before[0]).toBe(Math.round(10 * SCALING_COEFFS['C']!));
  });

  it('keeps the roll ahead of the base, so affixes still land', () => {
    const branded = holding('plain_sword', { extra: { fire_damage: 6 } as Partial<RolledStats> });
    const plain = holding('plain_sword');
    expect(effectiveDamageRange(branded, defs)[0]).toBe(effectiveDamageRange(plain, defs)[0] + 6);
  });
});

describe('unarmed damage', () => {
  it('scales with strength when there is no weapon at all', () => {
    const p = holding();
    const before = effectiveDamageRange(p, defs);
    p.components.stats.strength = (p.components.stats.strength ?? 0) + 10;
    expect(effectiveDamageRange(p, defs)[0] - before[0]).toBe(Math.round(10 * SCALING_COEFFS['C']!));
  });

  it('is the same for every class — an empty hand is an empty hand', () => {
    const ranges = (['fighter', 'rogue', 'wizard'] as ClassId[]).map((klass) => {
      const p = holding(undefined, { klass });
      Object.assign(p.components.stats, { strength: 7, dexterity: 7, intelligence: 7, constitution: 7 });
      return effectiveDamageRange(p, defs);
    });
    expect(ranges[1]).toEqual(ranges[0]);
    expect(ranges[2]).toEqual(ranges[0]);
  });
});
