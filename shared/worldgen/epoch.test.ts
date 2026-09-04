import { describe, it, expect } from 'vitest';
import { WILD_EPOCH_MS, WILD_EPOCH_TZ, epochOf, epochEndsAt, epochSeed, zoneOffsetMs } from './epoch.ts';
import { dangerAt, deriveSeeds, wildTileAt } from './field.ts';
import { buildAtlas } from './atlas.ts';

describe('wild epoch', () => {
  it('buckets time into fixed-length epochs', () => {
    // Pinned to UTC so this reads as the arithmetic it is; the local-midnight
    // offset is exercised separately below.
    const at = (t: number) => epochOf(t, WILD_EPOCH_MS, 'UTC');
    const ends = (e: number) => epochEndsAt(e, WILD_EPOCH_MS, 'UTC');
    const e = at(1_000 * WILD_EPOCH_MS + 5);
    expect(e).toBe(1_000);
    // Every instant inside one interval resolves to the same epoch...
    expect(at(1_000 * WILD_EPOCH_MS)).toBe(e);
    expect(at(ends(e) - 1)).toBe(e);
    // ...and the next instant rolls it over exactly once.
    expect(at(ends(e))).toBe(e + 1);
  });

  it('rolls at local midnight, on both sides of a DST transition', () => {
    // The whole point of naming a timezone rather than hardcoding an offset.
    // Pacific is UTC-7 in summer and UTC-8 in winter; the roll must sit at
    // 00:00 local in both, not drift by an hour twice a year.
    const localMidnight = (iso: string) => {
      const boundary = epochEndsAt(epochOf(Date.parse(iso)));
      return new Intl.DateTimeFormat('en-US', {
        timeZone: WILD_EPOCH_TZ, hourCycle: 'h23',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).format(boundary);
    };
    expect(localMidnight('2026-07-15T12:00:00Z')).toBe('00:00:00'); // PDT
    expect(localMidnight('2026-01-15T12:00:00Z')).toBe('00:00:00'); // PST
  });

  it('reads the real UTC offset for the zone, DST included', () => {
    expect(zoneOffsetMs(Date.parse('2026-07-15T12:00:00Z'), WILD_EPOCH_TZ)).toBe(-7 * 3_600_000);
    expect(zoneOffsetMs(Date.parse('2026-01-15T12:00:00Z'), WILD_EPOCH_TZ)).toBe(-8 * 3_600_000);
    expect(zoneOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'UTC')).toBe(0);
  });

  it('never runs an epoch backwards across a DST transition', () => {
    // Falling back repeats an hour of local time, so the bucket can repeat.
    // What it must never do is decrease — rotateWilds only moves forward, and a
    // decreasing epoch would mean a world that silently stops rotating.
    let previous = -Infinity;
    const start = Date.parse('2026-10-30T00:00:00Z');
    for (let h = 0; h < 24 * 10; h++) {
      const e = epochOf(start + h * 3_600_000);
      expect(e).toBeGreaterThanOrEqual(previous);
      previous = e;
    }
  });

  it('accepts a shorter interval, and still divides Unix time by it', () => {
    // The server shortens the clock (WILD_EPOCH_MS env) to exercise rotation
    // without waiting for midnight. The boundary lands where the interval
    // divides — NOT at "now + interval" — which is why a 3-minute epoch rolls
    // on every third minute of the hour rather than 3 minutes after boot.
    const threeMin = 180_000;
    const t = 7 * threeMin + 42_000;
    expect(epochOf(t, threeMin, 'UTC')).toBe(7);
    expect(epochEndsAt(7, threeMin, 'UTC')).toBe(8 * threeMin);
    expect(epochOf(epochEndsAt(7, threeMin, 'UTC'), threeMin, 'UTC')).toBe(8);
    // The default interval is untouched by the override.
    expect(epochOf(t)).toBe(epochOf(t, WILD_EPOCH_MS));
  });

  it('derives a distinct but reproducible seed per epoch', () => {
    expect(epochSeed('silicon-soup', 7)).toBe(epochSeed('silicon-soup', 7));
    expect(epochSeed('silicon-soup', 7)).not.toBe(epochSeed('silicon-soup', 8));
    // The base seed still selects the whole sequence of worlds.
    expect(epochSeed('other', 7)).not.toBe(epochSeed('silicon-soup', 7));
  });

  it('actually re-rolls the terrain field across epochs', () => {
    const a = deriveSeeds(epochSeed('silicon-soup', 100));
    const b = deriveSeeds(epochSeed('silicon-soup', 101));
    // Sample a spread of tiles well clear of the origin anchor; two unrelated
    // seeds must disagree on a large fraction of them, or the rotation is
    // cosmetic. (Any single tile can coincide by chance — a run cannot.)
    let differences = 0;
    for (let i = 0; i < 200; i++) {
      const x = 700 + i * 37;
      const y = 900 - i * 23;
      if (wildTileAt(x, y, a) !== wildTileAt(x, y, b)) differences++;
    }
    expect(differences).toBeGreaterThan(50);
  });

  it('leaves progression where it was — danger stays radial across a rotation', () => {
    // This is the property that makes rotating the whole world safe rather than
    // hostile: a rotation re-rolls terrain, but the distance a given level of
    // danger sits at must not move, or every player's mental map of "how far I
    // can go" breaks daily. Wobble re-rolls per epoch, so the guarantee is on
    // the mean over a ring, not on any single tile.
    const atlas = buildAtlas(epochSeed('silicon-soup', 100));
    const meanDangerAtRadius = (seeds: ReturnType<typeof deriveSeeds>, r: number) => {
      let total = 0;
      const samples = 360;
      for (let i = 0; i < samples; i++) {
        const t = (i / samples) * Math.PI * 2;
        total += dangerAt(Math.cos(t) * r, Math.sin(t) * r, seeds, atlas);
      }
      return total / samples;
    };
    const a = deriveSeeds(epochSeed('silicon-soup', 100));
    const b = deriveSeeds(epochSeed('silicon-soup', 101));
    for (const r of [500, 1500, 3000]) {
      expect(Math.abs(meanDangerAtRadius(a, r) - meanDangerAtRadius(b, r))).toBeLessThan(0.05);
    }
  });
});
