// Mob AI. Runs once per game tick; each mob only acts when currentTick >=
// nextActTick. Cadence derives from stats.speed: faster mobs act sooner.
// Returns the set of zones that changed (movement) plus any combat events
// the loop should fan out (attacks on players).

import { applyMovement, DIRS } from './movement.js';
import { resolveAttack } from './combat.js';
import { isAlive } from '../entities.js';

const BASE_ACT_TICKS = 10; // 1.0s at 100ms tick

function actCooldown(entity) {
  const sp = entity.components?.stats?.speed || 1.0;
  return Math.max(1, Math.round(BASE_ACT_TICKS / sp));
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function stepToward(from, to) {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  // Prefer the larger-magnitude axis so we don't oscillate.
  if (Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)) {
    if (dx > 0) return 'east';
    if (dx < 0) return 'west';
  }
  if (dy > 0) return 'south';
  if (dy < 0) return 'north';
  return null;
}

function findNearestPlayer(world, mob, range) {
  let best = null;
  let bestDist = Infinity;
  for (const e of world.entitiesInZone(mob.position.zone)) {
    if (e.type !== 'player') continue;
    if (!isAlive(e)) continue;
    const d = chebyshev(mob.position, e.position);
    if (d <= range && d < bestDist) { best = e; bestDist = d; }
  }
  return best;
}

function patrolStep(world, mob) {
  const zoneId = mob.position.zone;
  const region = mob.components.ai.spawn_region
    ? world.regionBounds(zoneId, mob.components.ai.spawn_region)
    : null;
  // 50% chance to stay put — keeps movement feeling lazy.
  if (Math.random() < 0.5) return false;
  const dirs = Object.keys(DIRS).sort(() => Math.random() - 0.5);
  for (const dir of dirs) {
    const d = DIRS[dir];
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

// One AI step for a single mob. Returns { moved, events }.
function stepMob(world, mob, currentTick) {
  const events = [];
  const ai = mob.components.ai;
  if (!ai || ai.behavior === 'idle') return { moved: false, events };

  // Acquire/refresh target.
  const range = ai.aggro_range || 0;
  if (range > 0) {
    const target = findNearestPlayer(world, mob, range);
    ai.target = target ? target.id : null;
  }

  // Chase + attack.
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

  // Default: patrol.
  if (ai.behavior === 'patrol') {
    return { moved: patrolStep(world, mob), events };
  }
  return { moved: false, events };
}

export function aiTick(world, currentTick) {
  const dirtyZones = new Set();
  const events = [];
  for (const e of world.entities.values()) {
    if (e.type !== 'mob') continue;
    if (!isAlive(e)) continue;
    if (currentTick < (e.nextActTick || 0)) continue;
    e.nextActTick = currentTick + actCooldown(e);
    const { moved, events: ev } = stepMob(world, e, currentTick);
    if (moved || ev.length > 0) dirtyZones.add(e.position.zone);
    events.push(...ev);
  }
  return { dirtyZones, events };
}
