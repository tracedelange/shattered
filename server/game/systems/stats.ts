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
import type { PlayerEntity, MobEntity } from '../../../shared/types.ts';

type Combatant = PlayerEntity | MobEntity;

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

export function effectiveStat(entity: Combatant, stat: string): number {
  const base = (entity.components?.stats as Record<string, unknown>)?.[stat] as number || 0;
  return base + (sumEquipRolled(entity)[stat] || 0) + (sumActiveModifiers(entity)[stat] || 0);
}

// Resource maxima: the stored pool plus any max_health / max_mana granted by
// equipment affixes or active modifiers. These are the values combat/regen
// should clamp to, so a +max_mana buff actually raises the ceiling.
export function effectiveMaxHealth(entity: Combatant): number {
  const base = entity.components.health?.max ?? 0;
  return Math.max(1, base + (sumEquipRolled(entity).max_health || 0) + (sumActiveModifiers(entity).max_health || 0));
}

export function effectiveMaxMana(entity: Combatant): number {
  const base = entity.components.mana?.max ?? 0;
  return Math.max(0, base + (sumEquipRolled(entity).max_mana || 0) + (sumActiveModifiers(entity).max_mana || 0));
}
