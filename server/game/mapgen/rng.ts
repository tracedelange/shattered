// Deterministic PRNG + seeded value noise. Same seed → identical output.
// All functions are pure and total. No Math.random anywhere in mapgen.

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function resolveSeed(seed: number | string): number {
  return typeof seed === 'number' ? (seed >>> 0) : hashString(seed);
}

// mulberry32: small, fast, deterministic PRNG. Returns [0, 1).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2D integer hash → [0, 1). Used for lattice noise corner values.
function hash2d(x: number, y: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 374761393) >>> 0;
  h = Math.imul(h ^ (y | 0), 668265263) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// Fractal Brownian Motion: sum of valueNoise octaves with decreasing amplitude.
// persistence controls amplitude falloff per octave; lacunarity controls frequency growth.
// Returns [0, 1) (normalized by max possible amplitude sum).
export function octaveNoise(
  x: number, y: number,
  octaves: number, scale: number,
  persistence: number, lacunarity: number,
  seed: number,
): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;
  for (let i = 0; i < octaves; i++) {
    value += valueNoise(x * frequency, y * frequency, scale, seed + i * 7919) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  return value / maxValue;
}

// Smoothed value noise. `scale` controls feature size (higher = bigger blobs).
// Returns [0, 1).
export function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const s = Math.max(0.0001, scale);
  const fx = x / s, fy = y / s;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const dx = smoothstep(fx - x0), dy = smoothstep(fy - y0);
  const v00 = hash2d(x0,     y0,     seed);
  const v10 = hash2d(x0 + 1, y0,     seed);
  const v01 = hash2d(x0,     y0 + 1, seed);
  const v11 = hash2d(x0 + 1, y0 + 1, seed);
  const a = v00 * (1 - dx) + v10 * dx;
  const b = v01 * (1 - dx) + v11 * dx;
  return a * (1 - dy) + b * dy;
}
