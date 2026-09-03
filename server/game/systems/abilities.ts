// The ability executor — the single entry point both controllers (player input,
// mob AI) call. It resolves targets by shape, then applies each effect. An
// ability describes WHAT happens; the caller decides WHEN (see docs/plan-abilities.md).
//
// Effects: `damage` and `heal` route through combat's shared mitigation core
// (applyResolvedDamage) so dodge/armor behave identically; `modifier` pushes a
// timed status effect (buff/debuff, and dot/hot via its tick_effect). `move` is
// step 6 — a no-op here for now.

import { rollRange } from '../items/generator.ts';
import { isAlive } from '../entities.ts';
import { DIRS } from './movement.ts';
import { MANA_COMBAT_LOCKOUT_TICKS, MODIFIER_TICK_INTERVAL_TICKS, UNARMED_ATTACK_ID, WEAPON_ATTACK_ID } from '../../../shared/constants.ts';
import { applyResolvedDamage, applyDamage, rollDamage, scaledBonus, resistanceMult, weaponBrand, type AttackEvent } from './combat.ts';
import { effectiveMaxHealth, ccFlags, isAlly, isResetting } from './stats.ts';
import type {
  AbilityDef, AbilityEffect, AbilityRank, AbilityTargetSide, CastFailure, DamageEffect, HealEffect, ModifierEffect, MoveEffect, TimedModifier, ZoneEffect,
  Entity, MobEntity, PlayerEntity, Range,
} from '../../../shared/types.ts';
import type { World } from '../world.ts';

type Combatant = PlayerEntity | MobEntity;

export interface HealEvent {
  type: 'heal';
  sourceId: string;
  targetId: string;
  amount: number;
}

// Broadcast once per successful non-basic-attack cast, regardless of effect
// kind — `damage`/`heal` effects already produce their own event, but
// `modifier`/`move`/`zone` effects don't (applyEffect returns null for them),
// so without this a pure-CC or pure-utility ability casts invisibly. Client
// renders this as a floating ability-name callout over the caster.
export interface CastEvent {
  type: 'cast';
  casterId: string;
  abilityId: string;
  targetId: string;
}

export type AbilityEvent = AttackEvent | HealEvent | CastEvent;

/** Why a cast didn't happen (for caller feedback); absent when it did.
 *  CastFailure is defined in shared/types.ts so the client can read the reason. */
export interface AbilityResult { cast: boolean; reason?: CastFailure; events: AbilityEvent[] }

// ── The weapon attack ──────────────────────────────────────────────────────
// There is no single "basic attack" any more: what you attack with is a
// property of the thing in your hand. A weapon names an ability
// (ItemBase.attack_ability), an empty hand falls back to `unarmed_strike`, and
// that ability carries the reach, the name and the icon. Damage stays
// weapon-derived (from_weapon → rollDamage), so the ability contributes
// presentation and targeting, never magnitude.
//
// These are ordinary rank-less registry abilities, which is what keeps them out
// of everything that shops for abilities: the trainer filters on `ranks`, the
// skills panel reads knownAbilities, and executeAbility's not-learned gate only
// fires for ranked defs. See world/abilities/{unarmed_strike,weapon_swing,staff_bolt}.yaml.
//
// Last-resort fallback if a world ships no unarmed_strike.yaml: the attack is
// load-bearing enough that a missing def must not leave an actor unable to swing.
export const UNARMED_STRIKE: AbilityDef = {
  id: UNARMED_ATTACK_ID,
  name: 'Unarmed Strike',
  targeting: { shape: 'target', range: 1 },
  cast: { cost: {}, cooldown_ticks: 0 },
  effects: [{ kind: 'damage', base: [1, 1], from_weapon: true }],
  weapon_attack: true,
};

/** The ability this actor attacks with right now. An empty mainhand is unarmed;
 *  a filled one uses the ability its base names, defaulting to a plain swing —
 *  so an unannotated weapon still swings rather than reading as bare fists.
 *  Mobs carry no equipment, so they always resolve to unarmed_strike (a ranged
 *  mob holds distance with preferred_range and a ranged *ability* instead). */
