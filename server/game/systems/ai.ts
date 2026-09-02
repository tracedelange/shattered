import { applyMovement, DIRS } from './movement.ts';
import { type AttackEvent } from './combat.ts';
import { executeAbility, abilityReady, canAfford, BASIC_ATTACK, type AbilityEvent, type CastEvent, type HealEvent } from './abilities.ts';
import { effectiveMaxHealth, effectiveMaxMana, actCooldown as sharedActCooldown, ccFlags, ccSource, isAlly } from './stats.ts';
import { isAlive } from '../entities.ts';
import {
  AGGRO_DROPOFF_PER_LEVEL, AGGRO_AVERSION_GAP,
  AGGRO_SEED_THREAT, HEAL_THREAT_FACTOR, TAUNT_THREAT_MULT, THREAT_SWITCH_MULT,
} from '../../../shared/constants.ts';
import type { AIComponent, Direction, MobEntity, PlayerEntity, Position } from '../../../shared/types.ts';
import type { World } from '../world.ts';

// Kept in sync with PLAYER_BASE_ACT_TICKS (loop.ts) so a speed-1 mob and a
// speed-1 player attack at the same rate.
const BASE_ACT_TICKS = 15;
// Mobs chase up to this multiple of their aggro_range from where they engaged.
const LEASH_MULTIPLIER = 2.5;
// Floor on that radius, so a short-sighted mob (small aggro_range) still commits
// to a real fight instead of breaking off a step after it engages — and so a
// provoked passive mob, whose natural aggro_range is 0, has a leash at all.
const LEASH_MIN_RADIUS = 12;
// A reset that hasn't reached its origin within this many ticks finishes
// wherever it stands. A returning mob is damage-immune, so it must never be able
// to home forever: greedy stepping can't retrace a path that went around a wall.
const RESET_TIMEOUT_TICKS = 300;

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

  // Ideal flee: step directly away from the source.
  const ideal = maybeConfuse(stepAway(entity.position, src.position), confused);
  if (ideal && applyMovement(world, entity, ideal)) return true;

  // Ideal tile is blocked (wall/entity). Scramble to any other open tile that
  // doesn't move *toward* the source, preferring the one that gains the most
  // distance. Without this a feared entity pins itself against a wall and
  // freezes — and because a feared player's own inputs are suppressed, that's a
  // softlock for the whole fear duration.
  const { zone } = entity.position;
  const curDist = chebyshev(entity.position, src.position);
  const candidates = (Object.keys(DIRS) as Direction[])
    .map((dir) => ({
      dir,
      dist: chebyshev({ zone, x: entity.position.x + DIRS[dir]!.dx, y: entity.position.y + DIRS[dir]!.dy }, src.position),
    }))
    .filter((c) => c.dist >= curDist)
    .sort((a, b) => b.dist - a.dist);
  for (const c of candidates) {
    if (applyMovement(world, entity, c.dir)) return true;
  }
  return false;
}

// The chase radius around `leash_origin`. A template may pin it explicitly
// (leash_radius); otherwise it scales with aggro_range under a floor.
function leashRadius(ai: AIComponent): number {
  if (ai.leash_radius !== undefined) return ai.leash_radius;
  return Math.max(LEASH_MIN_RADIUS, (ai.aggro_range || 0) * LEASH_MULTIPLIER);
}

// ─── Threat table ──────────────────────────────────────────────────────────
// Every engaged mob keeps a per-attacker tally (AIComponent.threat) of what
// each combatant has done to hold its attention, and picks its target off that
// tally rather than off proximity. Damage credits its dealer 1:1; healing
// credits the healer a fraction of the amount healed, on every mob already
// fighting the person healed. That's what makes a tank possible: without a
// table, a pack fans out over whoever each member happened to stand nearest to,
// and everyone in the group gets hit.
//
// The table is fight-scoped — dropThreat and breakLeash wipe it — so it never
// grows past the handful of combatants in one engagement and never needs a
// decay pass.

