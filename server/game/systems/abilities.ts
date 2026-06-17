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
import { MANA_COMBAT_LOCKOUT_TICKS, MODIFIER_TICK_INTERVAL_TICKS } from '../../../shared/constants.ts';
import { applyResolvedDamage, applyDamage, rollDamage, scaledBonus, type AttackEvent } from './combat.ts';
import { effectiveMaxHealth } from './stats.ts';
import type {
  AbilityDef, AbilityEffect, DamageEffect, HealEffect, ModifierEffect, MoveEffect, TimedModifier,
  Entity, MobEntity, PlayerEntity,
} from '../../../shared/types.ts';
import type { World } from '../world.ts';

type Combatant = PlayerEntity | MobEntity;

export interface HealEvent {
  type: 'heal';
  sourceId: string;
  targetId: string;
  amount: number;
}

export type AbilityEvent = AttackEvent | HealEvent;

/** Why a cast didn't happen (for caller feedback); absent when it did. */
export type CastFailure = 'cooldown' | 'mana' | 'no_target';
export interface AbilityResult { cast: boolean; reason?: CastFailure; events: AbilityEvent[] }

// Ability 0 — the basic attack. A code constant, not a registry entry: its
// damage is weapon-derived (from_weapon), so it scales off whatever the actor
// wields (melee STR, wand INT, unarmed STR fallback) via rollDamage. Cooldown 0
// because the real cadence is the loop/AI attack-speed gate (nextActTick); cost
// {} so it never touches mana. Mob AI falls back to this when no ability fires.
export const BASIC_ATTACK_ID = 'basic_attack';
export const BASIC_ATTACK: AbilityDef = {
  id: BASIC_ATTACK_ID,
  name: 'Attack',
  targeting: { shape: 'target', range: 1 },
  cast: { cost: {}, cooldown_ticks: 0 },
  effects: [{ kind: 'damage', base: [1, 1], from_weapon: true }],
};

// Does this ability harm its target? The mob controller uses this to decide
// who to aim at: offensive abilities at the enemy, supportive ones (heals,
// self-buffs) at the caster itself. NOTE: a pure stat-debuff modifier (no damage
// effect, no damaging tick) currently reads as supportive — fine while none
// exist; the real fix is a target-disposition field on the ability schema.
export function isOffensiveAbility(def: AbilityDef): boolean {
  return def.effects.some((e) =>
    e.kind === 'damage' || (e.kind === 'modifier' && e.tick_effect?.kind === 'damage'));
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

// Reposition for a `move` effect. charge/leap close on the target; knockback
// pushes the target away from the actor; blink dashes the actor along its facing.
function applyMove(world: World, actor: Combatant, tgt: Combatant, effect: MoveEffect): void {
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
      // Dash the actor along its facing as far as the distance / obstacles allow.
      const d = DIRS[actor.facing];
      slide(world, actor, d.dx, d.dy, effect.distance);
      return;
    }
  }
}

// base + stat-scaled bonus (reusing combat's letter-graded scaling). The `brand`
// field tags the damage type (for future resistances); magnitude is base+scaling.
// `from_weapon` (ability 0) derives the whole swing from the equipped weapon.
function rollEffectDamage(actor: Combatant, effect: DamageEffect): number {
  if (effect.from_weapon) return rollDamage(actor);
  return Math.max(1, rollRange(effect.base) + Math.round(scaledBonus(actor, effect.scaling ?? null)));
}

function applyHeal(entity: Combatant, amount: number): number {
  const h = entity.components.health;
  if (!h) return 0;
  const before = h.current;
  h.current = Math.min(effectiveMaxHealth(entity), h.current + amount);
  return h.current - before;
}

function rollHeal(actor: Combatant, effect: HealEffect): number {
  return Math.max(0, rollRange(effect.base) + Math.round(scaledBonus(actor, effect.scaling ?? null)));
}

// Resolve which combatants an ability lands on. `self` hits the actor;
// target/projectile hit the named target. (area multi-target lands in a later
// step; for now it resolves to the single named target.)
function resolveTargets(world: World, actor: Combatant, ability: AbilityDef, targetId?: string): Combatant[] {
  if (ability.targeting.shape === 'self') return [actor];
  const tgt = asCombatant(world.entities.get(targetId ?? ''));
  if (!tgt) return [];
  if (tgt.type === 'mob' && tgt.components.ai?.fixture) return []; // signs/props aren't targets
  if (tgt.position.zone !== actor.position.zone) return [];
  if (!isAlive(tgt)) return [];
  if (chebyshev(actor, tgt) > ability.targeting.range) return [];
  return [tgt];
}