export function attackAbilityFor(world: World, actor: Combatant): AbilityDef {
  const defs = world.defs.abilities;
  const mainhand = actor.type === 'player' ? actor.components.equipment?.mainhand : null;
  if (!mainhand) return defs?.[UNARMED_ATTACK_ID] ?? UNARMED_STRIKE;
  const named = mainhand.item?.components?.equipment?.rolled?.attack_ability;
  return (typeof named === 'string' ? defs?.[named] : undefined)
    ?? defs?.[WEAPON_ATTACK_ID]
    ?? defs?.[UNARMED_ATTACK_ID]
    ?? UNARMED_STRIKE;
}

/** Chebyshev tiles this actor's attack reaches — the reach of whatever it
 *  attacks with. The client resolves the same id against the ability defs it
 *  already fetches, so the two agree on when to stop closing the distance. */
export function attackRange(world: World, actor: Combatant): number {
  return attackAbilityFor(world, actor).targeting.range;
}

function asCombatant(e: Entity | undefined): Combatant | null {
  if (!e) return null;
  return (e.type === 'player' || e.type === 'mob') ? e : null;
}

function chebyshev(a: Combatant, b: Combatant): number {
  return Math.max(Math.abs(a.position.x - b.position.x), Math.abs(a.position.y - b.position.y));
}

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

function freeTile(world: World, zone: string, x: number, y: number): boolean {
  return world.canMoveTo(zone, x, y) && !world.entityAt(zone, x, y);
}

// Walk `mover` one tile at a time along a fixed (dx,dy) step, stopping before the
// first blocked/occupied tile. `stopBeforeTile` halts adjacent to a coordinate
// (so a charge ends next to its target, not on it). Returns tiles moved.
function slide(world: World, mover: Combatant, dx: number, dy: number, maxTiles: number, stopBeforeTile?: { x: number; y: number }): number {
  let moved = 0;
  for (let i = 0; i < maxTiles; i++) {
    const nx = mover.position.x + dx;
    const ny = mover.position.y + dy;
    if (stopBeforeTile && nx === stopBeforeTile.x && ny === stopBeforeTile.y) break;
    if (!freeTile(world, mover.position.zone, nx, ny)) break;
    mover.position.x = nx;
    mover.position.y = ny;
    moved++;
  }
  return moved;
}

