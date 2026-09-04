import { rollRange } from '../items/generator.ts';
import { ARMOR_SLOTS } from '../entities.ts';
import { sumEquipRolled, sumActiveModifiers, effectiveStat, isResetting } from './stats.ts';
import { SCALING_COEFFS, BRAND_KEYS, PLAYER_RESIST_CAP_PCT } from '../../../shared/constants.ts';
import type { ItemBase, MobEntity, PlayerEntity, Range, RolledStats, WorldDefs } from '../../../shared/types.ts';

const MAX_DODGE_PCT = 0.30;
const DODGE_PER_DEX = 0.01;
// Armor is subtractive, but capped: a swing always lands at least this fraction
// of its raw damage. Without this, a full armor set's flat reduction exceeds a
// same-level mob's damage and chips it down to 1 (see plan-combat-retune step 4).
const MIN_DAMAGE_FRACTION = 0.25;
// Per-level bonus to an *unarmed* player's basic attack. Unarmed damage is
// otherwise nearly flat (base range + strength), so as mob HP scales with level
// (see MOB_HP_PER_LEVEL) an unarmed player falls further behind every level.
// This term is deliberately small: it only keeps unarmed viable against mobs a
// few levels *below* the player. Real damage comes from weapons and abilities,
// which carry parity fights and up — so this is not tuned to win at parity.
const UNARMED_DMG_PER_LEVEL = 2;

type Combatant = PlayerEntity | MobEntity;

export interface AttackEvent {
  type: 'attack';
  attackerId: string;
  targetId: string;
  damage: number;
  fatal: boolean;
  dodged?: boolean;
}

function brandBonus(entity: Combatant): number {
  const summed = sumEquipRolled(entity);
  let b = 0;
  for (const k of BRAND_KEYS) b += summed[k] || 0;
  return b;
}

export function scaledBonus(entity: Combatant, scaling: RolledStats['scaling']): number {
  if (!scaling) return 0;
  let bonus = 0;
  for (const [stat, letter] of Object.entries(scaling)) {
    const coeff = SCALING_COEFFS[letter as string];
    if (!coeff) continue;
    bonus += effectiveStat(entity, stat) * coeff;
  }
  return bonus;
}

function weaponRolled(entity: Combatant): RolledStats | null {
  if (entity.type !== 'player') return null;
  return entity.components?.equipment?.mainhand?.item?.components?.equipment?.rolled || null;
}

/** The ItemBase of the equipped mainhand, if any. The same lesson as
 *  attackAbilityFor and weaponSpeed: a weapon that never passed through
 *  generateItem — a staple bought off a shop shelf, a /give, anything saved
 *  before the roll existed — carries `item: null`, and reading damage off the
 *  roll alone made it contribute nothing at all. Such a weapon swung with the
 *  right reach at the right speed while hitting for bare-fist damage, which at
 *  low level is *more* than the weapon's own, so equipping it made you weaker. */
function weaponBase(entity: Combatant, defs: WorldDefs): ItemBase | undefined {
  if (entity.type !== 'player') return undefined;
  const stack = entity.components?.equipment?.mainhand;
  return stack ? defs.itemBases?.[stack.base] : undefined;
}

// The mainhand weapon's imbued element (see generateItem's weapon_brand
// stamping), if any. Undefined for mobs (no equipment) and unarmed/unimbued
// players — their basic attack stays untyped physical damage.
export function weaponBrand(entity: Combatant): string | undefined {
  return weaponRolled(entity)?.weapon_brand;
}

function baseDamageRange(entity: Combatant, defs: WorldDefs): Range {
  const rolled = weaponRolled(entity);
  if (rolled && Array.isArray(rolled.damage)) return rolled.damage;
  const base = weaponBase(entity, defs)?.base_damage;
  if (Array.isArray(base)) return base;
  const range = entity.components?.stats?.damage;
  if (Array.isArray(range)) return range;
  const flat = Math.max(1, (range as number) || 1);
  return [flat, flat];
}

function strBonus(entity: Combatant): number {
  // Strength with a C-grade coefficient. Used by mobs always, and by players
  // when unarmed so stats and level still contribute to damage.
  const str = effectiveStat(entity, 'strength');
  return Math.round(str * (SCALING_COEFFS['C'] ?? 0.4));
}

function damageBonus(entity: Combatant, defs: WorldDefs): number {
  if (entity.type === 'mob') return strBonus(entity);
  const scaling = weaponRolled(entity)?.scaling ?? weaponBase(entity, defs)?.scaling;
  // Players with no weapon scaling to go on fall back to strength, mirroring
  // mobs, plus a small per-level term so they keep pace with level-scaled mob HP
  // against weaker mobs.
  if (!scaling) {
    const lvl = entity.components?.progress?.level ?? 1;
    return strBonus(entity) + Math.round(lvl * UNARMED_DMG_PER_LEVEL);
  }
  return Math.round(scaledBonus(entity, scaling));
}