// True while this mob is holding a fight open (something is on its table).
function hasThreat(ai: AIComponent): boolean {
  return !!ai.threat && Object.keys(ai.threat).length > 0;
}

/** Credit `sourceId` with threat on this mob. No-op for the mobs that are not
 *  really combatants (fixtures, practice dummies) or one already walking home. */
export function addThreat(mob: MobEntity, sourceId: string, amount: number): void {
  const ai = mob.components.ai;
  if (!ai || ai.fixture || ai.inert || ai.resetting) return;
  if (amount <= 0 || sourceId === mob.id) return;
  const table = (ai.threat ??= {});
  table[sourceId] = (table[sourceId] ?? 0) + amount;
}

/** Drop one combatant from a mob's table (they died, left, or were never a real
 *  participant). Ends the fight outright if they were the last entry. */
export function forgetThreat(mob: MobEntity, sourceId: string): void {
  const ai = mob.components.ai;
  if (!ai?.threat) return;
  delete ai.threat[sourceId];
  if (ai.target === sourceId) ai.target = null;
  if (!hasThreat(ai)) dropThreat(ai);
}

// Highest-threat entry that is still a live combatant in this mob's zone,
// pruning the entries that aren't as it goes.
function topThreat(world: World, mob: MobEntity): { id: string; value: number } | null {
  const table = mob.components.ai.threat;
  if (!table) return null;
  let best: { id: string; value: number } | null = null;
  for (const [id, value] of Object.entries(table)) {
    const e = world.entities.get(id);
    if (!e || (e.type !== 'player' && e.type !== 'mob') || !isAlive(e) || e.position.zone !== mob.position.zone) {
      delete table[id];
      continue;
    }
    if (!best || value > best.value) best = { id, value };
  }
  return best;
}

// Lift `sourceId` above everyone else on the table. A taunt forces the target
// outright while its CC lasts; this is what stops the mob snapping straight
// back to the previous top the instant it expires.
function pullThreatToTop(mob: MobEntity, sourceId: string): void {
  const ai = mob.components.ai;
  if (!ai || ai.fixture || ai.inert || ai.resetting) return;
  const table = (ai.threat ??= {});
  let max = 0;
  for (const [id, v] of Object.entries(table)) if (id !== sourceId && v > max) max = v;
  const floor = Math.max(AGGRO_SEED_THREAT, max * TAUNT_THREAT_MULT);
  if ((table[sourceId] ?? 0) < floor) table[sourceId] = floor;
}

/** Fold one landed hit into the victim's table. Called once per attack event by
 *  the loop rather than from combat.ts, so the AI module stays the only owner
 *  of the table (and combat.ts doesn't have to import it back). */
export function creditDamageThreat(world: World, ev: AttackEvent): void {
  if (ev.damage <= 0) return;
  const victim = world.entities.get(ev.targetId);
  if (victim?.type !== 'mob') return;
  addThreat(victim, ev.attackerId, ev.damage);
}

/** Fold one heal into the tables of every mob already fighting the person
 *  healed — the healer is helping their enemy stay alive, so it notices. A heal
 *  on someone nothing is fighting generates no threat at all. */
export function creditHealThreat(world: World, ev: HealEvent): void {
  if (ev.amount <= 0) return;
  const healed = world.entities.get(ev.targetId);
  if (!healed) return;
  const amount = ev.amount * HEAL_THREAT_FACTOR;
  for (const e of world.entitiesInZone(healed.position.zone)) {
    if (e.type !== 'mob' || !isAlive(e)) continue;
    if (!e.components.ai?.threat?.[ev.targetId]) continue;
    addThreat(e, ev.sourceId, amount);
  }
}

/** Wipe one combatant off every mob's table world-wide. Used when a player dies
 *  (server/index.ts): the mobs that killed them reset, but a mob that merely
 *  traded a hit somewhere else must not keep a respawned player as its top
 *  threat and go hunting. */
export function clearThreatOn(world: World, sourceId: string): void {
  for (const e of world.entities.values()) {
    if (e.type !== 'mob') continue;
    if (!e.components.ai?.threat?.[sourceId]) continue;
    forgetThreat(e, sourceId);
  }
}

