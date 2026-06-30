// Procedural ability-icon generator — deterministic, seed-driven pixel-grid
// glyphs (think identicons/boring-avatars, but pixel-art to match the game's
// sprites). Pure and dependency-free so it runs identically in the browser
// (ability-editor preview) and in Node (baking to PNG via pngjs).
//
// The look is *semantic by default*: brand picks the palette, the effect kind
// picks the core motif, the targeting shape picks the symmetry. The seed varies
// the STRUCTURE (motif frequency + rotation + decorative detail), so different
// abilities — and re-rolls — look genuinely different. Every semantic default
// can be overridden from the editor knobs (see IconSpec optional fields).
//
// Shading: each lit cell gets a continuous TONE from radial depth + directional
// light (volume) + per-cell noise, then is colored through a rich multi-stop
// ramp with ordered (Bayer) dithering between stops — gradients without banding,
// while staying limited-palette pixel-art. Complexity (fill, stops, detail)
// scales with rank.

export type IconKind = 'damage' | 'heal' | 'modifier' | 'move';
export type IconShape = 'self' | 'target' | 'projectile' | 'area';
export type MotifKind = 'star' | 'burst' | 'cross' | 'ring' | 'chevron' | 'spiral' | 'diamond';
export type SymmetryMode = 'mirror' | 'radial' | 'none';

export interface IconSpec {
  id: string;          // ability id — anchors the deterministic base seed
  brand?: string;      // BRAND_KEY (fire_damage, cold_damage, …) → palette
  kind: IconKind;      // primary effect kind → default motif
  shape: IconShape;    // targeting shape → default symmetry
  rank: number;        // 1-based; drives the complexity dials
  seed: number;        // re-roll knob; varies structure + detail

  // ── Optional overrides (editor knobs). Omit → semantic/rank/seed default. ──
  motif?: MotifKind;
  symmetry?: SymmetryMode;
  ramp?: string;       // palette ramp key (a brand key, or 'steel')
  spikes?: number;     // motif frequency (star points, ring nodes, spiral arms)
  rotation?: number;   // degrees, rotates the motif
  fill?: number;       // 0..1 override of the rank fill
  colors?: number;     // shade-stop count override
  layers?: number;     // accent-pass count override
  glow?: boolean;      // halo override
  grid?: number;       // cells per side override (forced odd)
}

export interface Complexity {
  grid: number;     // cells per side (odd)
  fill: number;     // 0..1 fraction of the tile radius the glyph may occupy
  palette: number;  // number of ramp stops used (>= 2)
  layers: number;   // extra decorative accent passes
  glow: boolean;    // outer halo ring at top rank
}

/** Complexity as a pure function of rank — the single place ranks get richer. */
export function complexityForRank(rank: number): Complexity {
  const r = Math.max(1, rank);
  const t = Math.min(1, (r - 1) / 2); // 0 at R1 → 1 at R3+
  return {
    grid: [7, 9, 11][Math.min(r - 1, 2)] ?? 11,
    fill: 0.40 + 0.50 * t,
    palette: [4, 6, 7][Math.min(r - 1, 2)] ?? 7, // more ramp stops at higher rank
    layers: r - 1,
    glow: r >= 3,
  };
}

// Default motif per effect kind (overridable via spec.motif).
const KIND_MOTIF: Record<IconKind, MotifKind> = {
  damage: 'star', heal: 'cross', modifier: 'ring', move: 'chevron',
};

// ── Palettes ────────────────────────────────────────────────────────────────
// 7-stop ramps, lightest → darkest, with deliberate HUE movement (not just
// lightness) for richness: e.g. lightning runs a yellow core into a violet
// shadow; fire warms through gold→orange→crimson→maroon. Shade is chosen by
// tone (depth + lighting) and dithered between adjacent stops.
const RAMPS: Record<string, string[]> = {
  fire_damage:      ['#fff6d8', '#ffe27a', '#ffb02a', '#ff6a12', '#e0330a', '#a01408', '#5a0a10'],
  cold_damage:      ['#f0fcff', '#c8f2ff', '#84d4ff', '#3aa0f5', '#1f63d8', '#1438a0', '#0c1f63'],
  poison_damage:    ['#f2ffd6', '#d8ff8a', '#9be84a', '#54c62a', '#2a9220', '#176b22', '#0c3d1f'],
  lightning_damage: ['#fffce0', '#fff07a', '#ffd21f', '#ffb000', '#c47af0', '#7a3de0', '#3a1880'],
  arcane_damage:    ['#fff0ff', '#f7c8ff', '#e08aff', '#c44aff', '#9420e0', '#6a14b0', '#380a6e'],
  _default:         ['#fbfdff', '#dfe9f2', '#aebccc', '#7c8c9e', '#52606e', '#323b46', '#1a2028'],
};
const ACCENT = '#ffffff'; // sparkle highlight

