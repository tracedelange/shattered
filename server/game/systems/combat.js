import { DIRS } from './movement.js';
import { rollRange } from '../items/generator.js';
import { isAlive } from '../entities.js';

// Equipped mainhand weapon overrides the entity's intrinsic damage range.
function baseDamageRange(entity) {
  const weaponDamage = entity.components?.equipment?.mainhand?.item?.components?.equipment?.rolled?.damage;
  if (Array.isArray(weaponDamage)) return weaponDamage;
  const range = entity.components?.stats?.damage;
  if (Array.isArray(range)) return range;
  const flat = Math.max(1, range || 1);
  return [flat, flat];
}

function rollDamage(entity) {
  const str = entity.components?.stats?.strength || 0;
  return Math.max(1, rollRange(baseDamageRange(entity)) + str);
}

export function effectiveDamageRange(entity) {
  const [lo, hi] = baseDamageRange(entity);
  const str = entity.components?.stats?.strength || 0;
  return [lo + str, hi + str];
}

export function applyDamage(entity, amount) {
  if (!entity.components.health) return;
  entity.components.health.current = Math.max(0, entity.components.health.current - amount);
}

// Direct attack between two known entities (used by AI when adjacent to target).
// Returns an event { type, attackerId, targetId, damage, fatal } or null.
export function resolveAttack(world, attacker, target) {
  if (!isAlive(target)) return null;
  if (target.position.zone !== attacker.position.zone) return null;
  const dx = Math.abs(attacker.position.x - target.position.x);
  const dy = Math.abs(attacker.position.y - target.position.y);
  if (Math.max(dx, dy) > 1) return null;

  const dmg = rollDamage(attacker);
  applyDamage(target, dmg);
  const fatal = (target.components.health?.current ?? 0) <= 0;
  return {
    type: 'attack',
    attackerId: attacker.id,
    targetId: target.id,
    damage: dmg,
    fatal,
  };
}

// Player-issued attack: hit the entity in the facing tile.
export function attackInFacing(world, attacker) {
  const dir = DIRS[attacker.facing];
  if (!dir) return null;
  const tx = attacker.position.x + dir.dx;
  const ty = attacker.position.y + dir.dy;
  const target = world.entityAt(attacker.position.zone, tx, ty);
  if (!target) return null;
  // No friendly-fire on other players for now.
  if (attacker.type === 'player' && target.type === 'player') return null;
  return resolveAttack(world, attacker, target);
}
