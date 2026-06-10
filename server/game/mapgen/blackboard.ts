// The Blackboard — the shared state every generator pass reads and writes.
//
// A zone is built by stacking passes (atoms). To cohere, they can't just paint
// tiles in sequence; they need to see each other's output. The blackboard holds
// four co-registered layers plus a determinism context:
//
//   1. grid     — the visible tile names (string[][]).
//   2. cost     — per-tile routing weight; Infinity = impassable to routers.
//   3. keepout  — per-tile claim bitmask; placement atoms reserve footprints.
//   4. features — named sites/anchors/regions/edges with metadata, so a later
//                 atom can target "the well" or "plot_3.door" instead of raw xy.
//
// Masks are flat typed arrays indexed `y*width + x`. Tiles still paint through
// primitives.ts onto `grid`; `cost` is derived from tiles on demand via
// syncCostFromGrid() (routers call it before pathfinding), while `keepout` is
// written explicitly by placement atoms (it is not derivable from tiles).

import { fillGrid } from './primitives.ts';
import { mulberry32, resolveSeed } from './rng.ts';
import { BLOCKING_TILES } from '../../../shared/constants.ts';
import type { Grid } from './primitives.ts';
import type { Prefab } from '../../../shared/types.ts';

export interface RegionBounds { x: number; y: number; w: number; h: number }

// Keepout claim categories. A cell can carry several at once (bitmask), e.g. a
// plaza tile reserved (RESERVED) that a road is also allowed to cross (ROAD).
export const CLAIM = {
  RESERVED: 1,
  BUILDING: 2,
  ROAD: 4,
  WATER: 8,
  SITE: 16,
} as const;
export type ClaimFlag = (typeof CLAIM)[keyof typeof CLAIM];
const ANY_CLAIM = 0xff;

export type FeatureKind = 'site' | 'anchor' | 'region' | 'edge' | 'marker';

/** A named thing on the board that a later atom may need to point at. */
export interface Feature {
  id: string;
  kind: FeatureKind;
  /** Point features (site, anchor, marker). */
  at?: { x: number; y: number };
  /** Region AABB. Region features back the legacy `bounds` map. */
  rect?: RegionBounds;
  /** Exact cells for irregular regions (caves/voronoi) — lets spawns avoid walls. */
  cells?: Int32Array;
  /** Edge features link two other features (road graph). */
  ends?: [string, string];
  tags: string[];
  meta: Record<string, unknown>;
}

/** Centroid of a feature for distance queries: explicit point, else rect center. */
function featurePoint(f: Feature): { x: number; y: number } | null {
  if (f.at) return f.at;
  if (f.rect) return { x: f.rect.x + (f.rect.w >> 1), y: f.rect.y + (f.rect.h >> 1) };
  return null;
}

