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

/** Rotation interval. One day. */
export const WILD_EPOCH_MS = 24 * 60 * 60 * 1000;

/**
 * The timezone whose midnight the world rolls on. Counting straight from the
 * Unix epoch would put the boundary at midnight UTC — the middle of the
 * afternoon here — so the offset for this zone is folded in before bucketing.
 *
 * Using a named zone rather than a fixed offset means DST is handled: the roll
 * stays at local midnight across both transitions. A DST day is then genuinely
 * 23 or 25 hours long, which is what "midnight local" means. The fall-back
 * transition can make the bucket number repeat for an hour; rotation only ever
 * moves forward (see rotateWilds), so that resolves as a slightly longer day
 * rather than a world rolling backwards.
 */
export const WILD_EPOCH_TZ = 'America/Los_Angeles';

// `intervalMs` and `timeZone` are parameters rather than fixed reads of the
// constants so the server can shorten the clock (WILD_EPOCH_MS env var) to
// exercise rotation without waiting for midnight. Only the server calls these —
// the client reads the live epoch off the atlas — so changing them needs no
// client rebuild.

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    // hourCycle h23 rather than hour12:false — the latter yields hour "24" at
    // midnight in some ICU versions, which parses an entire day off.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

/** Milliseconds `timeZone` is ahead of UTC at instant `at` (negative west of
 *  it). Derived by reading the wall clock there and reinterpreting it as UTC —
 *  the only way to get a DST-correct offset without a tz database of our own. */
export function zoneOffsetMs(at: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(at)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  const asUtc = Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!);
  // Round to the second the formatter reported; sub-second precision is lost
  // there, so re-add it rather than letting the offset jitter by <1s.
  return asUtc - (at - (at % 1000));
}

/** The epoch number containing `now`. Monotonic, so it also orders saves. */
export function epochOf(
  now: number = Date.now(), intervalMs: number = WILD_EPOCH_MS, timeZone: string = WILD_EPOCH_TZ,
): number {
  return Math.floor((now + zoneOffsetMs(now, timeZone)) / intervalMs);
}

/** Wall-clock ms at which `epoch` ends and the next world begins. */
export function epochEndsAt(
  epoch: number, intervalMs: number = WILD_EPOCH_MS, timeZone: string = WILD_EPOCH_TZ,
): number {
  // (epoch + 1) * intervalMs is an instant on the LOCAL clock; converting back
  // needs the offset in force at the real instant, so approximate once and then
  // refine. Two passes settle it everywhere except inside the skipped hour of a
  // spring-forward, which no boundary can land in anyway.
  const local = (epoch + 1) * intervalMs;
  const approx = local - zoneOffsetMs(local, timeZone);
  return local - zoneOffsetMs(approx, timeZone);
}

/**
 * The seed for one epoch of the wilds. Keeps the operator-facing base seed
 * (WORLD_SEED) meaningful — same base always produces the same *sequence* of
 * worlds — while every epoch is an unrelated draw.
 */
export function epochSeed(baseSeed: string, epoch: number): string {
  return `${baseSeed}#${epoch}`;
}
