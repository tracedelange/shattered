// Pass 1 of the staged prefab pipeline: deterministic shape primitives + wall
// derivation. No LLM. A shape primitive stamps a guaranteed-connected FLOOR MASK
// (which cells are walkable); walls are then DERIVED as the boundary of that mask
// rather than authored. Output is a structurally-valid base room that Pass 2
// (LLM op-selection) mutates and Pass 3 (linter) backstops.
//
// Design split: clean geometry lives here (floor + derived wall). Cosmetic
// "ruin" (rubble/moss/cracks) is a render-time overlay, NOT grid tiles — so the
// legend stays lean (floor + wall) and structure is unambiguous.

export type ShapeKind = 'rect' | 'circle' | 'bsp';
export type Role = 'floor' | 'wall' | 'void';

export interface ShapeOpts {
  /** Seed for stochastic shapes (bsp). Deterministic given the same seed. */
  seed?: number;
  /** Minimum room dimension for bsp splitting. */
  minRoom?: number;
}

/** Small seeded PRNG (mulberry32) so bsp layouts are deterministic per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blankMask(w: number, h: number): boolean[][] {
  return Array.from({ length: h }, () => new Array<boolean>(w).fill(false));
}

// ─── Shape primitives → floor mask (always inset ≥1 so a wall ring fits) ───────

function stampRect(w: number, h: number): boolean[][] {
  const f = blankMask(w, h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) f[y]![x] = true;
  return f;
}

function stampEllipse(w: number, h: number): boolean[][] {
  const f = blankMask(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  // Inset the radius by one so the derived wall ring stays inside the footprint;
  // corners outside the ellipse fall away to void — the rounded silhouette is
  // produced by the math, not by the model.
  const rx = Math.max(1, (w - 1) / 2 - 1);
  const ry = Math.max(1, (h - 1) / 2 - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1.0) f[y]![x] = true;
    }
  }
  return f;
}

interface Rect { x: number; y: number; w: number; h: number; }

function stampBsp(w: number, h: number, opts: ShapeOpts): boolean[][] {
  const f = blankMask(w, h);
  const minRoom = Math.max(3, opts.minRoom ?? 4);
  const rnd = mulberry32((opts.seed ?? 1) >>> 0);

  // Recursively split the interior (inside the outer wall) into leaf regions.
  const leaves: Rect[] = [];
  const split = (r: Rect, depth: number): void => {
    const canH = r.w >= minRoom * 2 + 1;
    const canV = r.h >= minRoom * 2 + 1;
    if (depth <= 0 || (!canH && !canV)) { leaves.push(r); return; }
    const splitVertical = canH && (!canV || rnd() < 0.5); // cut into left|right
    if (splitVertical) {
      const cut = minRoom + Math.floor(rnd() * (r.w - minRoom * 2));
      split({ x: r.x, y: r.y, w: cut, h: r.h }, depth - 1);
      split({ x: r.x + cut, y: r.y, w: r.w - cut, h: r.h }, depth - 1);
    } else {
      const cut = minRoom + Math.floor(rnd() * (r.h - minRoom * 2));
      split({ x: r.x, y: r.y, w: r.w, h: cut }, depth - 1);
      split({ x: r.x, y: r.y + cut, w: r.w, h: r.h - cut }, depth - 1);
    }
  };
  split({ x: 1, y: 1, w: w - 2, h: h - 2 }, 4);

  // Carve a room inside each leaf, leaving a 1-cell gap on the far edges so
  // adjacent leaves keep a wall between them (→ real internal structure).
  const rooms: Rect[] = [];
  for (const lf of leaves) {
    const room: Rect = { x: lf.x, y: lf.y, w: Math.max(2, lf.w - 1), h: Math.max(2, lf.h - 1) };
    for (let y = room.y; y < room.y + room.h && y < h - 1; y++) {
      for (let x = room.x; x < room.x + room.w && x < w - 1; x++) f[y]![x] = true;
    }
    rooms.push(room);
  }

  // Connect consecutive room centers with L-corridors → guaranteed connectivity.
  const center = (r: Rect) => ({ x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) });
  const carveH = (y: number, x0: number, x1: number) => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) if (x > 0 && x < w - 1 && y > 0 && y < h - 1) f[y]![x] = true;
  };
  const carveV = (x: number, y0: number, y1: number) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) if (x > 0 && x < w - 1 && y > 0 && y < h - 1) f[y]![x] = true;
  };
  for (let i = 1; i < rooms.length; i++) {
    const a = center(rooms[i - 1]!);
    const b = center(rooms[i]!);
    carveH(a.y, a.x, b.x);
    carveV(b.x, a.y, b.y);
  }
  return f;
}

export function stampShape(kind: ShapeKind, w: number, h: number, opts: ShapeOpts = {}): boolean[][] {
  switch (kind) {
    case 'rect': return stampRect(w, h);
    case 'circle': return stampEllipse(w, h);
    case 'bsp': return stampBsp(w, h, opts);
  }
}

// ─── Wall derivation ──────────────────────────────────────────────────────────

/** Walls are the boundary of the floor mask: any non-floor cell 8-adjacent to a
 *  floor cell becomes a wall (8-neighbour so diagonal floor steps stay sealed).
 *  Everything else is void (outside the footprint). */
export function deriveRoles(floor: boolean[][]): Role[][] {
  const h = floor.length;
  const w = h ? floor[0]!.length : 0;
  const roles: Role[][] = Array.from({ length: h }, () => new Array<Role>(w).fill('void'));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (floor[y]![x]) { roles[y]![x] = 'floor'; continue; }
      let adjacent = false;
      for (let dy = -1; dy <= 1 && !adjacent; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && nx >= 0 && ny < h && nx < w && floor[ny]![nx]) { adjacent = true; break; }
        }
      }
      roles[y]![x] = adjacent ? 'wall' : 'void';
    }
  }
  return roles;
}

// ─── Roles → prefab grid ──────────────────────────────────────────────────────

/** Tile names (from the brief's tileset) for each structural role. `void` is
 *  usually omitted → those cells become passthrough (the underlying terrain
 *  shows when the prefab is stamped into a zone). */
export interface RoleTiles { floor: string; wall: string; void?: string }

const FLOOR_CHAR = '.';
const WALL_CHAR = '#';
const VOID_CHAR = ' ';

export function rolesToGrid(roles: Role[][], tiles: RoleTiles): { data: string; legend: Record<string, string> } {
  const legend: Record<string, string> = { [FLOOR_CHAR]: tiles.floor, [WALL_CHAR]: tiles.wall };
  if (tiles.void) legend[VOID_CHAR] = tiles.void;
  const data = roles
    .map((row) => row.map((r) => (r === 'floor' ? FLOOR_CHAR : r === 'wall' ? WALL_CHAR : VOID_CHAR)).join(''))
    .join('\n');
  return { data, legend };
}

/** Convenience: stamp a shape and return a ready base grid + the role matrix. */
export function stampRoom(
  kind: ShapeKind,
  w: number,
  h: number,
  tiles: RoleTiles,
  opts: ShapeOpts = {},
): { data: string; legend: Record<string, string>; roles: Role[][]; floor: boolean[][] } {
  const floor = stampShape(kind, w, h, opts);
  const roles = deriveRoles(floor);
  return { ...rolesToGrid(roles, tiles), roles, floor };
}