function rectsIntersect(a: RegionBounds, b: RegionBounds): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export class FeatureStore {
  private byId = new Map<string, Feature>();

  add(f: Feature): string {
    this.byId.set(f.id, f);
    return f.id;
  }

  get(id: string): Feature | undefined { return this.byId.get(id); }
  has(id: string): boolean { return this.byId.has(id); }
  all(): Feature[] { return [...this.byId.values()]; }
  byKind(kind: FeatureKind): Feature[] { return this.all().filter((f) => f.kind === kind); }
  byTag(tag: string): Feature[] { return this.all().filter((f) => f.tags.includes(tag)); }

  /** Nearest feature to a point (by centroid), optionally filtered. */
  nearest(p: { x: number; y: number }, filter?: (f: Feature) => boolean): Feature | null {
    let best: Feature | null = null;
    let bestD = Infinity;
    for (const f of this.byId.values()) {
      if (filter && !filter(f)) continue;
      const c = featurePoint(f);
      if (!c) continue;
      const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

  /** Features whose point falls in `r`, or whose region rect intersects it. */
  within(r: RegionBounds, filter?: (f: Feature) => boolean): Feature[] {
    return this.all().filter((f) => {
      if (filter && !filter(f)) return false;
      if (f.rect) return rectsIntersect(f.rect, r);
      const c = featurePoint(f);
      return !!c && c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h;
    });
  }

  /** Derive the legacy `bounds` map (region id → AABB) for spawns/spawn_point. */
  regionMap(): Record<string, RegionBounds> {
    const out: Record<string, RegionBounds> = {};
    for (const f of this.byId.values()) {
      if (f.kind === 'region' && f.rect) out[f.id] = f.rect;
    }
    return out;
  }
}

export type TileCostTable = Record<string, number>;

// Walkable-tile routing costs. Blocking tiles are always Infinity (handled in
// tileCost), so this table only tunes the *relative* expense of passable tiles —
// roads cheap so routes reuse them, rough ground slightly dearer.
const DEFAULT_TILE_COST: TileCostTable = {
  dirt: 0.6,
  road: 0.4,
  stone_floor: 1,
  wood_floor: 1,
  grass: 1,
  cracked_stone_floor: 1.2,
};

export interface BlackboardOpts {
  width: number;
  height: number;
  defaultTile: string;
  /** Base seed for deterministic sub-streams; a string (zone id) is hashed. */
  seed: number | string;
  /** Zone-wide inset boundary in tiles. Consumed by placement-aware ops. */
  inset?: number;
  blocking?: ReadonlySet<string>;
  costTable?: TileCostTable;
  /** Named prefabs available by id to stamp/place ops (post_ops resolution). */
  prefabs?: Record<string, Prefab>;
}

export class Blackboard {
  readonly width: number;
  readonly height: number;
  /** Zone-wide inset boundary in tiles (0 = no boundary). */
  readonly inset: number;
  readonly grid: Grid;
  readonly cost: Float32Array;
  readonly keepout: Uint8Array;
  readonly features = new FeatureStore();
  readonly seed: number;
  readonly blocking: ReadonlySet<string>;
  /** Named prefabs available by id to stamp/place ops. Empty when none loaded. */
  readonly prefabs: Record<string, Prefab>;
  private readonly costTable: TileCostTable;

  constructor(opts: BlackboardOpts) {
    this.width = opts.width;
    this.height = opts.height;
    this.inset = opts.inset ?? 0;
    this.seed = resolveSeed(opts.seed);
    this.blocking = opts.blocking ?? BLOCKING_TILES;
    this.prefabs = opts.prefabs ?? {};
    this.costTable = opts.costTable ?? DEFAULT_TILE_COST;

    this.grid = Array.from({ length: this.height }, () => new Array<string>(this.width).fill(opts.defaultTile));
    fillGrid(this.grid, opts.defaultTile);

    const n = this.width * this.height;
    this.cost = new Float32Array(n).fill(this.tileCost(opts.defaultTile));
    this.keepout = new Uint8Array(n); // 0 = free
  }

  idx(x: number, y: number): number { return y * this.width + x; }
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  // ── tiles ────────────────────────────────────────────────────────────
  tileAt(x: number, y: number): string | undefined {
    return this.inBounds(x, y) ? this.grid[y]![x] : undefined;
  }

  /** Paint a tile and keep its routing cost in sync (override with `cost`). */
  paint(x: number, y: number, tile: string, cost?: number): void {
    if (!this.inBounds(x, y)) return;
    this.grid[y]![x] = tile;
    this.cost[this.idx(x, y)] = cost ?? this.tileCost(tile);
  }

  // ── cost ─────────────────────────────────────────────────────────────
  /** Routing cost of a tile: blocking tiles are impassable; else table or 1. */
  tileCost(tile: string): number {
    if (this.blocking.has(tile)) return Infinity;
    return this.costTable[tile] ?? 1;
  }
  costAt(x: number, y: number): number {
    return this.inBounds(x, y) ? this.cost[this.idx(x, y)]! : Infinity;
  }
  setCost(x: number, y: number, v: number): void {
    if (this.inBounds(x, y)) this.cost[this.idx(x, y)] = v;
  }
  addCost(x: number, y: number, d: number): void {
    if (this.inBounds(x, y)) this.cost[this.idx(x, y)] += d;
  }
  /** Recompute the whole cost layer from current tiles. Routers call this once
   *  before pathfinding so cost reflects every prior pass' terrain. */
  syncCostFromGrid(): void {
    for (let y = 0; y < this.height; y++) {
      const row = this.grid[y]!;
      const base = y * this.width;
      for (let x = 0; x < this.width; x++) this.cost[base + x] = this.tileCost(row[x]!);
    }
  }

  // ── keepout ──────────────────────────────────────────────────────────
  keepoutAt(x: number, y: number): number {
    return this.inBounds(x, y) ? this.keepout[this.idx(x, y)]! : ANY_CLAIM;
  }
  /** True when no claim in `mask` overlaps the cell (and it is in bounds). */
  isFree(x: number, y: number, mask: number = ANY_CLAIM): boolean {
    return this.inBounds(x, y) && (this.keepout[this.idx(x, y)]! & mask) === 0;
  }
  claim(x: number, y: number, flag: number): void {
    if (this.inBounds(x, y)) this.keepout[this.idx(x, y)]! |= flag;
  }
  claimRect(r: RegionBounds, flag: number): void {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) this.claim(x, y, flag);
    }
  }
  claimDisc(cx: number, cy: number, radius: number, flag: number): void {
    const r2 = radius * radius;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) this.claim(x, y, flag);
      }
    }
  }

  // ── determinism ──────────────────────────────────────────────────────
  /** A deterministic RNG sub-stream, independent per label so atom reordering
   *  cannot cross-contaminate and reruns are identical. */
  subRng(label: string | number): () => number {
    return mulberry32(resolveSeed(`${this.seed}:${label}`));
  }

  // ── features (convenience constructors) ──────────────────────────────
  addRegion(id: string, rect: RegionBounds, opts: { cells?: Int32Array; tags?: string[]; meta?: Record<string, unknown> } = {}): string {
    return this.features.add({ id, kind: 'region', rect, cells: opts.cells, tags: opts.tags ?? [], meta: opts.meta ?? {} });
  }
  addSite(id: string, at: { x: number; y: number }, opts: { tags?: string[]; meta?: Record<string, unknown> } = {}): string {
    return this.features.add({ id, kind: 'site', at, tags: opts.tags ?? [], meta: opts.meta ?? {} });
  }
  addAnchor(id: string, at: { x: number; y: number }, opts: { tags?: string[]; meta?: Record<string, unknown> } = {}): string {
    return this.features.add({ id, kind: 'anchor', at, tags: opts.tags ?? [], meta: opts.meta ?? {} });
  }
  addMarker(id: string, at: { x: number; y: number }, opts: { tags?: string[]; meta?: Record<string, unknown> } = {}): string {
    return this.features.add({ id, kind: 'marker', at, tags: opts.tags ?? [], meta: opts.meta ?? {} });
  }
  addEdge(id: string, ends: [string, string], opts: { tags?: string[]; meta?: Record<string, unknown> } = {}): string {
    return this.features.add({ id, kind: 'edge', ends, tags: opts.tags ?? [], meta: opts.meta ?? {} });
  }

  /** AABB of a region feature (the unit later atoms position against). */
  regionBounds(id: string): RegionBounds | undefined {
    const f = this.features.get(id);
    return f?.rect;
  }
  regionMap(): Record<string, RegionBounds> { return this.features.regionMap(); }
}