// Threat acquisition. Also pins the leash origin — the tile the mob engaged
// from — since that, not the target's position, is what the leash measures.
function acquire(mob: MobEntity, targetId: string): void {
  const ai = mob.components.ai;
  ai.target = targetId;
  ai.leash_origin ??= { x: mob.position.x, y: mob.position.y };
}

// Threat drop without a reset: the fight ended on its own terms (target dead or
// gone from the world), so there is nothing to restore or retreat from.
function dropThreat(ai: AIComponent): void {
  ai.target = null;
  ai.provoked = false;
  ai.leash_origin = undefined;
  ai.threat = undefined;
}

/** Leash break: the mob broke off a fight it did not lose (the target outran the
 *  leash, left the zone, or killed the mob's would-be victim... i.e. the player
 *  died). Drop threat, restore the mob to full, and send it walking back to
 *  where it engaged.
 *
 *  The full restore is the point of the mechanic, not a courtesy: out-of-combat
 *  regen is 1 hp per 10 ticks (loop.ts), so without a reset any mob — the War
 *  Chanter being the worst case, a level-19 support that retreats to
 *  preferred_range and can be dragged clear of the pack whose allies its whole
 *  kit needs — can be whittled down for free across repeated hit-and-run
 *  passes by a player who never has to win an exchange. */
export function breakLeash(mob: MobEntity, currentTick: number): void {
  const ai = mob.components.ai;
  if (!ai) return;
  ai.target = null;
  ai.provoked = false;
  ai.threat = undefined;
  // A reset drops lingering dots/debuffs too — otherwise a poison outlives the
  // restore and can kill a mob that is immune to everything else.
  mob.components.modifiers = [];
  if (mob.components.health) mob.components.health.current = effectiveMaxHealth(mob);
  if (mob.components.mana) mob.components.mana.current = effectiveMaxMana(mob);
  const home = ai.leash_origin;
  if (home && (mob.position.x !== home.x || mob.position.y !== home.y)) {
    ai.resetting = true;
    ai.reset_deadline = currentTick + RESET_TIMEOUT_TICKS;
  } else {
    finishReset(ai);
  }
}

function finishReset(ai: AIComponent): void {
  ai.resetting = false;
  ai.reset_deadline = undefined;
  ai.leash_origin = undefined;
}

// One step of the walk home. Greedy, like every other mob move: step toward the
// origin, and if that tile is blocked take any step that doesn't lose ground
// (mirrors the fear scramble) so a single obstacle doesn't stall the reset.
function stepHome(world: World, mob: MobEntity, home: { x: number; y: number }): boolean {
  const { zone } = mob.position;
  const dest = { zone, x: home.x, y: home.y };
  const ideal = stepToward(mob.position, dest);
  if (ideal && applyMovement(world, mob, ideal)) return true;
  const cur = chebyshev(mob.position, dest);
  const candidates = (Object.keys(DIRS) as Direction[])
    .map((dir) => ({
      dir,
      dist: chebyshev({ zone, x: mob.position.x + DIRS[dir]!.dx, y: mob.position.y + DIRS[dir]!.dy }, dest),
    }))
    .filter((c) => c.dist <= cur)
    .sort((a, b) => a.dist - b.dist);
  for (const c of candidates) {
    if (applyMovement(world, mob, c.dir)) return true;
  }
  return false;
}

function patrolStep(world: World, mob: MobEntity): boolean {
  const zoneId = mob.position.zone;
  const region = mob.components.ai.spawn_region
    ? world.regionBounds(zoneId, mob.components.ai.spawn_region)
    : null;
  const anchor = mob.components.ai.wander_anchor;
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
    // Wilderness packs have no named region to bound them — hold a pack
    // together by keeping each member within a radius of its shared anchor
    // instead, so it reads as one roaming group rather than independent drift.
    if (anchor && chebyshev({ zone: zoneId, x: nx, y: ny }, { zone: zoneId, x: anchor.x, y: anchor.y }) > anchor.radius) continue;
    if (applyMovement(world, mob, dir)) return true;
  }
  return false;
}

