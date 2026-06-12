import { DIRS } from './movement.ts';
import { rollRange } from '../items/generator.ts';
import { isAlive, ARMOR_SLOTS } from '../entities.ts';
import { SCALING_COEFFS } from '../../../shared/constants.ts';
import type { Entity, MobEntity, PlayerEntity, Range, RolledStats } from '../../../shared/types.ts';
import type { World } from '../world.ts';

const MAX_DODGE_PCT = 0.30;
const DODGE_PER_DEX = 0.01;
// Armor is subtractive, but capped: a swing always lands at least this fraction
// of its raw damage. Without this, a full armor set's flat reduction exceeds a
// same-level mob's damage and chips it down to 1 (see plan-combat-retune step 4).
const MIN_DAMAGE_FRACTION = 0.25;

type Combatant = PlayerEntity | MobEntity;

export interface AttackEvent {
  type: 'attack';
  attackerId: string;
  targetId: string;
  damage: number;
  fatal: boolean;
  dodged?: boolean;
}

function asCombatant(e: Entity): Combatant | null {
  return (e.type === 'player' || e.type === 'mob') ? e : null;
}

function scaledBonus(entity: Combatant, scaling: RolledStats['scaling']): number {
  if (!scaling) return 0;
  const stats = entity.components?.stats || {};
  let bonus = 0;
  for (const [stat, letter] of Object.entries(scaling)) {
    const coeff = SCALING_COEFFS[letter as string];
    if (!coeff) continue;
    bonus += ((stats as Record<string, unknown>)[stat] as number || 0) * coeff;
  }
  return bonus;
}

function weaponRolled(entity: Combatant): RolledStats | null {
  if (entity.type !== 'player') return null;
  return entity.components?.equipment?.mainhand?.item?.components?.equipment?.rolled || null;
}

function baseDamageRange(entity: Combatant): Range {
  const rolled = weaponRolled(entity);
  if (rolled && Array.isArray(rolled.damage)) return rolled.damage;
  const range = entity.components?.stats?.damage;
  if (Array.isArray(range)) return range;
  const flat = Math.max(1, (range as number) || 1);
  return [flat, flat];
}

function strBonus(entity: Combatant): number {
  // Strength with a C-grade coefficient. Used by mobs always, and by players
  // when unarmed so stats and level still contribute to damage.
  const str = entity.components?.stats?.strength || 0;
  return Math.round(str * (SCALING_COEFFS['C'] ?? 0.4));
}

function damageBonus(entity: Combatant): number {
  if (entity.type === 'mob') return strBonus(entity);
  const scaling = weaponRolled(entity)?.scaling;
  // Unarmed players fall back to strength scaling, mirroring mobs.
  if (!scaling) return strBonus(entity);
  return Math.round(scaledBonus(entity, scaling));
}

function rollDamage(entity: Combatant): number {
  return Math.max(1, rollRange(baseDamageRange(entity)) + damageBonus(entity));
}

export function effectiveDamageRange(entity: Combatant): Range {
  const [lo, hi] = baseDamageRange(entity);
  const bonus = damageBonus(entity);
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
    return total;
  }
  // Mob defense: explicit armor value from template, or derived from constitution.
  const stats = entity.components?.stats;
  if (typeof stats?.armor === 'number') return stats.armor;
  const con = stats?.constitution || 0;
  return Math.max(0, Math.floor(con / 3));
}

export function dodgeChance(entity: Combatant): number {
  const dex = entity.components?.stats?.dexterity || 0;
  return Math.min(MAX_DODGE_PCT, dex * DODGE_PER_DEX);
}

export function applyDamage(entity: Combatant, amount: number): void {
  if (!entity.components.health) return;
  entity.components.health.current = Math.max(0, entity.components.health.current - amount);
}

export function resolveAttack(world: World, attacker: Entity, target: Entity): AttackEvent | null {
  const att = asCombatant(attacker);
  const tgt = asCombatant(target);
  if (!att || !tgt) return null;
  if (tgt.type === 'mob' && tgt.components.ai?.fixture) return null;
  if (!isAlive(tgt)) return null;
  if (tgt.position.zone !== att.position.zone) return null;
  const dx = Math.abs(att.position.x - tgt.position.x);
  const dy = Math.abs(att.position.y - tgt.position.y);
  if (Math.max(dx, dy) > 1) return null;

  if (Math.random() < dodgeChance(tgt)) {
    return {
      type: 'attack',
      attackerId: att.id,
      targetId: tgt.id,
      damage: 0,
      dodged: true,
      fatal: false,
    };
  }

  const raw = rollDamage(att);
  const floor = Math.max(1, Math.ceil(raw * MIN_DAMAGE_FRACTION));
  const reduced = Math.max(floor, raw - totalDefense(tgt));
  applyDamage(tgt, reduced);
  const fatal = (tgt.components.health?.current ?? 0) <= 0;
  return {
    type: 'attack',
    attackerId: att.id,
    targetId: tgt.id,
    damage: reduced,
    fatal,
  };
}

export function attackInFacing(world: World, attacker: Entity): AttackEvent | null {
  const att = asCombatant(attacker);
  if (!att) return null;
  const dir = DIRS[att.facing];
  if (!dir) return null;
  const tx = att.position.x + dir.dx;
  const ty = att.position.y + dir.dy;
  const target = world.entityAt(att.position.zone, tx, ty);
  if (!target) return null;
  if (att.type === 'player' && target.type === 'player') return null;
  const ev = resolveAttack(world, att, target);
  // When a player hits a non-aggressive mob, provoke it so it fights back.
  if (ev && !ev.dodged && att.type === 'player' && target.type === 'mob') {
    const ai = (target as MobEntity).components?.ai;
    if (ai && !ai.fixture && ai.behavior !== 'idle' && ai.aggro_range === 0) {
      ai.provoked = true;
      ai.target = att.id;
    }
  }
  return ev;
}