// The weapon-derived swing: base damage range + stat scaling + brands. This is
// the damage of whatever the actor attacks with, reached via the ability
// executor's weapon-derived (from_weapon) damage effect.
export function rollDamage(entity: Combatant, defs: WorldDefs): number {
  return Math.max(1, rollRange(baseDamageRange(entity, defs)) + damageBonus(entity, defs) + brandBonus(entity));
}

export function effectiveDamageRange(entity: Combatant, defs: WorldDefs): Range {
  const [lo, hi] = baseDamageRange(entity, defs);
  const bonus = damageBonus(entity, defs) + brandBonus(entity);
  return [lo + bonus, hi + bonus];
}

export function totalDefense(entity: Combatant): number {
  if (entity.type === 'player') {
    const eq = entity.components.equipment;
    let total = 0;
    for (const slot of ARMOR_SLOTS) {
      const def = eq[slot]?.item?.components?.equipment?.rolled?.defense;
      if (Array.isArray(def)) total += Math.round((def[0] + def[1]) / 2);
      else if (typeof def === 'number') total += def;
    }
    // Flat `armor` affixes (from jewelry/armor suffixes) add on top of base defense.
    return total + (sumEquipRolled(entity).armor || 0);
  }
  // Mob defense: explicit armor value from template, or derived from constitution.
  const stats = entity.components?.stats;
  if (typeof stats?.armor === 'number') return stats.armor;
  const con = stats?.constitution || 0;
  return Math.max(0, Math.floor(con / 3));
}

export function dodgeChance(entity: Combatant): number {
  const dex = effectiveStat(entity, 'dexterity');
  return Math.min(MAX_DODGE_PCT, dex * DODGE_PER_DEX);
}

export function applyDamage(entity: Combatant, amount: number): void {
  if (!entity.components.health) return;
  entity.components.health.current = Math.max(0, entity.components.health.current - amount);
}

// A combatant's per-brand damage multiplier. Mobs use a hand-authored direct
// multiplier (MobTemplate.resistances: 0 = immune, 1 = normal, >1 = vulnerable —
// uncapped, so a design-intent immunity is a real immunity). Players instead
// accumulate `<brand>_resistance` percentage points across every equipped slot
// (via sumEquipRolled) and convert to a multiplier, capped at
// PLAYER_RESIST_CAP_PCT so gear stacking can never reach true immunity.
// Exported so DoT ticks (which bypass the rest of applyResolvedDamage's
// pipeline) can apply the same multiplier.
// A vulnerability debuff or ally resistance-buff is authored as a `modifier`
// effect with a `<brand>_resistance` stat delta (negative = vulnerable) — the
// same key convention player gear already rolls. Both branches fold in
// `sumActiveModifiers` so a timed ability effect actually changes resistance,
// not just gear.
export function resistanceMult(entity: Combatant, brand: string | undefined): number {
  if (!brand) return 1;
  const resistKey = `${brand.replace('_damage', '')}_resistance`;
  const modPct = sumActiveModifiers(entity)[resistKey] || 0;
  if (entity.type === 'mob') {
    const base = entity.components?.stats?.resistances?.[brand] ?? 1;
    // Multiplicative: a hand-authored `0` (true immunity) still wins over any
    // vulnerability debuff stacked on top.
    return base * (1 - modPct / 100);
  }
  const pct = (sumEquipRolled(entity)[resistKey] || 0) + modPct;
  return 1 - Math.min(PLAYER_RESIST_CAP_PCT, pct) / 100;
}

// Apply a raw damage amount to a target through the shared mitigation path:
// brand resistance → dodge roll → subtractive armor (with the min-damage floor)
// → apply. This is the single damage core; both the basic attack and ability
// `damage` effects route through it so resistance/dodge/armor behave identically
// everywhere. `brand` is the originating effect's damage type (undefined for
// weapon/physical damage, which always takes the ×1 multiplier).
export function applyResolvedDamage(att: Combatant, tgt: Combatant, raw: number, brand?: string): AttackEvent {
  if (tgt.type === 'player' && tgt.godMode) {
    return { type: 'attack', attackerId: att.id, targetId: tgt.id, damage: 0, fatal: false };
  }
  // A mob resetting to its leash origin has already dropped threat and been
  // restored to full — it can't be re-damaged on the way home (see isResetting).
  if (isResetting(tgt)) {
    return { type: 'attack', attackerId: att.id, targetId: tgt.id, damage: 0, fatal: false };
  }
  const adjusted = raw * resistanceMult(tgt, brand);
  if (adjusted <= 0) {
    return { type: 'attack', attackerId: att.id, targetId: tgt.id, damage: 0, fatal: false };
  }
  if (Math.random() < dodgeChance(tgt)) {
    return { type: 'attack', attackerId: att.id, targetId: tgt.id, damage: 0, dodged: true, fatal: false };
  }
  const floor = Math.max(1, Math.ceil(adjusted * MIN_DAMAGE_FRACTION));
  const reduced = Math.max(floor, adjusted - totalDefense(tgt));
  applyDamage(tgt, reduced);
  const fatal = (tgt.components.health?.current ?? 0) <= 0;
  return { type: 'attack', attackerId: att.id, targetId: tgt.id, damage: reduced, fatal };
}