// Alerts idle packmates (same groupId, no current target) within earshot when
// one member aggros — otherwise only the mob that happened to notice the
// player would fight, and the rest of the "pack" would stand there. The alert
// only seats the target on each packmate's threat table; their own selection
// pass turns that into a target, so a packmate that then gets taunted or
// out-threatened by someone else responds like any other engaged mob.
const GROUP_ALERT_RANGE = 10;
function alertGroup(world: World, mob: MobEntity, targetId: string): void {
  const groupId = mob.components.ai.groupId;
  if (!groupId) return;
  for (const e of world.entitiesInZone(mob.position.zone)) {
    if (e.type !== 'mob' || e.id === mob.id || !isAlive(e)) continue;
    const ai = e.components.ai;
    if (ai?.groupId !== groupId || ai.target || hasThreat(ai)) continue;
    if (ai.resetting) continue; // mid-reset packmates stay out of the fight
    if (chebyshev(mob.position, e.position) > GROUP_ALERT_RANGE) continue;
    addThreat(e, targetId, AGGRO_SEED_THREAT);
  }
}

interface MobStepResult { moved: boolean; events: (AttackEvent | CastEvent)[]; dirty?: boolean }

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
//   1. resetting (walking home after a leash break) — ignores everything else
//   2. idle/passive frozen unless provoked
//   3. target validity / leash check
//   4. fear (flee its source) / antagonize (forced target to its source,
//      overriding the threat table) — fear wins if both are active at once
//   5. aggro scan seeds the threat table (or flee-from-stronger-player), then
//      target selection off the table
//   6. cast ability (special abilities, incl. ranged) — stun/silence gated inside
//   7. kiting: hold preferred_range instead of closing, if set
//   8. melee if adjacent
//   9. step toward target — confuse randomizes the direction here and in 7/10
//   10. flee from much-weaker threat
//   11. patrol/wander fallback
// Stun/root are enforced at the primitive level (applyMovement, executeAbility),
// not with a separate top-of-function gate — every branch above already routes
// through one of those two calls, so a stunned/rooted mob naturally no-ops.
function stepMob(world: World, mob: MobEntity, currentTick: number): MobStepResult {
  const events: (AttackEvent | CastEvent)[] = [];
  const ai = mob.components.ai;
  if (!ai) return { moved: false, events };
  const confused = ccFlags(mob).has('confuse');

  // Resetting: this mob's leash broke, so it is walking back to where it engaged
  // and is out of the fight until it arrives — no aggro, no provocation, no
  // damage (see isResetting in stats.ts). Sits above the idle/passive gate so a
  // provoked townsfolk NPC that got towed also finds its way home.
  if (ai.resetting) {
    const home = ai.leash_origin;
    if (!home || (mob.position.x === home.x && mob.position.y === home.y) ||
        currentTick >= (ai.reset_deadline ?? 0)) {
      finishReset(ai);
      return { moved: false, events };
    }
    return { moved: stepHome(world, mob, home), events };
  }

  // Idle and passive mobs (townsfolk NPCs, critters) do nothing until provoked
  // by a player attack — then they turn and defend themselves.
  if (ai.behavior === 'idle' && !ai.provoked) return { moved: false, events };
  if (ai.behavior === 'passive' && !ai.provoked) return { moved: false, events };

  const aggroRange = ai.behavior === 'passive' ? 0 : (ai.aggro_range || 0);

  if (ai.target) {
    // The leash is a radius around the tile this mob engaged from, not around
    // its target: a mob that keeps pace with a fleeing player never used to
    // exceed a target-relative leash at all, so any mob could be towed across
    // the world (into a low-level zone, or away from the pack its kit depends
    // on) and killed at leisure. Externally set threat (abilities.ts provoking
    // a non-aggressive mob) may not have pinned an origin yet — do it here.
    const origin = (ai.leash_origin ??= { x: mob.position.x, y: mob.position.y });
    const radius = leashRadius(ai);
    const target = world.entities.get(ai.target);
    if (!target || !isAlive(target)) {
      // That combatant is out of the fight for good — drop them from the table
      // and let the selection pass below hand the mob to whoever is next on it.
      // A group fight carries on; an empty table ends it (forgetThreat calls
      // dropThreat), and there's nothing to reset or retreat from either way.
      forgetThreat(mob, ai.target);
    } else if (target.position.zone !== mob.position.zone ||
               chebyshev(mob.position, { zone: mob.position.zone, ...origin }) > radius ||
               chebyshev(mob.position, target.position) > radius) {
      // Three ways out, one consequence. The origin check is the tow fix; the
      // target-distance check still matters on its own, because a mob slower
      // than its target never travels far enough for the origin check to fire
      // and would otherwise hold threat on someone already long gone; zoning out
      // counts too. All of them reset, so no escape hatch leaves a chipped-down
      // mob behind to come back to.
      breakLeash(mob, currentTick);
      return { moved: false, events, dirty: true };
    }
  }

  // Fear: overrides everything else this tick — flee the CC source directly,
  // skipping aggro/engage entirely. Shared with the player-side fear pass in
  // loop.ts (see applyFearFlee) since the behavior is identical for both.
  if (ccFlags(mob).has('fear')) {
    const moved = applyFearFlee(world, mob, confused);
    return { moved, events };
  }

  // Antagonize: a forced-target override. While the CC is active the taunter
  // IS the target, whatever the threat table says — and the taunter is pulled
  // to the top of the table too, so the mob doesn't snap back the instant the
  // CC drops. Still subject to the leash check above on later ticks.
  const antagonizeSrc = ccFlags(mob).has('antagonize') ? ccSource(mob, 'antagonize') : undefined;
  let forced: string | null = null;
  if (antagonizeSrc) {
    const src = world.entities.get(antagonizeSrc);
    if (src && (src.type === 'player' || src.type === 'mob') && src.position.zone === mob.position.zone && isAlive(src)) {
      forced = antagonizeSrc;
      pullThreatToTop(mob, forced);
      acquire(mob, forced);
    }
  }

  // Only aggressive mobs scan for new targets, and only while they're out of a
  // fight — a mob already holding a table doesn't pick up bystanders, it fights
  // whoever earned its attention. The scan seats the player on the table; the
  // selection pass right below turns that into an actual target.
  let fleeFrom: Position | null = null;
  if (!forced && !ai.target && !hasThreat(ai) && aggroRange > 0) {
    const { aggro, flee } = assessNearbyPlayers(world, mob);
    if (aggro) { addThreat(mob, aggro.id, AGGRO_SEED_THREAT); alertGroup(world, mob, aggro.id); }
    else if (flee) fleeFrom = flee.position;
  }

  // Target selection off the threat table. The top entry holds the mob, and a
  // challenger has to beat the current target by THREAT_SWITCH_MULT to pull it
  // — without that margin two similar attackers make it flip every tick and it
  // never lands a swing on either. An empty table leaves ai.target alone:
  // threat set from outside (abilities.ts provoking a mob whose hit was dodged)
  // has no entry yet and would otherwise be cleared before it ever acted.
  if (!forced) {
    const top = topThreat(world, mob);
    if (top) {
      const current = ai.target ? (ai.threat?.[ai.target] ?? 0) : 0;
      if (!ai.target || (top.id !== ai.target && top.value > current * THREAT_SWITCH_MULT)) {
        acquire(mob, top.id);
      }
    } else if (ai.target && !hasThreat(ai) && !ai.provoked) {
      // Table emptied out (everyone on it died or left the zone) but a stale
      // target id survived — end the fight rather than chase a ghost.
      dropThreat(ai);
    }
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
    const { moved, events: ev, dirty } = stepMob(world, e, currentTick);
    if (moved || dirty || ev.length > 0) dirtyZones.add(e.position.zone);
    events.push(...ev);
  }
  return { dirtyZones, events };
}