// The nearest tile to (x,y) the actor can stand on, searched in expanding
// Chebyshev rings out to `maxRing`. Used by blink to snap a teleport landing
// off a blocked/occupied clicked tile. Returns null if nothing is free.
function nearestFreeTile(world: World, zone: string, x: number, y: number, maxRing: number): { x: number; y: number } | null {
  if (freeTile(world, zone, x, y)) return { x, y };
  for (let r = 1; r <= maxRing; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter only
        if (freeTile(world, zone, x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
  }
  return null;
}

// Reposition for a `move` effect. charge/leap close on the target; knockback
// pushes the target away from the actor; blink teleports the actor to a
// ground-target point (or dashes along its facing when none is given).
function applyMove(world: World, actor: Combatant, tgt: Combatant, effect: MoveEffect, point?: { x: number; y: number }): void {
  switch (effect.motion) {
    case 'charge':
    case 'leap': {
      // Step toward the target (diagonal allowed), stopping adjacent to it.
      const stop = { x: tgt.position.x, y: tgt.position.y };
      for (let i = 0; i < effect.distance; i++) {
        if (chebyshev(actor, tgt) <= 1) break;
        const dx = sign(tgt.position.x - actor.position.x);
        const dy = sign(tgt.position.y - actor.position.y);
        if (slide(world, actor, dx, dy, 1, stop) === 0) break;
      }
      return;
    }
    case 'knockback': {
      // Push the target directly away from the actor. If they share a tile
      // (degenerate), fall back to the actor's facing.
      let dx = sign(tgt.position.x - actor.position.x);
      let dy = sign(tgt.position.y - actor.position.y);
      if (dx === 0 && dy === 0) { dx = DIRS[actor.facing].dx; dy = DIRS[actor.facing].dy; }
      slide(world, tgt, dx, dy, effect.distance);
      return;
    }
    case 'blink': {
      if (point) {
        // Teleport toward the clicked tile, capped to `distance` (Chebyshev),
        // then snapped to the nearest free tile — crosses walls/gaps.
        const dx = point.x - actor.position.x;
        const dy = point.y - actor.position.y;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        let tx = point.x, ty = point.y;
        if (dist > effect.distance) {
          const s = effect.distance / dist;
          tx = actor.position.x + Math.round(dx * s);
          ty = actor.position.y + Math.round(dy * s);
        }
        const dest = nearestFreeTile(world, actor.position.zone, tx, ty, effect.distance);
        if (dest) { actor.position.x = dest.x; actor.position.y = dest.y; }
        return;
      }
      // No ground target: dash the actor along its facing (mob/facing fallback).
      const d = DIRS[actor.facing];
      slide(world, actor, d.dx, d.dy, effect.distance);
      return;
    }
  }
}

// The actor's purchased rank row for this ability, if any. Mob abilities (no
// `ranks`) and the basic attack have no rank row — every lookup off it (power
// mult, range override) falls back to its own "unranked" default.
function currentRank(actor: Combatant, ability: AbilityDef): AbilityRank | undefined {
  if (actor.type !== 'player' || !ability.ranks) return undefined;
  const rank = actor.components.knownAbilities[ability.id] ?? 1;
  return ability.ranks.find((r) => r.rank === rank) ?? ability.ranks[0];
}

// Rank's power multiplier scales only the flat `base` of damage/heal effects —
// never the stat-scaled bonus. (See docs/plan-class-abilities.md.)
export function powerMult(actor: Combatant, ability: AbilityDef): number {
  return currentRank(actor, ability)?.power_mult ?? 1;
}

function scaleBase(base: Range, mult: number): Range {
  return mult === 1 ? base : [Math.round(base[0] * mult), Math.round(base[1] * mult)];
}

// base + stat-scaled bonus (reusing combat's letter-graded scaling). The `brand`
// field tags the damage type (for future resistances); magnitude is base+scaling.
// `from_weapon` (ability 0) derives the whole swing from the equipped weapon.
function rollEffectDamage(actor: Combatant, effect: DamageEffect, mult = 1): number {
  if (effect.from_weapon) return rollDamage(actor);
  return Math.max(1, rollRange(scaleBase(effect.base, mult)) + Math.round(scaledBonus(actor, effect.scaling ?? null)));
}

function applyHeal(entity: Combatant, amount: number): number {
  const h = entity.components.health;
  if (!h) return 0;
  const before = h.current;
  h.current = Math.min(effectiveMaxHealth(entity), h.current + amount);
  return h.current - before;
}

function rollHeal(actor: Combatant, effect: HealEffect, mult = 1): number {
  return Math.max(0, rollRange(scaleBase(effect.base, mult)) + Math.round(scaledBonus(actor, effect.scaling ?? null)));
}

// `side` defaults to 'enemy' so every ability authored before this field
// existed keeps its old behavior (actor and target must be different factions).
function isValidTarget(world: World, actor: Combatant, tgt: Entity | Combatant | null | undefined, side: AbilityTargetSide = 'enemy'): tgt is Combatant {
  const c = asCombatant(tgt ?? undefined);
  if (!c) return false;
  if (c.type === 'mob' && c.components.ai?.fixture) return false; // signs/props aren't targets
  if (c.position.zone !== actor.position.zone) return false;
  if (!isAlive(c)) return false;
  if (side === 'any') return true;
  const ally = isAlly(world, actor, c);
  return side === 'ally' ? ally : !ally;
}

// Resolve which combatants an ability lands on. `self` hits the actor;
// `target`/`projectile` hit the named target; `area` hits every valid combatant
// within `targeting.radius` (Chebyshev) of the named target's position, the
// named target included.
function resolveTargets(world: World, actor: Combatant, ability: AbilityDef, targetId?: string, point?: { x: number; y: number }, rank?: AbilityRank): Combatant[] {
  if (ability.targeting.shape === 'self') return [actor];
  // Ground-targeted cast: the actor is the sole target; the clicked point must
  // be within range (the effect layer reads `point`). No entity target needed.
  if (ability.targeting.shape === 'point') {
    if (!point) return [];
    const d = Math.max(Math.abs(point.x - actor.position.x), Math.abs(point.y - actor.position.y));
    if (d > (rank?.range ?? ability.targeting.range)) return [];
    return [actor];
  }
  const side = ability.targeting.side;
  const tgt = asCombatant(world.entities.get(targetId ?? ''));
  if (!isValidTarget(world, actor, tgt, side)) return [];
  if (chebyshev(actor, tgt) > ability.targeting.range) return [];
  if (ability.targeting.shape !== 'area' || !ability.targeting.radius) return [tgt];
  const radius = ability.targeting.radius;
  const origin = tgt.position;
  const hits: Combatant[] = [];
  for (const e of world.entitiesInZone(actor.position.zone)) {
    if (!isValidTarget(world, actor, e, side)) continue;
    if (Math.max(Math.abs(e.position.x - origin.x), Math.abs(e.position.y - origin.y)) > radius) continue;
    hits.push(e);
  }
  return hits;
}

function applyEffect(world: World, actor: Combatant, tgt: Combatant, effect: AbilityEffect, tick: number, abilityId: string, mult = 1, point?: { x: number; y: number }, rank?: AbilityRank): AbilityEvent | null {
  // A mob walking home after a leash break is out of the fight: CC and
  // knockback don't stick to it, so it can't be pinned in place or shoved
  // around mid-reset. Damage still falls through to applyResolvedDamage, which
  // zeroes it — the attacker sees a 0 rather than nothing happening at all.
  if ((effect.kind === 'modifier' || effect.kind === 'move') && tgt.id !== actor.id && isResetting(tgt)) return null;
  switch (effect.kind) {
    case 'damage': {
      // A static ability brand (e.g. ember_spit's fire_damage) always wins; a
      // from_weapon effect (the basic attack) has none of its own, so it takes
      // whatever element the actor's weapon is imbued with, if any.
      const brand = effect.brand ?? (effect.from_weapon ? weaponBrand(actor) : undefined);
      return applyResolvedDamage(actor, tgt, rollEffectDamage(actor, effect, mult), brand);
    }
    case 'heal':
      return { type: 'heal', sourceId: actor.id, targetId: tgt.id, amount: applyHeal(tgt, rollHeal(actor, effect, mult)) };
    case 'modifier': {
      const me: ModifierEffect = effect;
      // Pre-scale the dot/hot base by rank so the stored modifier already carries
      // the ranked power (the tick fires later, decoupled from the cast).
      const tickEffect = me.tick_effect
        ? { ...me.tick_effect, base: scaleBase(me.tick_effect.base, mult) }
        : undefined;
      const mod: TimedModifier = {
        source: actor.id,
        ability: abilityId,
        stats: me.stats,
        expiresAt: tick + me.duration_ticks,
        tickEffect,
        nextTickAt: tickEffect ? tick + MODIFIER_TICK_INTERVAL_TICKS : undefined,
        cc: me.cc,
      };
      (tgt.components.modifiers ??= []).push(mod);
      return null; // applying a modifier produces no immediate event
    }
    case 'move': {
      // A rank's `range` override, when set, replaces the authored distance —
      // see AbilityRank.range for why this is the one non-power thing a rank
      // can change (a longer blink needs a longer dash, not just more punch).
      const me = rank?.range != null ? { ...effect, distance: rank.range } : effect;
      applyMove(world, actor, tgt, me, point);
      return null; // repositioning shows via the zone snapshot, not a combat event
    }
    case 'zone': {
      const ze: ZoneEffect = effect;
      // Pre-scale the same way a modifier's tick_effect is pre-scaled — the
      // zone's per-tick effect already carries the ranked power.
      world.spawnZone({
        zoneId: tgt.position.zone,
        x: tgt.position.x,
        y: tgt.position.y,
        radius: ze.radius,
        currentTick: tick,
        durationTicks: ze.duration_ticks,
        tickInterval: ze.tick_interval_ticks ?? MODIFIER_TICK_INTERVAL_TICKS,
        effect: { ...ze.effect, base: scaleBase(ze.effect.base, mult) },
        side: ze.side ?? 'enemy',
        ownerId: actor.id,
      });
      return null; // the zone itself ticks later (loop.ts -> tickZones), not an immediate event
    }
  }
}

// Apply a modifier's tick_effect (dot/hot) directly — DoTs bypass dodge/armor
// since the hit already landed. Magnitude rolls from the original source's stats
// if it still exists, else from the target's (fallback so it never crashes).
function applyTickEffect(source: Combatant, target: Combatant, effect: DamageEffect | HealEffect): AbilityEvent {
  if (effect.kind === 'damage') {
    const mult = resistanceMult(target, effect.brand);
    const immune = (target.type === 'player' && target.godMode) || isResetting(target);
    const dmg = immune ? 0 : Math.max(0, Math.round(rollEffectDamage(source, effect) * mult));
    applyDamage(target, dmg);
    const fatal = (target.components.health?.current ?? 0) <= 0;
    return { type: 'attack', attackerId: source.id, targetId: target.id, damage: dmg, fatal };
  }
  return { type: 'heal', sourceId: source.id, targetId: target.id, amount: applyHeal(target, rollHeal(source, effect)) };
}

/** Advance one entity's active modifiers: fire due tick_effects (dot/hot) and
 *  drop expired ones. Returns the events produced for the caller to broadcast. */
export function tickModifiers(world: World, entity: Combatant, tick: number): AbilityEvent[] {
  const mods = entity.components.modifiers;
  if (!mods || mods.length === 0) return [];
  const events: AbilityEvent[] = [];
  for (const m of mods) {
    if (m.tickEffect && tick >= (m.nextTickAt ?? 0)) {
      m.nextTickAt = tick + MODIFIER_TICK_INTERVAL_TICKS;
      const src = asCombatant(world.entities.get(m.source)) ?? entity;
      events.push(applyTickEffect(src, entity, m.tickEffect));
    }
  }
  entity.components.modifiers = mods.filter((m) => tick < m.expiresAt);
  return events;
}

/** Advance every active ground zone (World.activeZones): fire the zone's effect
 *  against every valid combatant in radius (faction-filtered by `side`) when
 *  due, and drop expired zones. World-scoped counterpart to tickModifiers —
 *  called once per loop tick (loop.ts), not per-entity. */
export function tickZones(world: World, tick: number): AbilityEvent[] {
  const events: AbilityEvent[] = [];
  for (const [id, zone] of world.activeZones) {
    if (tick >= zone.expiresAt) { world.activeZones.delete(id); continue; }
    if (tick < zone.nextTickAt) continue;
    zone.nextTickAt = tick + zone.tickInterval;
    const owner = asCombatant(world.entities.get(zone.ownerId));
    for (const e of world.entitiesInZone(zone.zoneId)) {
      const c = asCombatant(e);
      if (!c || !isAlive(c)) continue;
      if (Math.max(Math.abs(c.position.x - zone.x), Math.abs(c.position.y - zone.y)) > zone.radius) continue;
      if (owner && zone.side !== 'any') {
        const ally = isAlly(world, owner, c);
        if (zone.side === 'ally' && !ally) continue;
        if ((zone.side ?? 'enemy') === 'enemy' && ally) continue;
      }
      events.push(applyTickEffect(owner ?? c, c, zone.effect));
    }
  }
  return events;
}

/** True if the ability is off cooldown at `tick`. */
export function abilityReady(actor: Combatant, ability: AbilityDef, tick: number): boolean {
  return tick >= (actor.abilityCooldowns?.[ability.id] ?? 0);
}

/** True if the actor can pay the ability's cost (only `mana` exists today). */
export function canAfford(actor: Combatant, ability: AbilityDef): boolean {
  const manaCost = ability.cast.cost?.mana ?? 0;
  if (manaCost <= 0) return true;
  return (actor.components.mana?.current ?? 0) >= manaCost;
}

/** Resolve an ability: gate on cooldown + cost, then apply effects to targets.
 *  Cost/cooldown are consumed only on a successful cast (a no-target attempt
 *  leaves both untouched so the player can retry). Returns the events produced
 *  (damage/heal) for the caller to broadcast. */
export function executeAbility(world: World, actor: Combatant, ability: AbilityDef, tick: number, targetId?: string, point?: { x: number; y: number }): AbilityResult {
  // A player can only cast a ranked (player) ability they've learned.
  if (actor.type === 'player' && ability.ranks && !actor.components.knownAbilities[ability.id]) {
    return { cast: false, reason: 'not_learned', events: [] };
  }
  const flags = ccFlags(actor);
  // Declared on the def rather than matched against a fixed id, because there is
  // no longer one basic-attack id — it's whatever the equipped weapon names.
  const isWeaponAttack = ability.weapon_attack === true;
  // Stun blocks every cast, the weapon attack included; silence only blocks real
  // abilities — a silenced actor can still swing (or bolt with) its weapon.
  if (flags.has('stun')) return { cast: false, reason: 'stunned', events: [] };
  if (flags.has('silence') && !isWeaponAttack) return { cast: false, reason: 'silenced', events: [] };
  if (!abilityReady(actor, ability, tick)) return { cast: false, reason: 'cooldown', events: [] };
  if (!canAfford(actor, ability)) return { cast: false, reason: 'mana', events: [] };

  const rank = currentRank(actor, ability);
  const targets = resolveTargets(world, actor, ability, targetId, point, rank);
  if (targets.length === 0) return { cast: false, reason: 'no_target', events: [] };

  // Consume cost + set cooldown, and lock the actor's mana regen briefly.
  const manaCost = ability.cast.cost?.mana ?? 0;
  if (manaCost > 0 && actor.components.mana) {
    actor.components.mana.current = Math.max(0, actor.components.mana.current - manaCost);
    actor.nextManaRegenTick = tick + MANA_COMBAT_LOCKOUT_TICKS;
  }
  (actor.abilityCooldowns ??= {})[ability.id] = tick + (rank?.cooldown_ticks ?? ability.cast.cooldown_ticks);

  const mult = rank?.power_mult ?? 1;
  const events: AbilityEvent[] = [];
  for (const tgt of targets) {
    for (const effect of ability.effects) {
      const ev = applyEffect(world, actor, tgt, effect, tick, ability.id, mult, point, rank);
      if (ev) events.push(ev);
    }
  }
  // One cast notification per successful special-ability cast, independent of
  // effect kind — see CastEvent above for why this can't just ride on damage/heal.
  if (!isWeaponAttack) {
    events.push({ type: 'cast', casterId: actor.id, abilityId: ability.id, targetId: targets[0]!.id });
  }
  return { cast: true, events };
}

// ── Weapon attack entry points ─────────────────────────────────────────────
// The attack both the player (loop) and mobs (ai) issue. Damage routes
// through executeAbility → the weapon-derived damage effect, so it shares the
// one resolution path. The wrappers keep the attack-specific orchestration:
// target selection, the PvP guard, facing, and provoking a non-aggressive mob.

function basicAttack(world: World, att: Combatant, target: Entity, tick: number): AttackEvent | null {
  // Fixtures (torches, the notice board) are indestructible world objects — not
  // valid combat targets, no matter how the attack was issued.
  if (target.type === 'mob' && target.components?.ai?.fixture) return null;
  const res = executeAbility(world, att, attackAbilityFor(world, att), tick, target.id);
  const ev = res.events.find((e): e is AttackEvent => e.type === 'attack') ?? null;
  // When a player hits any non-fixture mob, provoke it so it defends itself —
  // including idle/townsfolk NPCs that otherwise just stand there.
  if (ev && !ev.dodged && att.type === 'player' && target.type === 'mob') {
    const ai = target.components?.ai;
    if (ai && !ai.fixture && !ai.inert && !ai.resetting) {
      ai.provoked = true;
      ai.target = att.id;
    }
  }
  return ev;
}

/** Player weapon attack on the tile the attacker faces. */
export function attackInFacing(world: World, attacker: Entity, tick: number): AttackEvent | null {
  const att = asCombatant(attacker);
  if (!att) return null;
  const dir = DIRS[att.facing];
  if (!dir) return null;
  const target = world.entityAt(att.position.zone, att.position.x + dir.dx, att.position.y + dir.dy);
  if (!target) return null;
  if (att.type === 'player' && target.type === 'player') return null;
  return basicAttack(world, att, target, tick);
}

/** Weapon attack on a specific entity by id, facing it first. */
export function attackTarget(world: World, attacker: Entity, targetId: string, tick: number): AttackEvent | null {
  const att = asCombatant(attacker);
  if (!att) return null;
  const target = world.entities.get(targetId);
  if (!target) return null;
  // No range check here: executeAbility's resolveTargets gates on the reach of
  // whatever the actor attacks with, which for a staff is well past melee.
  const dx = target.position.x - att.position.x;
  const dy = target.position.y - att.position.y;
  if (dx !== 0 || dy !== 0) {
    if (Math.abs(dx) >= Math.abs(dy)) att.facing = dx > 0 ? 'east' : 'west';
    else att.facing = dy > 0 ? 'south' : 'north';
  }
  return basicAttack(world, att, target, tick);
}
