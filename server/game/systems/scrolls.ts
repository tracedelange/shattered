// Scroll effects (shared/types.ts ScrollEffect). A scroll is a consumable whose
// effect is a world action rather than a stat change, so the resolution lives
// here and server/index.ts only routes `use_item` to it.
//
// The first kind is the scribe's scroll: it reveals where one point of interest
// the character has never found sits in THIS epoch's wilderness. Discovery
// (server/db, permanent, keyed by site id) is deliberately not touched —
// docs/rotating-wilds.md makes "found once, mapped forever" the one thing that
// survives a rotation, and a scroll you can buy for gold must not be able to
// mint that. A reveal is the weaker claim: a position, good until the wilds turn.

import type { DungeonSite } from '../../../shared/worldgen/atlas.ts';

/** Reveals per character, stamped with the epoch they were bought in. Keeping
 *  the epoch on the record rather than clearing on rotation is what makes the
 *  expiry unmissable: a stale entry can never be read back, whatever forgot to
 *  clear it. In memory only — a reveal is not worth a table, and losing it to a
 *  server restart is the same loss as losing it to midnight. */
const reveals = new Map<string, { epoch: number; ids: Set<string> }>();

/** Site ids this character has charted for `epoch`. Empty once the epoch has
 *  moved on, and the stale record is dropped on the way out. */
export function revealedSites(characterId: string, epoch: number): string[] {
  const rec = reveals.get(characterId);
  if (!rec) return [];
  if (rec.epoch !== epoch) { reveals.delete(characterId); return []; }
  return [...rec.ids];
}

export function revealSite(characterId: string, epoch: number, siteId: string): void {
  const rec = reveals.get(characterId);
  if (!rec || rec.epoch !== epoch) {
    reveals.set(characterId, { epoch, ids: new Set([siteId]) });
    return;
  }
  rec.ids.add(siteId);
}

/** Drop every reveal. Called on rotation for hygiene; correctness already rests
 *  on the epoch stamp above. */
export function clearReveals(): void {
  reveals.clear();
}

/**
 * The site a scribe's scroll charts: one the character neither knows nor has
 * already charted, picked uniformly at random rather than by proximity. The
 * nearest unknown site is the one they were about to stumble into anyway, so
 * proximity would make the scroll pay least when it is most likely to be used.
 * Returns null when nothing is left to reveal — the caller must not spend the
 * scroll in that case.
 */
export function pickRevealTarget(
  sites: readonly DungeonSite[],
  known: ReadonlySet<string>,
  rng: () => number = Math.random,
): DungeonSite | null {
  const candidates = sites.filter((s) => !known.has(s.id));
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)] ?? null;
}