function ramp(key?: string): string[] {
  return RAMPS[key ?? '_default'] ?? RAMPS._default;
}

// 4×4 Bayer matrix, normalized to (0,1) thresholds for ordered dithering.
const BAYER = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

// ── Seeded hashing ────────────────────────────────────────────────────────────
function strHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** Deterministic [0,1) from a base seed and two cell coords. Keying by the
 *  *canonical* (folded) cell makes mirrored cells share a value → clean symmetry. */
function cellRand(base: number, x: number, y: number): number {
  let h = (base ^ Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ── Motifs ────────────────────────────────────────────────────────────────────
// Returns a 0..1 preference for a cell at normalized (cx, cy) ∈ [-1,1], given a
// frequency (spikes) and rotation (radians).
function motif(kind: MotifKind, cx: number, cy: number, spikes: number, rot: number): number {
  if (rot) { const c = Math.cos(rot), s = Math.sin(rot); const x = cx * c - cy * s; cy = cx * s + cy * c; cx = x; }
  const r = Math.hypot(cx, cy);
  const ang = Math.atan2(cy, cx);
  switch (kind) {
    case 'star': {
      const s = 0.5 + 0.5 * Math.cos(spikes * ang);
      return clamp01(0.55 * s + 0.7 * (1 - r));
    }
    case 'burst': {
      const s = Math.abs(Math.cos((spikes / 2) * ang));
      return clamp01(0.7 * s * s * (1 - 0.5 * r) + 0.5 * (1 - r));
    }
    case 'cross': {
      const cross = Math.max(1 - Math.abs(cx) / 0.28, 1 - Math.abs(cy) / 0.28);
      return clamp01(Math.max(cross * (1 - 0.4 * r), 1 - 1.2 * r));
    }
    case 'ring': {
      const ring = 1 - Math.abs(r - 0.62) / 0.34;
      const nodes = 0.6 + 0.4 * Math.cos(spikes * ang);
      return clamp01(Math.max(ring * nodes, 0.5 * (1 - 2.2 * r)));
    }
    case 'chevron': {
      const allowed = ((cy + 1) / 2) * 0.95;
      const inTri = Math.abs(cx) < allowed && cy > -0.92 ? 1 : 0;
      const shaft = Math.abs(cx) < 0.18 ? 1 : 0;
      return clamp01(Math.max(inTri, shaft) * (1 - 0.25 * r));
    }
    case 'spiral': {
      const sp = 0.5 + 0.5 * Math.cos(spikes * ang + r * 6);
      return clamp01(sp * (1 - 0.55 * r));
    }
    case 'diamond': {
      const d = 1 - (Math.abs(cx) + Math.abs(cy));
      const facet = 0.5 + 0.5 * Math.cos(spikes * ang);
      return clamp01(d * (0.7 + 0.3 * facet));
    }
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function hexToRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Logical cell states. LIT cells additionally carry a tone in the `tone` array.
const EMPTY = -1, LIT = 0, OUTLINE_CELL = -2, GLOW_CELL = -3, ACCENT_CELL = -4;

// Light direction (upper-left) used to give the glyph volume.
const LX = -0.45, LY = -0.5;

/**
 * Render an ability icon to a flat RGBA buffer of `size`×`size` pixels.
 * Returns Uint8ClampedArray (length size*size*4), nearest-neighbor upscaled
 * from the logical cell grid (with per-pixel dithering inside lit cells).
 */
export function renderAbilityIcon(spec: IconSpec, size = 64): Uint8ClampedArray {
  const cx = complexityForRank(spec.rank);
  const base = (strHash(spec.id) ^ Math.imul(spec.seed + 1, 0x9e3779b1)) >>> 0;

  // Resolve effective params: explicit override → semantic/rank/seed default.
  let N = spec.grid ?? cx.grid; if (N % 2 === 0) N += 1;
  const fill = spec.fill ?? cx.fill;
  const layers = spec.layers ?? cx.layers;
  const glow = spec.glow ?? cx.glow;
  const rampStops = ramp(spec.ramp ?? spec.brand);
  const stopCount = Math.max(2, Math.min(rampStops.length, spec.colors ?? cx.palette));
  const pal = rampStops.slice(0, stopCount).map(hexToRgb);
  const motifKind = spec.motif ?? KIND_MOTIF[spec.kind];
  const symMode: SymmetryMode = spec.symmetry ?? (spec.shape === 'area' ? 'radial' : 'mirror');
  // Seed-derived structure so different ids/seeds look different.
  const spikes = spec.spikes ?? 4 + (base % 4);                 // 4..7
  const rotDeg = spec.rotation ?? ((base >>> 3) % 12) * 30;     // 0..330
  const rot = (rotDeg * Math.PI) / 180;

  const state = new Int16Array(N * N).fill(EMPTY);
  const tone = new Float32Array(N * N);
  const c = (N - 1) / 2;

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      // Fold to a canonical cell so symmetric cells share motif + randomness.
      const fi = symMode === 'none' ? i : Math.min(i, N - 1 - i);
      const fj = symMode === 'radial' ? Math.min(j, N - 1 - j) : j;
      const nx = (fi - c) / c;
      const ny = (fj - c) / c;
      const r = Math.hypot(nx, ny);
      if (r > fill * 1.08) continue; // leave a margin for the outline

      const w = motif(motifKind, nx, ny, spikes, rot);
      const jit = cellRand(base, fi, fj);
      const on = w + 0.22 * (jit - 0.5) > (1 - fill) * 0.85 + 0.12;
      if (!on) continue;

      // Continuous tone: 0 = lightest (lit core / facing light), 1 = darkest.
      const depth = clamp01(r / Math.max(0.001, fill));            // rim is deeper
      const lightDist = Math.hypot(nx - LX, ny - LY) / 1.9;        // far from light = darker
      const noise = (cellRand(base ^ 0x5bd1e995, fi, fj) - 0.5) * 0.16;
      const t = clamp01(0.34 * depth + 0.52 * clamp01(lightDist) + noise);

      state[j * N + i] = LIT;
      tone[j * N + i] = t;
    }
  }

  // Decorative accent sparkles (one cluster per layer), placed on lit cells.
  for (let L = 0; L < layers; L++) {
    for (let k = 0; k < 2; k++) {
      const rx = cellRand(base + 101 + L, k, 7);
      const ry = cellRand(base + 211 + L, k, 13);
      const i = Math.floor(rx * N), j = Math.floor(ry * N);
      if (state[j * N + i] === LIT) {
        state[j * N + i] = ACCENT_CELL;
        if (symMode !== 'none') state[j * N + (N - 1 - i)] = ACCENT_CELL;
      }
    }
  }

  // Outline pass: empty cells touching a lit/accent cell become outline.
  const solid = (i: number, j: number) =>
    i >= 0 && i < N && j >= 0 && j < N && (state[j * N + i] === LIT || state[j * N + i] === ACCENT_CELL);
  const snapshot = Int16Array.from(state);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (snapshot[j * N + i] !== EMPTY) continue;
      if (solid(i - 1, j) || solid(i + 1, j) || solid(i, j - 1) || solid(i, j + 1)) state[j * N + i] = OUTLINE_CELL;
    }
  }

  // Glow halo just outside the glyph.
  if (glow) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (state[j * N + i] !== EMPTY) continue;
        const fi = symMode === 'none' ? i : Math.min(i, N - 1 - i);
        const fj = symMode === 'radial' ? Math.min(j, N - 1 - j) : j;
        const r = Math.hypot((fi - c) / c, (fj - c) / c);
        if (r >= fill * 0.9 && r <= fill * 1.25) state[j * N + i] = GLOW_CELL;
      }
    }
  }

  // Colors derived from the ramp.
  const outlineRgb = mix(pal[pal.length - 1], [0, 0, 0], 0.5);  // tinted dark, not pure black
  const accentRgb = hexToRgb(ACCENT);
  const glowRgb = pal[Math.min(2, pal.length - 1)];
  const maxI = pal.length - 1;

  // Rasterize: nearest-neighbor upscale; lit cells dither between adjacent stops.
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const j = Math.min(N - 1, Math.floor((y / size) * N));
    for (let x = 0; x < size; x++) {
      const i = Math.min(N - 1, Math.floor((x / size) * N));
      const s = state[j * N + i];
      const o = (y * size + x) * 4;
      let rgb: [number, number, number] | null = null;
      let a = 255;
      if (s === LIT) {
        const f = tone[j * N + i] * maxI;
        const lo = Math.min(maxI, Math.floor(f));
        const hi = Math.min(maxI, lo + 1);
        rgb = (f - lo) > BAYER[y & 3][x & 3] ? pal[hi] : pal[lo];
      } else if (s === OUTLINE_CELL) rgb = outlineRgb;
      else if (s === ACCENT_CELL) rgb = accentRgb;
      else if (s === GLOW_CELL) { rgb = glowRgb; a = 90; }
      if (rgb) { out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = a; }
    }
  }
  return out;
}
