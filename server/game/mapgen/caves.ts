// Cellular-automata cave generator + connectivity guarantee.
//
// SPIKE: this is the geometry-first experiment. The algorithm lays out an
// organic, meandering open space; a connectivity pass then guarantees every
// open cell is reachable (carving tunnels between disconnected pockets and
// pruning tiny ones). The LLM's job shrinks to choosing the generator and its
// parameters, then theming the result — it never hand-places the geometry.
//
// Pure and deterministic: same (width, height, opts) → identical boolean field.
// No tile strings here — the caller maps open/solid to floor/wall tiles.

import { mulberry32, resolveSeed } from './rng.ts';

export interface CaveOpts {
  /** Deterministic seed (number or named string). */
  seed: number | string;
  /** Initial wall probability for interior cells. Higher = sparser caves. Default 0.45. */
  fill?: number;
  /** Smoothing iterations. More = smoother, blobbier. Default 5. */
  iterations?: number;
  /**
   * Early iterations that also apply the radius-2 "pillar" rule: a cell becomes
   * solid when too few walls sit within 2 steps, which fills large open voids
   * with pillars and breaks one big cavern into chambers joined by passages.
   * This is what makes the result read as meandering rather than a blob.
   * Default: ceil(iterations / 2).
   */
  pillar_iterations?: number;
  /** Open pockets smaller than this are filled back to solid. Default 12. */
  minPocket?: number;
  /** Carve tunnels to join surviving pockets into one connected space. Default true. */
  connect?: boolean;
  /** Width of carved connector tunnels. Default 2. */
  tunnelWidth?: number;
}

/** Open-cell field: `open[y][x] === true` means walkable floor. */
export type OpenField = boolean[][];

/** Count solid cells within Chebyshev radius `r` of (x,y), excluding the center.
 *  Out-of-bounds counts as solid so the enclosure reads as wall. */
function wallsWithin(
  wall: boolean[][], x: number, y: number, r: number, width: number, height: number,
): number {
  let count = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || wall[ny]![nx]!) count++;
    }
  }
  return count;
}

/**
 * Generate a cavern as a boolean open/solid field of size width×height.
 * The outer ring is always solid so the cave reads as enclosed.
 */
export function generateCave(width: number, height: number, opts: CaveOpts): OpenField {
  const fill = opts.fill ?? 0.45;
  const iterations = opts.iterations ?? 5;
  const pillarIters = opts.pillar_iterations ?? Math.ceil(iterations / 2);
  const minPocket = opts.minPocket ?? 12;
  const connect = opts.connect ?? true;
  const tunnelWidth = opts.tunnelWidth ?? 2;

  if (width <= 0 || height <= 0) return [];
  const rng = mulberry32(resolveSeed(opts.seed));

  // --- 1. Random seed fill (border forced solid) -------------------------
  let wall: boolean[][] = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) =>
      x === 0 || y === 0 || x === width - 1 || y === height - 1 ? true : rng() < fill,
    ),
  );

  // --- 2. Smoothing (two-rule cave automaton) ----------------------------
  // R1: a cell becomes solid when >= 5 walls sit within 1 step (Moore). This
  //     smooths jagged noise into rounded caverns.
  // R2: during early ("pillar") iterations a cell ALSO becomes solid when <= 2
  //     walls sit within 2 steps — this fills wide-open voids with pillars and
  //     splits one big blob into chambers connected by passages.
  // Out-of-bounds counts as solid so the cave hugs its enclosure.
  for (let it = 0; it < iterations; it++) {
    const usePillar = it < pillarIters;
    const next: boolean[][] = Array.from({ length: height }, () => new Array<boolean>(width).fill(true));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) { next[y]![x] = true; continue; }
        const w1 = wallsWithin(wall, x, y, 1, width, height);
        if (w1 >= 5) { next[y]![x] = true; continue; }
        if (usePillar && wallsWithin(wall, x, y, 2, width, height) <= 2) { next[y]![x] = true; continue; }
        next[y]![x] = false;
      }
    }
    wall = next;
  }

  // --- 3. Open field + component labelling --------------------------------
  const open: OpenField = wall.map((row) => row.map((w) => !w));
  let components = labelComponents(open);

  // --- 4. Prune pockets below the size threshold -------------------------
  for (const comp of components) {
    if (comp.cells.length < minPocket) {
      for (const [x, y] of comp.cells) open[y]![x] = false;
    }
  }

  // --- 5. Guarantee connectivity ----------------------------------------
  if (connect) {
    components = labelComponents(open).sort((a, b) => b.cells.length - a.cells.length);
    if (components.length > 1) {
      const main = components[0]!;
      for (let i = 1; i < components.length; i++) {
        const comp = components[i]!;
        const [from, to] = nearestPair(comp.cells, main.cells);
        carveTunnel(open, from, to, tunnelWidth, width, height);
        // Fold the connected pocket into main so later pockets can target it too.
        main.cells.push(...comp.cells);
      }
    }
  }

  return open;
}

