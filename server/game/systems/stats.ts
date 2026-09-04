// Effective-stat aggregation — the single place that resolves an actor's current
// value for a stat by summing its sources. Combat (and, once the ability system
// lands, resource-max and scaling) all read from here, so every source matters
// through one path.
//
//   effectiveStat = base + equipment affixes + active timed modifiers
//
// The modifier term is the seam for status effects (buffs/debuffs/dots) added by
// the ability system (see docs/plan-abilities.md). No `modifiers` component
// exists yet, so `sumActiveModifiers` returns {} today — this is a no-op term
// until step 5 populates it.

import { EQUIPMENT_SLOTS } from '../entities.ts';
import { actTicks } from '../../../shared/constants.ts';
import type { Entity, PlayerEntity, MobEntity, CcKind, WorldDefs } from '../../../shared/types.ts';
import type { World } from '../world.ts';

type Combatant = PlayerEntity | MobEntity;

// ─── Faction (see docs on ally-aware targeting) ────────────────────────────
// Three buckets: the player side, the wild-hostile side, and neutral (never a
// valid ally or enemy target — quest-givers/villagers). A summoned mob
// inherits its owner's faction (one level of recursion; summons don't
// currently summon summons) so a player's ally and a hostile mob's ally
// resolve correctly against the same helper.
export type Faction = 'player' | 'hostile' | 'neutral';

export function factionOf(world: World, entity: Combatant): Faction {
  if (entity.type === 'player') return 'player';
  if (entity.summonedBy) {
    const owner = world.entities.get(entity.summonedBy);
    if (owner && (owner.type === 'player' || owner.type === 'mob')) return factionOf(world, owner);
  }
  const role = world.defs.mobs?.[entity.components.ai.template_id]?.role;
  if (role === 'npc') return 'neutral';
  return 'hostile';
}

export function isAlly(world: World, a: Combatant, b: Combatant): boolean {
  const fa = factionOf(world, a);
  const fb = factionOf(world, b);
  return fa !== 'neutral' && fa === fb;
}

// Sum every numeric rolled stat across all equipped slots. Affix bonuses like
// +strength, armor, and brand damage (fire_damage, …) live here. Range stats
// (damage/defense) and scaling objects are non-numeric and skipped. Mobs have no
// equipment.
export function sumEquipRolled(entity: Combatant): Record<string, number> {
  const out: Record<string, number> = {};
  if (entity.type !== 'player') return out;
  const eq = entity.components.equipment;
  for (const slot of EQUIPMENT_SLOTS) {
    const rolled = eq[slot]?.item?.components?.equipment?.rolled;
    if (!rolled) continue;
    for (const [k, v] of Object.entries(rolled)) {
      // A weapon's `speed` is a swing-rate MULTIPLIER (a dagger is 1.5, a maul
      // 0.65), not a bonus to add — summing it onto the actor's base 1.0 made
      // every weapon a large movement and attack-speed buff, and made the maul,
      // the slowest weapon in the game, faster than bare fists. It is applied
      // multiplicatively in attackCooldown instead, and never to movement.
      // Speed on any other slot (an Ancient amulet, say) stays an honest bonus.
      if (k === 'speed' && slot === 'mainhand') continue;
      if (typeof v === 'number') out[k] = (out[k] || 0) + v;
    }
  }
  return out;
}

// Sum stat deltas across all active timed modifiers on the entity (buffs/debuffs).
export function sumActiveModifiers(entity: Combatant): Record<string, number> {
  const out: Record<string, number> = {};
  const mods = entity.components.modifiers;
  if (!mods) return out;
  for (const m of mods) {
    if (!m.stats) continue;
    for (const [k, v] of Object.entries(m.stats)) {
      if (typeof v === 'number') out[k] = (out[k] || 0) + v;
    }
  }
  return out;
}

// Union of semantic CC flags carried by every active timed modifier — the
// single read site stun/root/silence/confuse enforcement (ai.ts, movement.ts,
// abilities.ts) checks against.
export function ccFlags(entity: Combatant): Set<CcKind> {
  const out = new Set<CcKind>();
  const mods = entity.components.modifiers;
  if (!mods) return out;
  for (const m of mods) {
    if (!m.cc) continue;
    for (const c of m.cc) out.add(c);
  }
  return out;
}

// The caster who applied a given CC flag (fear/antagonize need to know *who*
// to flee from or charge). First active modifier carrying the flag wins.
export function ccSource(entity: Combatant, kind: CcKind): string | undefined {
  return entity.components.modifiers?.find((m) => m.cc?.includes(kind))?.source;
}

