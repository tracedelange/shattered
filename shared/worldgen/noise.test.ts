import { describe, expect, it } from 'vitest';
import { hash2d, hashString, mulberry32, octaveNoise, resolveSeed, valueNoise } from './noise.ts';

// The determinism contract (R8.7): server and client generate the same terrain
// from the same seed, so every function here must be pure and reproducible.
describe('noise determinism', () => {
  it('gives the same PRNG stream for the same seed', () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    const runA = Array.from({ length: 8 }, () => a());
    const runB = Array.from({ length: 8 }, () => b());
    expect(runA).toEqual(runB);
  });

  it('gives a different stream for a different seed', () => {
    const a = Array.from({ length: 8 }, mulberry32(1));
    const b = Array.from({ length: 8 }, mulberry32(2));
    expect(a).not.toEqual(b);
  });

  it('keeps mulberry32 output in [0, 1)', () => {
    const rng = mulberry32(0xdeadbeef);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('resolves a string seed to a stable number, and passes a number through', () => {
    expect(resolveSeed('emberfall')).toBe(hashString('emberfall'));
    expect(resolveSeed('emberfall')).toBe(resolveSeed('emberfall'));
    expect(resolveSeed(42)).toBe(42);
    // Negative seeds are coerced to uint32 rather than rejected.
    expect(resolveSeed(-1)).toBe(0xffffffff);
  });

  it('hashes a lattice point to a stable value in [0, 1)', () => {
    expect(hash2d(3, -7, 99)).toBe(hash2d(3, -7, 99));
    expect(hash2d(3, -7, 99)).not.toBe(hash2d(3, -7, 100));
    for (let x = -5; x < 5; x++) {
      const v = hash2d(x, x * 3, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('valueNoise / octaveNoise', () => {
  it('stays in [0, 1) across a sampled grid', () => {
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const v = valueNoise(x, y, 8, 4242);
        const o = octaveNoise(x, y, 4, 8, 0.5, 2, 4242);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThan(1);
      }
    }
  });

  it('is continuous — neighbouring samples do not jump like raw hash values', () => {
    // Smoothed, so a one-tile step inside a scale-16 feature is a small step.
    for (let x = 0; x < 30; x++) {
      const delta = Math.abs(valueNoise(x + 1, 0, 16, 5) - valueNoise(x, 0, 16, 5));
      expect(delta).toBeLessThan(0.5);
    }
  });

  it('guards against a zero scale rather than dividing by it', () => {
    expect(Number.isFinite(valueNoise(3, 4, 0, 1))).toBe(true);
  });
});
