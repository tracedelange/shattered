import { applyMovement, DIRS } from './movement.ts';
import { type AttackEvent } from './combat.ts';
import { executeAbility, abilityReady, canAfford, BASIC_ATTACK, type AbilityEvent, type CastEvent } from './abilities.ts';
import { effectiveMaxHealth, actCooldown as sharedActCooldown, ccFlags, ccSource, isAlly } from './stats.ts';
import { isAlive } from '../entities.ts';
import { AGGRO_DROPOFF_PER_LEVEL, AGGRO_AVERSION_GAP } from '../../../shared/constants.ts';
import type { Direction, MobEntity, PlayerEntity, Position } from '../../../shared/types.ts';
import type { World } from '../world.ts';

// Kept in sync with PLAYER_BASE_ACT_TICKS (loop.ts) so a speed-1 mob and a
// speed-1 player attack at the same rate.
const BASE_ACT_TICKS = 15;
// Mobs chase a target up to this multiple of their aggro_range before giving up.
const LEASH_MULTIPLIER = 2.5;
// Non-aggressive mobs defending themselves chase the attacker up to this many tiles.
const PROVOKED_LEASH = 8;

function actCooldown(entity: MobEntity): number {
  return sharedActCooldown(entity, BASE_ACT_TICKS);
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

// Fisher-Yates: `.sort(() => Math.random() - 0.5)` is not a uniform shuffle and
// biases toward the original DIRS order (north/east first), drifting mobs up-right.
function shuffledDirs(): Direction[] {
  const dirs = Object.keys(DIRS) as Direction[];
  for (let i = dirs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j]!, dirs[i]!];
  }
  return dirs;
}

// A confused actor's intended direction is discarded for a random one instead.
// Exported so loop.ts can apply the same randomization to a confused player's
// manual movement input (mob confusion was already handled here; player
// confusion had no enforcement anywhere until this was shared).
export function maybeConfuse(dir: Direction | null, confused: boolean): Direction | null {
  return confused ? shuffledDirs()[0]! : dir;
}

// Fear's actual movement: step away from its CC source, if one still exists
// in the same zone. Shared by mob AI (stepMob, above) and the player-side
// fear pass (loop.ts) — a feared player has no autonomous "turn" the way a
// mob does, so loop.ts calls this directly once per tick instead.
// Returns whether a flee step was actually taken (false if no valid source,
// or the escape tile was blocked).
export function applyFearFlee(world: World, entity: PlayerEntity | MobEntity, confused: boolean): boolean {
  const fearSrc = ccFlags(entity).has('fear') ? ccSource(entity, 'fear') : undefined;
  if (!fearSrc) return false;
  const src = world.entities.get(fearSrc);
  if (!src || (src.type !== 'player' && src.type !== 'mob') || src.position.zone !== entity.position.zone) return false;
  const dir = maybeConfuse(stepAway(entity.position, src.position), confused);
  return !!dir && applyMovement(world, entity, dir);
}