function applyEffect(world: World, actor: Combatant, tgt: Combatant, effect: AbilityEffect, tick: number, abilityId: string): AbilityEvent | null {
  switch (effect.kind) {
    case 'damage':
      return applyResolvedDamage(actor, tgt, rollEffectDamage(actor, effect));
    case 'heal':
      return { type: 'heal', sourceId: actor.id, targetId: tgt.id, amount: applyHeal(tgt, rollHeal(actor, effect)) };
    case 'modifier': {
      const me: ModifierEffect = effect;
      const mod: TimedModifier = {
        source: actor.id,
        ability: abilityId,
        stats: me.stats,
        expiresAt: tick + me.duration_ticks,
        tickEffect: me.tick_effect,
        nextTickAt: me.tick_effect ? tick + MODIFIER_TICK_INTERVAL_TICKS : undefined,
      };
      (tgt.components.modifiers ??= []).push(mod);
      return null; // applying a modifier produces no immediate event
    }
    case 'move':
      applyMove(world, actor, tgt, effect);
      return null; // repositioning shows via the zone snapshot, not a combat event
  }
}

// Apply a modifier's tick_effect (dot/hot) directly — DoTs bypass dodge/armor
// since the hit already landed. Magnitude rolls from the original source's stats
// if it still exists, else from the target's (fallback so it never crashes).
function applyTickEffect(source: Combatant, target: Combatant, effect: DamageEffect | HealEffect): AbilityEvent {
  if (effect.kind === 'damage') {
    const dmg = rollEffectDamage(source, effect);
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
export function executeAbility(world: World, actor: Combatant, ability: AbilityDef, tick: number, targetId?: string): AbilityResult {
  if (!abilityReady(actor, ability, tick)) return { cast: false, reason: 'cooldown', events: [] };
  if (!canAfford(actor, ability)) return { cast: false, reason: 'mana', events: [] };

  const targets = resolveTargets(world, actor, ability, targetId);
  if (targets.length === 0) return { cast: false, reason: 'no_target', events: [] };

  // Consume cost + set cooldown, and lock the actor's mana regen briefly.
  const manaCost = ability.cast.cost?.mana ?? 0;
  if (manaCost > 0 && actor.components.mana) {
    actor.components.mana.current = Math.max(0, actor.components.mana.current - manaCost);
    actor.nextManaRegenTick = tick + MANA_COMBAT_LOCKOUT_TICKS;
  }
  (actor.abilityCooldowns ??= {})[ability.id] = tick + ability.cast.cooldown_ticks;

  const events: AbilityEvent[] = [];
  for (const tgt of targets) {
    for (const effect of ability.effects) {
      const ev = applyEffect(world, actor, tgt, effect, tick, ability.id);
      if (ev) events.push(ev);
    }
  }
  return { cast: true, events };
}

// ── Basic attack (ability 0) entry points ──────────────────────────────────
// The melee swing both the player (loop) and mobs (ai) issue. Damage routes
// through executeAbility → the weapon-derived damage effect, so it shares the
// one resolution path. The wrappers keep the attack-specific orchestration:
// target selection, the PvP guard, facing, and provoking a non-aggressive mob.

function basicAttack(world: World, att: Combatant, target: Entity, tick: number): AttackEvent | null {
  const res = executeAbility(world, att, BASIC_ATTACK, tick, target.id);
  const ev = res.events.find((e): e is AttackEvent => e.type === 'attack') ?? null;
  // When a player hits a non-aggressive mob, provoke it so it fights back.
  if (ev && !ev.dodged && att.type === 'player' && target.type === 'mob') {
    const ai = target.components?.ai;
    if (ai && !ai.fixture && ai.behavior !== 'idle' && ai.aggro_range === 0) {
      ai.provoked = true;
      ai.target = att.id;
    }
  }
  return ev;
}

/** Player basic attack on the tile the attacker faces. */
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

/** Basic attack on a specific entity by id, facing it first. */
export function attackTarget(world: World, attacker: Entity, targetId: string, tick: number): AttackEvent | null {
  const att = asCombatant(attacker);
  if (!att) return null;
  const target = world.entities.get(targetId);
  if (!target) return null;
  const dx = target.position.x - att.position.x;
  const dy = target.position.y - att.position.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return null;
  if (Math.abs(dx) >= Math.abs(dy)) att.facing = dx > 0 ? 'east' : 'west';
  else att.facing = dy > 0 ? 'south' : 'north';
  return basicAttack(world, att, target, tick);
}
