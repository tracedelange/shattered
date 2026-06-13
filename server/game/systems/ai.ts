import { applyMovement, DIRS } from './movement.ts';
import { resolveAttack, type AttackEvent } from './combat.ts';
import { isAlive } from '../entities.ts';
import { AGGRO_DROPOFF_PER_LEVEL, AGGRO_AVERSION_GAP } from '../../../shared/constants.ts';
import type { Direction, MobEntity, PlayerEntity, Position } from '../../../shared/types.ts';
import type { World } from '../world.ts';

const BASE_ACT_TICKS = 10;
// Mobs chase a target up to this multiple of their aggro_range before giving up.
const LEASH_MULTIPLIER = 2.5;
// Non-aggressive mobs defending themselves chase the attacker up to this many tiles.
const PROVOKED_LEASH = 8;

function actCooldown(entity: MobEntity): number {
  const sp = entity.components?.stats?.speed || 1.0;
  return Math.max(1, Math.round(BASE_ACT_TICKS / sp));
}

function chebyshev(a: Position, b: Position): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function stepToward(from: Position, to: Position): Direction | null {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  if (Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)) {
    if (dx > 0) return 'east';
    if (dx < 0) return 'west';
  }
  if (dy > 0) return 'south';
  if (dy < 0) return 'north';
  return null;
}

function stepAway(from: Position, threat: Position): Direction | null {
  // Move directly away from the threat: invert the toward vector.
  const dx = Math.sign(from.x - threat.x);
  const dy = Math.sign(from.y - threat.y);
  if (Math.abs(from.x - threat.x) >= Math.abs(from.y - threat.y)) {
    if (dx > 0) return 'east';
    if (dx < 0) return 'west';
  }
  if (dy > 0) return 'south';
  if (dy < 0) return 'north';
  return null;
}

// Assess players within the mob's aggro_range by relative level. The mob aggros
// the nearest player it's willing to engage (full range at parity/stronger,
// shrinking as the player out-levels it); players AGGRO_AVERSION_GAP+ levels
// above are threats it would rather flee from than fight.
function assessNearbyPlayers(world: World, mob: MobEntity): { aggro: PlayerEntity | null; flee: PlayerEntity | null } {
  const baseRange = mob.components.ai.aggro_range || 0;
  let aggro: PlayerEntity | null = null, aggroDist = Infinity;
  let flee: PlayerEntity | null = null, fleeDist = Infinity;
  for (const e of world.entitiesInZone(mob.position.zone)) {
    if (e.type !== 'player') continue;
    if (!isAlive(e)) continue;
    const d = chebyshev(mob.position, e.position);
    if (d > baseRange) continue;
    const levelGap = e.components.progress.level - mob.level; // > 0: player is stronger
    if (levelGap >= AGGRO_AVERSION_GAP) {
      if (d < fleeDist) { flee = e; fleeDist = d; }
      continue;
    }
    const effRange = baseRange - Math.max(0, levelGap) * AGGRO_DROPOFF_PER_LEVEL;
    if (d <= effRange && d < aggroDist) { aggro = e; aggroDist = d; }
  }
  return { aggro, flee };
}

function patrolStep(world: World, mob: MobEntity): boolean {
  const zoneId = mob.position.zone;
  const region = mob.components.ai.spawn_region
    ? world.regionBounds(zoneId, mob.components.ai.spawn_region)
    : null;
  if (Math.random() < 0.5) return false;
  const dirs = (Object.keys(DIRS) as Direction[]).sort(() => Math.random() - 0.5);
  for (const dir of dirs) {
    const d = DIRS[dir]!;
    const nx = mob.position.x + d.dx;
    const ny = mob.position.y + d.dy;
    if (region) {
      if (nx <= region.x || nx >= region.x + region.w - 1) continue;
      if (ny <= region.y || ny >= region.y + region.h - 1) continue;
    }
    if (applyMovement(world, mob, dir)) return true;
  }
  return false;
}

interface MobStepResult { moved: boolean; events: AttackEvent[] }

function stepMob(world: World, mob: MobEntity): MobStepResult {
  const events: AttackEvent[] = [];
  const ai = mob.components.ai;
  if (!ai || ai.behavior === 'idle') return { moved: false, events };

  // Passive mobs skip all AI unless provoked by a player attack.
  if (ai.behavior === 'passive' && !ai.provoked) return { moved: false, events };

  const aggroRange = ai.behavior === 'passive' ? 0 : (ai.aggro_range || 0);
  // Provoked mobs (passive behavior or zero aggro_range) use PROVOKED_LEASH;
  // normal aggressive mobs use the standard leash multiplier.
  const leashRange = ai.provoked ? PROVOKED_LEASH : aggroRange * LEASH_MULTIPLIER;

  if (ai.target) {
    // Drop target if it left the zone, is dead, or walked beyond leash range.
    const target = world.entities.get(ai.target);
    if (!target || target.position.zone !== mob.position.zone ||
        !isAlive(target) ||
        chebyshev(mob.position, target.position) > leashRange) {
      ai.target = null;
      ai.provoked = false;
    }
  }

  // Only aggressive mobs scan for new targets; provoked mobs already have a target set.
  let fleeFrom: Position | null = null;
  if (!ai.target && aggroRange > 0) {
    const { aggro, flee } = assessNearbyPlayers(world, mob);
    if (aggro) ai.target = aggro.id;
    else if (flee) fleeFrom = flee.position;
  }

  if (ai.target) {
    const target = world.entities.get(ai.target);
    if (target && target.position.zone === mob.position.zone) {
      const dist = chebyshev(mob.position, target.position);
      if (dist <= 1) {
        const ev = resolveAttack(world, mob, target);
        if (ev) events.push(ev);
        return { moved: false, events };
      }
      const dir = stepToward(mob.position, target.position);
      if (dir && applyMovement(world, mob, dir)) return { moved: true, events };
    }
  }

  // Much-weaker mob with a high-level player nearby: back away instead of fighting.
  if (fleeFrom) {
    const dir = stepAway(mob.position, fleeFrom);
    if (dir && applyMovement(world, mob, dir)) return { moved: true, events };
    return { moved: false, events };
  }

  if (ai.behavior === 'patrol' || ai.behavior === 'wander') {
    return { moved: patrolStep(world, mob), events };
  }
  return { moved: false, events };
}

export interface AITickResult { dirtyZones: Set<string>; events: AttackEvent[] }

export function aiTick(world: World, currentTick: number): AITickResult {
  const dirtyZones = new Set<string>();
  const events: AttackEvent[] = [];
  for (const e of world.entities.values()) {
    if (e.type !== 'mob') continue;
    if (!isAlive(e)) continue;
    if (currentTick < (e.nextActTick || 0)) continue;
    e.nextActTick = currentTick + actCooldown(e);
    const { moved, events: ev } = stepMob(world, e);
    if (moved || ev.length > 0) dirtyZones.add(e.position.zone);
    events.push(...ev);
  }
  return { dirtyZones, events };
}