function patrolStep(world: World, mob: MobEntity): boolean {
  const zoneId = mob.position.zone;
  const region = mob.components.ai.spawn_region
    ? world.regionBounds(zoneId, mob.components.ai.spawn_region)
    : null;
  if (Math.random() < 0.5) return false;
  const dirs = shuffledDirs();
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

interface MobStepResult { moved: boolean; events: (AttackEvent | CastEvent)[] }

// Nearest ally within range, preferring the most wounded (by hp fraction) —
// the natural pick for a heal/buff. Excludes the caster itself.
function findAllyTarget(world: World, mob: MobEntity, range: number): MobEntity | null {
  let best: MobEntity | null = null, bestFrac = Infinity;
  for (const e of world.entitiesInZone(mob.position.zone)) {
    if (e.id === mob.id || e.type !== 'mob' || !isAlive(e)) continue;
    if (chebyshev(mob.position, e.position) > range) continue;
    if (!isAlly(world, mob, e)) continue;
    const frac = e.components.health.current / effectiveMaxHealth(e);
    if (frac < bestFrac) { best = e; bestFrac = frac; }
  }
  return best;
}

// Pick and fire the best eligible mob ability against the target, if any.
// Eligible = ability exists, off cooldown, affordable, conditions met (hp_below),
// and the target is within the ability's range (self abilities ignore range).
// Highest weight wins; returns the cast's attack events, or null to fall through
// to the basic attack / movement.
function castMobAbility(world: World, mob: MobEntity, target: MobEntity | PlayerEntity, tick: number): (AttackEvent | CastEvent)[] | null {
  const entries = mob.components.ai.abilities;
  if (!entries || entries.length === 0) return null;
  const dist = chebyshev(mob.position, target.position);
  const hpFrac = mob.components.health.current / effectiveMaxHealth(mob);

  let best: { def: typeof BASIC_ATTACK; weight: number } | null = null;
  for (const e of entries) {
    const def = world.defs.abilities?.[e.ability];
    if (!def) continue;
    if (e.hp_below !== undefined && hpFrac >= e.hp_below) continue;
    // Anything landing on the enemy (side 'enemy'/'any', the default) is
    // range-gated against it, whether or not it deals damage — a pure debuff
    // like weakening_curse still has to actually reach the target. Ally-side
    // and self-shaped abilities skip this gate; findAllyTarget/self-cast below
    // handle their own range.
    const side = def.targeting.side ?? 'enemy';
    if (def.targeting.shape !== 'self' && side !== 'ally' && dist > def.targeting.range) continue;
    if (!abilityReady(mob, def, tick) || !canAfford(mob, def)) continue;
    const weight = e.weight ?? 1;
    if (!best || weight > best.weight) best = { def, weight };
  }
  if (!best) return null;

  // Self-shaped abilities always self-cast; ally-side abilities target the
  // neediest ally in range; everything else (the default) lands on the enemy
  // this mob is fighting — whether or not it deals damage.
  const bestSide = best.def.targeting.side ?? 'enemy';
  let recipient: string;
  if (best.def.targeting.shape === 'self') {
    recipient = mob.id;
  } else if (bestSide === 'ally') {
    const ally = findAllyTarget(world, mob, best.def.targeting.range);
    if (!ally) return null; // no valid ally in range — fall through to melee/movement
    recipient = ally.id;
  } else {
    recipient = target.id;
  }
  const res = executeAbility(world, mob, best.def, tick, recipient);
  if (!res.cast) return null;
  return res.events.filter((ev: AbilityEvent): ev is AttackEvent | CastEvent => ev.type === 'attack' || ev.type === 'cast');
}

// Decision priority (each new encounter dimension's AI hook must slot into this
// named order, not wherever is locally convenient):
//   1. idle/passive frozen unless provoked
//   2. target validity / leash check
//   3. fear (flee its source) / antagonize (forced target to its source) —
//      fear wins if somehow both are active at once
//   4. aggro scan (or flee-from-stronger-player)
//   5. cast ability (special abilities, incl. ranged) — stun/silence gated inside
//   6. kiting: hold preferred_range instead of closing, if set
//   7. melee if adjacent
//   8. step toward target — confuse randomizes the direction here and in 6/9
//   9. flee from much-weaker threat
//   10. patrol/wander fallback
// Stun/root are enforced at the primitive level (applyMovement, executeAbility),
// not with a separate top-of-function gate — every branch above already routes
// through one of those two calls, so a stunned/rooted mob naturally no-ops.
function stepMob(world: World, mob: MobEntity, currentTick: number): MobStepResult {
  const events: (AttackEvent | CastEvent)[] = [];
  const ai = mob.components.ai;
  if (!ai) return { moved: false, events };
  const confused = ccFlags(mob).has('confuse');

  // Idle and passive mobs (townsfolk NPCs, critters) do nothing until provoked
  // by a player attack — then they turn and defend themselves.
  if (ai.behavior === 'idle' && !ai.provoked) return { moved: false, events };
  if (ai.behavior === 'passive' && !ai.provoked) return { moved: false, events };

  const aggroRange = ai.behavior === 'passive' ? 0 : (ai.aggro_range || 0);
  // Normal leash scales with aggro range; being provoked (hit by a player)
  // grants at least PROVOKED_LEASH so passive/idle mobs (natural leash 0) still
  // commit to the fight. It only ever *extends* the leash — an aggressive mob's
  // natural leash must not shrink just because you struck it, otherwise chase
  // distance flip-flops as `provoked` toggles at the boundary.
  const naturalLeash = aggroRange * LEASH_MULTIPLIER;
  const leashRange = ai.provoked ? Math.max(naturalLeash, PROVOKED_LEASH) : naturalLeash;

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

  // Fear: overrides everything else this tick — flee the CC source directly,
  // skipping aggro/engage entirely. Shared with the player-side fear pass in
  // loop.ts (see applyFearFlee) since the behavior is identical for both.
  if (ccFlags(mob).has('fear')) {
    const moved = applyFearFlee(world, mob, confused);
    return { moved, events };
  }

  // Antagonize: force target to the CC source every tick while active,
  // preempting the normal aggro scan below (still subject to the leash check
  // above via ai.target on subsequent ticks).
  const antagonizeSrc = ccFlags(mob).has('antagonize') ? ccSource(mob, 'antagonize') : undefined;
  if (antagonizeSrc) {
    const src = world.entities.get(antagonizeSrc);
    if (src && (src.type === 'player' || src.type === 'mob') && src.position.zone === mob.position.zone && isAlive(src)) {
      ai.target = antagonizeSrc;
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
    if (target && (target.type === 'player' || target.type === 'mob') && target.position.zone === mob.position.zone) {
      const dist = chebyshev(mob.position, target.position);
      // A special ability (ranged spit, charge, self-buff) takes priority when
      // eligible; otherwise melee if adjacent, otherwise close the distance.
      const abilityEvents = castMobAbility(world, mob, target, currentTick);
      if (abilityEvents) {
        events.push(...abilityEvents);
        return { moved: false, events };
      }
      // Kiting: a mob with a preferred_range holds distance rather than closing
      // to melee between casts, as long as an escape tile is actually open.
      if (ai.preferred_range && dist < ai.preferred_range) {
        const away = maybeConfuse(stepAway(mob.position, target.position), confused);
        if (away && applyMovement(world, mob, away)) return { moved: true, events };
      }
      if (dist <= 1) {
        const res = executeAbility(world, mob, BASIC_ATTACK, currentTick, target.id);
        for (const ev of res.events) if (ev.type === 'attack') events.push(ev);
        return { moved: false, events };
      }
      const dir = maybeConfuse(stepToward(mob.position, target.position), confused);
      if (dir && applyMovement(world, mob, dir)) return { moved: true, events };
    }
  }

  // Much-weaker mob with a high-level player nearby: back away instead of fighting.
  if (fleeFrom) {
    const dir = maybeConfuse(stepAway(mob.position, fleeFrom), confused);
    if (dir && applyMovement(world, mob, dir)) return { moved: true, events };
    return { moved: false, events };
  }

  if (ai.behavior === 'patrol' || ai.behavior === 'wander') {
    return { moved: patrolStep(world, mob), events };
  }
  return { moved: false, events };
}

export interface AITickResult { dirtyZones: Set<string>; events: (AttackEvent | CastEvent)[] }

export function aiTick(world: World, currentTick: number): AITickResult {
  const dirtyZones = new Set<string>();
  const events: (AttackEvent | CastEvent)[] = [];
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
