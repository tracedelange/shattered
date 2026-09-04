// Wild epoch — the clock that re-rolls the open world (docs/rework.md §5.2 is
// the spatial half of this; the epoch is the temporal half).
//
// The whole wilderness derives from one seed: terrain field, region atlas,
// per-chunk spawns, and dungeon placement/layout. Folding a time bucket into
// that seed rotates all of it at once, on an interval, with no per-subsystem
// wiring. The hand-authored village is untouched — its zones carry their own
// seeds and the atlas gates are hardcoded at the origin, so town is the fixed
// point players return to across every rotation.
//
// Danger stays radial (dangerAt is pure distance-from-origin, seed-independent),
// so a rotation never moves the level bands: yesterday's safe ring is today's
// safe ring. That is what makes rotating the world safe rather than hostile.

/** Rotation interval. One UTC day — the epoch boundary is midnight UTC. */
export const WILD_EPOCH_MS = 24 * 60 * 60 * 1000;

/** The epoch number containing `now`. Monotonic, so it also orders saves. */
export function epochOf(now: number = Date.now()): number {
  return Math.floor(now / WILD_EPOCH_MS);
}

/** Wall-clock ms at which `epoch` ends and the next world begins. */
export function epochEndsAt(epoch: number): number {
  return (epoch + 1) * WILD_EPOCH_MS;
}

/**
 * The seed for one epoch of the wilds. Keeps the operator-facing base seed
 * (WORLD_SEED) meaningful — same base always produces the same *sequence* of
 * worlds — while every epoch is an unrelated draw.
 */
export function epochSeed(baseSeed: string, epoch: number): string {
  return `${baseSeed}#${epoch}`;
}