interface Component { cells: Array<[number, number]> }

/** 4-connected flood-fill labelling of open cells. */
function labelComponents(open: OpenField): Component[] {
  const h = open.length;
  const w = h > 0 ? open[0]!.length : 0;
  const seen = Array.from({ length: h }, () => new Array<boolean>(w).fill(false));
  const out: Component[] = [];
  const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]] as const;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!open[y]![x]! || seen[y]![x]!) continue;
      const cells: Array<[number, number]> = [];
      const queue: Array<[number, number]> = [[x, y]];
      seen[y]![x] = true;
      let qi = 0;
      while (qi < queue.length) {
        const [cx, cy] = queue[qi++]!;
        cells.push([cx, cy]);
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (open[ny]![nx]! && !seen[ny]![nx]!) { seen[ny]![nx] = true; queue.push([nx, ny]); }
        }
      }
      out.push({ cells });
    }
  }
  return out;
}

/**
 * Nearest pair of cells between two components, by squared distance. We anchor
 * the search on the smaller component's centroid-closest cell to keep it cheap
 * for large main components.
 */
function nearestPair(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
): [[number, number], [number, number]] {
  // Representative of `a`: the cell closest to a's centroid.
  let cxSum = 0, cySum = 0;
  for (const [x, y] of a) { cxSum += x; cySum += y; }
  const ax = cxSum / a.length, ay = cySum / a.length;
  let rep = a[0]!;
  let repD = Infinity;
  for (const c of a) {
    const d = (c[0] - ax) ** 2 + (c[1] - ay) ** 2;
    if (d < repD) { repD = d; rep = c; }
  }
  // Nearest `b` cell to that representative.
  let best = b[0]!;
  let bestD = Infinity;
  for (const c of b) {
    const d = (c[0] - rep[0]) ** 2 + (c[1] - rep[1]) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return [rep, best];
}

/**
 * Carve an L-shaped tunnel (horizontal run, then vertical run) between two
 * cells. Orthogonal single-cell steps guarantee the result is 4-CONNECTED —
 * a Bresenham diagonal would leave corner-only links that the 4-directional
 * movement engine cannot traverse. Border ring stays solid (cave enclosure).
 */
function carveTunnel(
  open: OpenField,
  from: [number, number],
  to: [number, number],
  width: number,
  gridW: number,
  gridH: number,
): void {
  const half = Math.max(0, Math.floor((width - 1) / 2));
  const stamp = (cx: number, cy: number): void => {
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        const px = cx + ox, py = cy + oy;
        if (px > 0 && py > 0 && px < gridW - 1 && py < gridH - 1) open[py]![px] = true;
      }
    }
  };
  let [x, y] = from;
  const [x1, y1] = to;
  stamp(x, y);
  while (x !== x1) { x += x < x1 ? 1 : -1; stamp(x, y); }
  while (y !== y1) { y += y < y1 ? 1 : -1; stamp(x, y); }
}

/**
 * Convenience used by the mapgen op: the AABB of all open cells, and an
 * always-open representative cell (centroid of the largest component snapped to
 * the nearest open cell) suitable for a spawn point or focal anchor.
 */
export function openExtent(open: OpenField): {
  aabb: { x: number; y: number; w: number; h: number } | null;
  anchor: { x: number; y: number } | null;
} {
  const comps = labelComponents(open).sort((a, b) => b.cells.length - a.cells.length);
  if (comps.length === 0) return { aabb: null, anchor: null };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const comp of comps) {
    for (const [x, y] of comp.cells) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const main = comps[0]!;
  let cxSum = 0, cySum = 0;
  for (const [x, y] of main.cells) { cxSum += x; cySum += y; }
  const mx = cxSum / main.cells.length, my = cySum / main.cells.length;
  let anchor = main.cells[0]!;
  let aD = Infinity;
  for (const c of main.cells) {
    const d = (c[0] - mx) ** 2 + (c[1] - my) ** 2;
    if (d < aD) { aD = d; anchor = c; }
  }
  return {
    aabb: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    anchor: { x: anchor[0], y: anchor[1] },
  };
}
