import { applyMovement, DIRS } from './movement.ts';
import { resolveAttack, type AttackEvent } from './combat.ts';
import { isAlive } from '../entities.ts';
import type { Direction, MobEntity, Position } from '../../../shared/types.ts';
import type { World } from '../world.ts';

const BASE_ACT_TICKS = 10;
// Mobs chase a target up to this multiple of their aggro_range before giving up.
const LEASH_MULTIPLIER = 2.5;

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

function findNearestPlayer(world: World, mob: MobEntity, range: number) {
  let best = null as null | ReturnType<World['entitiesInZone']>[number];
  let bestDist = Infinity;
  for (const e of world.entitiesInZone(mob.position.zone)) {
    if (e.type !== 'player') continue;
    if (!isAlive(e)) continue;
    const d = chebyshev(mob.position, e.position);
    if (d <= range && d < bestDist) { best = e; bestDist = d; }
  }
  return best;
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
  if (!ai || ai.behavior === 'idle' || ai.behavior === 'passive') return { moved: false, events };

  const aggroRange = ai.aggro_range || 0;
  const leashRange = aggroRange * LEASH_MULTIPLIER;

  if (ai.target) {
    // Drop target if it left the zone or walked beyond leash range.
    const target = world.entities.get(ai.target);
    if (!target || target.position.zone !== mob.position.zone ||
        chebyshev(mob.position, target.position) > leashRange) {
      ai.target = null;
    }
  }

  if (!ai.target && aggroRange > 0) {
    const nearest = findNearestPlayer(world, mob, aggroRange);
    ai.target = nearest ? nearest.id : null;
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

  if (ai.behavior === 'patrol') {
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
