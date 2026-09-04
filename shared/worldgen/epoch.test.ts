import { describe, it, expect } from 'vitest';
import { WILD_EPOCH_MS, epochOf, epochEndsAt, epochSeed } from './epoch.ts';
import { dangerAt, deriveSeeds, wildTileAt } from './field.ts';
import { buildAtlas } from './atlas.ts';

describe('wild epoch', () => {
  it('buckets time into fixed-length epochs', () => {
    const e = epochOf(1_000 * WILD_EPOCH_MS + 5);
    expect(e).toBe(1_000);
    // Every instant inside one interval resolves to the same epoch...
    expect(epochOf(1_000 * WILD_EPOCH_MS)).toBe(e);
    expect(epochOf(epochEndsAt(e) - 1)).toBe(e);
    // ...and the next instant rolls it over exactly once.
    expect(epochOf(epochEndsAt(e))).toBe(e + 1);
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