// Fear and antagonize only make sense while their source is alive — fear has
// nothing to flee, antagonize has nothing to leash you to a fight against.
// When the casting entity dies, strip that one flag from anyone carrying it.
// Only touches the named flag (not the whole modifier, and not other CC
// types) since dread_gaze/provoking_shout's modifiers happen to be
// single-purpose today, but a future multi-effect cast shouldn't lose its
// other effects just because the source died. Returns the zones that
// changed, for the caller to mark dirty.
export function clearCcFromSource(world: World, sourceId: string, kind: CcKind): Set<string> {
  const dirty = new Set<string>();
  for (const e of world.entities.values()) {
    if (e.type !== 'player' && e.type !== 'mob') continue;
    const mods = e.components.modifiers;
    if (!mods || mods.length === 0) continue;
    let changed = false;
    const next = mods.map((m) => {
      if (m.source !== sourceId || !m.cc?.includes(kind)) return m;
      changed = true;
      const cc = m.cc.filter((k) => k !== kind);
      return { ...m, cc: cc.length ? cc : undefined };
    });
    if (changed) {
      e.components.modifiers = next;
      dirty.add(e.position.zone);
    }
  }
  return dirty;
}

export function effectiveStat(entity: Combatant, stat: string): number {
  const base = (entity.components?.stats as Record<string, unknown>)?.[stat] as number || 0;
  return base + (sumEquipRolled(entity)[stat] || 0) + (sumActiveModifiers(entity)[stat] || 0);
}

// Shared player/mob attack-cadence formula: baseTicks / effective speed (a
// "slow" modifier's `stats.speed` delta lengthens this the same way for both).
// ai.ts's actCooldown and loop.ts's attack gate both call this so a speed-1
// player and a speed-1 mob attack at the same rate.
export function actCooldown(entity: Combatant, baseTicks: number): number {
  return actTicks(baseTicks, effectiveStat(entity, 'speed') || 1.0);
}

/** The equipped weapon's swing-rate multiplier: 1.5 for a dagger, 0.65 for a
 *  maul, 1 bare-handed. Read off the rolled instance when there is one (so a
 *  "Swift" affix folds in, the generator having summed it onto base_speed), and
 *  off the ItemBase otherwise — a staple bought off a shop shelf has no rolled
 *  item, and would otherwise swing at a flat rate no matter what it is. */
export function weaponSpeed(entity: Combatant, defs: WorldDefs): number {
  if (entity.type !== 'player') return 1;
  const stack = entity.components.equipment?.mainhand;
  if (!stack) return 1;
  const rolled = stack.item?.components?.equipment?.rolled?.speed;
  const sp = typeof rolled === 'number' ? rolled : defs.itemBases[stack.base]?.base_speed;
  return typeof sp === 'number' && sp > 0 ? sp : 1;
}

/** Ticks between a player's weapon attacks: the shared stat cadence, then scaled
 *  by the weapon's own swing rate. Movement deliberately does NOT go through
 *  here — how fast you swing a maul has nothing to do with how fast you walk. */
export function attackCooldown(entity: Combatant, baseTicks: number, defs: WorldDefs): number {
  return actTicks(baseTicks, (effectiveStat(entity, 'speed') || 1.0) * weaponSpeed(entity, defs));
}

// Resource maxima: the stored pool plus any max_health / max_mana granted by
// equipment affixes or active modifiers. These are the values combat/regen
// should clamp to, so a +max_mana buff actually raises the ceiling.
export function effectiveMaxHealth(entity: Combatant): number {
  const base = entity.components.health?.max ?? 0;
  return Math.max(1, base + (sumEquipRolled(entity).max_health || 0) + (sumActiveModifiers(entity).max_health || 0));
}

// True while a mob is walking back to its leash origin after a leash break (see
// breakLeash in ai.ts). Such a mob has already been restored to full and has
// dropped threat, so it is out of the fight entirely: no damage, CC, or
// knockback lands on it until it gets home. Without that, a player could keep
// hitting a mob that has stopped fighting back — a worse exploit than the tow
// the leash exists to stop. Lives here (not ai.ts) so combat.ts and abilities.ts
// can read it without importing the AI module.
export function isResetting(entity: Entity | undefined | null): boolean {
  return !!entity && entity.type === 'mob' && !!entity.components.ai?.resetting;
}

export function effectiveMaxMana(entity: Combatant): number {
  const base = entity.components.mana?.max ?? 0;
  return Math.max(0, base + (sumEquipRolled(entity).max_mana || 0) + (sumActiveModifiers(entity).max_mana || 0));
}
