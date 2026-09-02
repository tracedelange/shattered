// Functional-equivalence for abilities — the mechanism that keeps the library
// LEAN: before a generator mints a new ability it asks "does one that already
// does this exist?" and reuses the existing id instead of coining a same-effect,
// different-name duplicate.
//
// The signature is a canonical fingerprint of what an ability DOES, deliberately
// blind to everything that is naming, flavor, or tuning:
//   kept    — actor, targeting shape + side, and the SET of effects reduced to
//             (kind + its functional qualifier): damage/zone brand, modifier
//             stat directions + cc flags, move motion, heal, dot vs hot.
//   dropped — id, name, all magnitudes (base ranges, durations, cooldowns, cost,
//             radius/distance size), scaling grades AND scaling stats, ranks.
//
// So a [10,16] and a [40,60] single-target fire nuke collapse to one signature
// (same function, different power — that is a rank/level knob, not a new ability),
// while a fire nuke and a cold nuke stay distinct (brand changes resist play).
// Coarse on purpose: for dedup, over-merging near-identical actions is the goal.

import type { AbilityDef, AbilityEffect, ModifierEffect } from '../../shared/types.ts';

const DEFAULT_SIDE = 'enemy';
const PHYSICAL = 'phys'; // untyped/brand-less damage

// One effect → its functional token. Magnitude-free by construction.
function effectSig(e: AbilityEffect): string {
  switch (e.kind) {
    case 'damage':
      return `dmg:${e.brand ?? PHYSICAL}`;
    case 'heal':
      return 'heal';
    case 'modifier': {
      // A +armor buff and a -speed slow are different functions; keep each stat
      // key with only the SIGN of its delta (magnitude is tuning). cc flags and
      // the tick fingerprint complete it — a physical bleed and a poison dot are
      // distinct (different resist play), so the dot token carries its brand.
      const stats = statDirections(e);
      const cc = [...(e.cc ?? [])].sort();
      const tick = e.tick_effect
        ? (e.tick_effect.kind === 'damage' ? `dot:${e.tick_effect.brand ?? PHYSICAL}` : 'hot')
        : '';
      return `mod:${stats.join('+')}:${cc.join('+')}:${tick}`;
    }
    case 'move':
      return `move:${e.motion}`;
    case 'zone': {
      const inner = e.effect.kind === 'damage' ? `dmg:${e.effect.brand ?? PHYSICAL}` : 'heal';
      return `zone:${inner}:${e.side ?? DEFAULT_SIDE}`;
    }
  }
}

function statDirections(e: ModifierEffect): string[] {
  return Object.entries(e.stats)
    .map(([k, v]) => `${k}${v < 0 ? '-' : '+'}`)
    .sort();
}

/** Canonical functional signature — equal signatures ⇒ functionally the same
 *  ability (same-effect, possibly different name/tuning). */
export function abilitySignature(def: AbilityDef): string {
  // class is part of a player ability's identity: each class needs its own kit,
  // so a rogue and a fighter single-target strike are parallels, not duplicates.
  // Mob/any abilities have no class, so it drops out of their signature.
  const actor = `${def.actor ?? 'mob'}${def.class ? `:${def.class}` : ''}`;
  const side = def.targeting.side ?? DEFAULT_SIDE;
  const target = `${def.targeting.shape}:${side}`;
  // Effects are a SET — order in the YAML is not functional identity.
  const effects = def.effects.map(effectSig).sort().join(',');
  return `${actor}|${target}|${effects}`;
}

/** The first ability in `pool` functionally equivalent to `def`, or null. The
 *  generator calls this to reuse an existing id instead of minting a duplicate. */
export function findEquivalent(def: AbilityDef, pool: AbilityDef[]): AbilityDef | null {
  const sig = abilitySignature(def);
  return pool.find((p) => p.id !== def.id && abilitySignature(p) === sig) ?? null;
}

/** Group a pool by signature; entries with >1 member are same-effect duplicates.
 *  Only groups with a collision are returned. */
export function duplicateGroups(pool: AbilityDef[]): { signature: string; ids: string[] }[] {
  const bySig = new Map<string, string[]>();
  for (const a of pool) {
    const sig = abilitySignature(a);
    (bySig.get(sig) ?? bySig.set(sig, []).get(sig)!).push(a.id);
  }
  return [...bySig].filter(([, ids]) => ids.length > 1).map(([signature, ids]) => ({ signature, ids }));
}
