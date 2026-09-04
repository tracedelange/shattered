// What a live wilds rotation has to move and destroy (docs/rotating-wilds.md).
//
// Rotation re-rolls the seed the whole open world derives from, so everything
// downstream of it is invalid the instant the swap happens: a mob standing on
// grass is now standing in open water, a dropped sword is in a tree, a player's
// tile may not be walkable at all. This module is the pure decision half — what
// moves, what dies — kept separate from the imperative half in index.ts so the
// rule is testable without a running world.
//
// The rule has exactly two clauses:
//
//  1. EVACUATE every player standing in the wilderness, and every player inside
//     a dungeon. The dungeon case is the non-obvious one: a dungeon's interior
//     is re-derived from (id, epoch), so the room they are standing in is about
//     to be regenerated under them. Their zone id survives the rotation, which
//     is exactly why leaving them in place would be wrong — they would silently
//     end up inside a wall of a different dungeon wearing the same name.
//
//  2. CULL every non-player entity in the wilderness. Grid zones are handled by
//     World._rebuildZone, which clears and respawns each zone it rebuilds — but
//     it iterates `defs.zones`, and WILD is not one of them, so nothing else
//     ever collects the open world's mobs, corpses, and dropped loot.

import { WILD } from '../../shared/worldgen/config.ts';
import type { Entity, PlayerEntity } from '../../shared/types.ts';

export interface RotationPlan {
  /** Players who must be relocated before the world is rebuilt. */
  evacuate: PlayerEntity[];
  /** Entity ids to remove outright — everything the wilderness owned. */
  cull: string[];
}

/**
 * @param entities every entity currently in the world
 * @param siteIds  zone ids of this epoch's placed dungeons (atlas.sites)
 */
export function planRotation(entities: Iterable<Entity>, siteIds: Iterable<string>): RotationPlan {
  const dungeons = new Set(siteIds);
  const plan: RotationPlan = { evacuate: [], cull: [] };
  for (const e of entities) {
    const inWild = e.position.zone === WILD;
    if (e.type === 'player') {
      if (inWild || dungeons.has(e.position.zone)) plan.evacuate.push(e);
      continue;
    }
    if (inWild) plan.cull.push(e.id);
  }
  return plan;
}
