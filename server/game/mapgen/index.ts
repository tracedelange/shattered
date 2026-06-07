// Op-driven zone generator. Builds a Blackboard, runs each op as a pass that
// reads/writes it (tiles, cost, keepout, features), then derives the legacy
// bounds map and focal point. 100% deterministic: same ZoneDef → same grid.
//
// Atoms operate on the shared Blackboard so later passes can see earlier ones'
// output. Tile-only ops (fill/region/road/...) just paint grid + register
// region features; placement/network atoms (to come) use the cost/keepout masks.

import {
  paintArc, paintCircle, paintEllipse, paintLine, paintPath,
  paintPolygon, paintRect, paintScatter, paintWalls, type Grid,
} from './primitives.ts';
import { resolveSeed, valueNoise } from './rng.ts';
import { ARCHETYPES } from './archetypes.ts';
import { generateCave, openExtent } from './caves.ts';
import { Blackboard, CLAIM, type RegionBounds } from './blackboard.ts';
import { BLOCKING_TILES as BLOCKING } from '../../../shared/constants.ts';
import type {
  BoundsRef, ClaimCategory, GenOp, PointRef, PositionSpec, ShapeSpec, ZoneDef,
} from '../../../shared/types.ts';

const CLAIM_BY_NAME: Record<ClaimCategory, number> = {
  reserved: CLAIM.RESERVED,
  building: CLAIM.BUILDING,
  road: CLAIM.ROAD,
  water: CLAIM.WATER,
  site: CLAIM.SITE,
};

const DEFAULT_GRID_W = 40;
const DEFAULT_GRID_H = 30;
const DEFAULT_FALLBACK_TILE = 'grass';

export interface ZoneGrid {
  grid: Grid;
  bounds: Record<string, RegionBounds>;
  width: number;
  height: number;
  /** Resolved focal point — the narrative anchor tile. Null if unresolvable. */
  focal: { x: number; y: number } | null;
  /** The full generation state (tiles, cost, keepout, features) for debug overlays. */
  blackboard: Blackboard;
}

interface ResolvedShape {
  // Axis-aligned bounding box, post-positioning.
  bounds: RegionBounds;
  // Paints the shape onto a grid.
  paint: (grid: Grid, tile: string) => void;
}

function shapeAABBSize(shape: ShapeSpec): { w: number; h: number } {
  switch (shape.kind) {
    case 'rect':    return { w: shape.w, h: shape.h };
    case 'circle':  return { w: shape.r * 2, h: shape.r * 2 };
    case 'ellipse': return { w: shape.rx * 2, h: shape.ry * 2 };
    case 'polygon': {
      let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
      for (const [x, y] of shape.points) {
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      }
      return { w: Math.ceil(xMax - xMin), h: Math.ceil(yMax - yMin) };
    }
  }
}

function resolvePosition(size: { w: number; h: number }, at: PositionSpec, bb: Blackboard): { x: number; y: number } {
  if ('center' in at) {
    return { x: Math.floor((bb.width - size.w) / 2), y: Math.floor((bb.height - size.h) / 2) };
  }
  if ('x' in at) {
    return { x: at.x, y: at.y };
  }
  const parent = bb.regionBounds(at.relative_to);
  if (!parent) throw new Error(`relative_to: '${at.relative_to}' — region not yet defined`);
  const gap = at.gap ?? 1;
  const cx = parent.x + Math.floor(parent.w / 2);
  const cy = parent.y + Math.floor(parent.h / 2);
  switch (at.side) {
    case 'north': return { x: cx - Math.floor(size.w / 2), y: parent.y - size.h - gap };
    case 'south': return { x: cx - Math.floor(size.w / 2), y: parent.y + parent.h + gap };
    case 'east':  return { x: parent.x + parent.w + gap,    y: cy - Math.floor(size.h / 2) };
    case 'west':  return { x: parent.x - size.w - gap,      y: cy - Math.floor(size.h / 2) };
  }
}

function resolveShape(shape: ShapeSpec, at: PositionSpec, bb: Blackboard): ResolvedShape {
  const size = shapeAABBSize(shape);
  const pos = resolvePosition(size, at, bb);
  const aabb = { x: pos.x, y: pos.y, w: size.w, h: size.h };
  const cx = pos.x + size.w / 2;
  const cy = pos.y + size.h / 2;
  let paint: ResolvedShape['paint'];
  switch (shape.kind) {
    case 'rect':
      paint = (grid, tile) => paintRect(grid, pos.x, pos.y, size.w, size.h, tile);
      break;
    case 'circle':
      paint = (grid, tile) => paintCircle(grid, cx, cy, shape.r, tile);
      break;
    case 'ellipse':
      paint = (grid, tile) => paintEllipse(grid, cx, cy, shape.rx, shape.ry, tile);
      break;
    case 'polygon': {
      // Polygon points are in absolute zone coords; `at` is always ignored.
      // Warn when the caller supplied a meaningful at value so they know it had
      // no effect. (at: { x:0, y:0 } is the default fallback — skip it.)
      const isNonTrivialAt =
        ('center' in at) ||
        ('relative_to' in at) ||
        ('x' in at && ((at as { x: number }).x !== 0 || (at as { y: number }).y !== 0));
      if (isNonTrivialAt) {
        console.warn(
          `[mapgen] polygon shape: 'at' field (${JSON.stringify(at)}) is ignored. ` +
          `Polygon points are always in absolute zone coordinates. ` +
          `Encode the intended position directly in the points array.`,
        );
      }
      const points = shape.points;
      paint = (grid, tile) => paintPolygon(grid, points, tile);
      // Recompute AABB from absolute points.
      let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
      for (const [x, y] of points) {
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      }
      aabb.x = Math.floor(xMin);
      aabb.y = Math.floor(yMin);
      aabb.w = Math.ceil(xMax - xMin);
      aabb.h = Math.ceil(yMax - yMin);
      break;
    }
  }
  return { bounds: aabb, paint };
}

function resolveBoundsRef(ref: BoundsRef, bb: Blackboard): RegionBounds {
  if ('all' in ref) return { x: 0, y: 0, w: bb.width, h: bb.height };
  if ('rect' in ref) return ref.rect;
  const r = bb.regionBounds(ref.region);
  if (!r) throw new Error(`bounds ref: region '${ref.region}' not defined`);
  return r;
}

function resolvePoint(ref: PointRef, bb: Blackboard): { x: number; y: number } {
  if ('x' in ref) return { x: ref.x, y: ref.y };
  if ('feature' in ref) {
    const f = bb.features.get(ref.feature);
    if (!f) throw new Error(`point ref: feature '${ref.feature}' not defined`);
    if (f.at) return f.at;
    if (f.rect) return { x: f.rect.x + Math.floor(f.rect.w / 2), y: f.rect.y + Math.floor(f.rect.h / 2) };
    throw new Error(`point ref: feature '${ref.feature}' has no position`);
  }
  if ('edge' in ref) {
    const t = Math.min(1, Math.max(0, ref.t ?? 0.5));
    switch (ref.edge) {
      case 'north': return { x: Math.round(t * (bb.width  - 1)), y: 0 };
      case 'south': return { x: Math.round(t * (bb.width  - 1)), y: bb.height - 1 };
      case 'west':  return { x: 0,             y: Math.round(t * (bb.height - 1)) };
      case 'east':  return { x: bb.width - 1,  y: Math.round(t * (bb.height - 1)) };
    }
  }
  const r = bb.regionBounds(ref.region);
  if (!r) throw new Error(`point ref: region '${ref.region}' not defined`);
  const cx = r.x + Math.floor(r.w / 2);
  const cy = r.y + Math.floor(r.h / 2);
  switch (ref.anchor) {
    case 'north': return { x: cx, y: r.y };
    case 'south': return { x: cx, y: r.y + r.h - 1 };
    case 'east':  return { x: r.x + r.w - 1, y: cy };
    case 'west':  return { x: r.x,           y: cy };
    case 'center':
    default:      return { x: cx, y: cy };
  }
}

export function generateZoneGrid(
  zoneDef: ZoneDef,
  blockingTiles: ReadonlySet<string> = BLOCKING,
): ZoneGrid {
  const width = zoneDef.width || DEFAULT_GRID_W;
  const height = zoneDef.height || DEFAULT_GRID_H;
  const defaultTile = zoneDef.default_tile || DEFAULT_FALLBACK_TILE;
  const bb = new Blackboard({ width, height, defaultTile, seed: zoneDef.id, blocking: blockingTiles });

  const ops = zoneDef.ops || [];

  // Warn when a dungeon/interior zone uses a walkable default_tile alongside
  // walled regions — the classic dungeon-carving bug where background is traversable.
  // Outdoor zones (those with edge connections) are exempt: background grass/dirt is expected.
  if (!blockingTiles.has(defaultTile)) {
    const hasEdgeConnections = Object.values((zoneDef as { connections?: Record<string, unknown> }).connections || {}).some(Boolean);
    if (!hasEdgeConnections) {
      const hasWalledRegion = ops.some(op => op.type === 'region' && (op as { walls?: unknown }).walls);
      if (hasWalledRegion) {
        console.warn(
          `[mapgen] zone '${zoneDef.id}': default_tile '${defaultTile}' is walkable ` +
          `but the zone has walled regions. Background tiles will be traversable. ` +
          `Use default_tile: wall or void for dungeon/indoor zones.`,
        );
      }
    }
  }

  for (const op of ops) applyOp(op, bb);

  // Paint portal markers last so they sit on top of any underlying terrain.
  for (const p of zoneDef.portals || []) {
    if (!p?.at) continue;
    const px = p.at.x | 0;
    const py = p.at.y | 0;
    const t = p.tile === undefined ? 'portal' : p.tile;
    if (t === null) continue;
    if (px < 0 || px >= width || py < 0 || py >= height) continue;
    bb.paint(px, py, t);
  }

  const bounds = bb.regionMap();
  const focal = resolveFocalPoint(zoneDef, bounds, width, height);

  return { grid: bb.grid, bounds, width, height, focal, blackboard: bb };
}

const clampToZone = (
  p: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } => ({
  x: Math.max(0, Math.min(width - 1, Math.round(p.x))),
  y: Math.max(0, Math.min(height - 1, Math.round(p.y))),
});

/**
 * Resolves a zone's focal point — the narrative anchor — to a tile coordinate.
 *
 * Resolution order:
 *   1. An explicit `focal_point` ({ region } | { x, y } | { landmark_offset }).
 *   2. The `landmark`, shifted by the archetype's default focal offset.
 *   3. The zone center.
 */
export function resolveFocalPoint(
  zoneDef: ZoneDef,
  bounds: Record<string, RegionBounds>,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const fp = zoneDef.focal_point;
  const landmark = zoneDef.landmark;

  if (fp) {
    if ('region' in fp) {
      const r = bounds[fp.region];
      if (r) return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
    } else if ('x' in fp) {
      return clampToZone({ x: fp.x, y: fp.y }, width, height);
    } else if ('landmark_offset' in fp && landmark) {
      return clampToZone(
        { x: landmark.x + fp.landmark_offset.dx, y: landmark.y + fp.landmark_offset.dy },
        width, height,
      );
    }
  }

  const anchor = landmark ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  const arch = zoneDef.archetype ? ARCHETYPES[zoneDef.archetype] : undefined;
  const dx = arch ? Math.round(arch.focalOffset.fx * width) : 0;
  const dy = arch ? Math.round(arch.focalOffset.fy * height) : 0;
  return clampToZone({ x: anchor.x + dx, y: anchor.y + dy }, width, height);
}

function applyOp(op: GenOp, bb: Blackboard): void {
  switch (op.type) {
    case 'fill': {
      const b = op.bounds ? resolveBoundsRef(op.bounds, bb) : { x: 0, y: 0, w: bb.width, h: bb.height };
      paintRect(bb.grid, b.x, b.y, b.w, b.h, op.tile);
      return;
    }
    case 'region': {
      const r = resolveShape(op.shape, op.at, bb);
      if (op.floor) r.paint(bb.grid, op.floor);
      if (op.walls) {
        // Walls only meaningful for rectangular regions; circles/polygons skip.
        if (op.shape.kind === 'rect') {
          paintWalls(bb.grid, r.bounds.x, r.bounds.y, r.bounds.w, r.bounds.h, op.walls.tile, op.walls.door?.side, op.walls.door?.tile);
        } else {
          console.warn(
            `[mapgen] region '${op.id}': walls is only supported for rect shapes. ` +
            `Shape '${op.shape.kind}' — walls field ignored. ` +
            `Use separate shape ops to paint wall tiles manually for non-rect regions.`,
          );
        }
      }
      bb.addRegion(op.id, r.bounds);
      return;
    }
    case 'shape': {
      const r = resolveShape(op.shape, op.at, bb);
      r.paint(bb.grid, op.tile);
      return;
    }
    case 'road': {
      const a = resolvePoint(op.from, bb);
      const b = resolvePoint(op.to,   bb);
      paintLine(bb.grid, a.x, a.y, b.x, b.y, op.tile, op.width ?? 1);
      return;
    }
    case 'path': {
      const pts: [number, number][] = op.points.map(p => {
        const r = resolvePoint(p, bb);
        return [r.x, r.y];
      });
      const seed = op.seed != null ? resolveSeed(op.seed) : 0;
      paintPath(bb.grid, pts, op.tile, op.width ?? 1, op.jitter ?? 0, seed);
      return;
    }
    case 'arc': {
      const a = resolvePoint(op.from, bb);
      const b = resolvePoint(op.to,   bb);
      paintArc(bb.grid, a.x, a.y, b.x, b.y, op.bulge, op.tile, op.width ?? 1);
      return;
    }
    case 'scatter': {
      const b = resolveBoundsRef(op.bounds, bb);
      const seed = resolveSeed(op.seed);
      const over = op.over == null
        ? undefined
        : (Array.isArray(op.over) ? new Set(op.over) : new Set([op.over]));
      paintScatter(bb.grid, b.x, b.y, b.w, b.h, op.tile, op.count, seed, over);
      return;
    }
    case 'noise_patch': {
      const b = resolveBoundsRef(op.bounds, bb);
      const seed = resolveSeed(op.seed);
      const over = op.over == null
        ? null
        : (Array.isArray(op.over) ? new Set(op.over) : new Set([op.over]));
      for (let y = b.y; y < b.y + b.h; y++) {
        if (y < 0 || y >= bb.height) continue;
        const row = bb.grid[y]!;
        for (let x = b.x; x < b.x + b.w; x++) {
          if (x < 0 || x >= bb.width) continue;
          if (over && !over.has(row[x]!)) continue;
          if (valueNoise(x, y, op.scale, seed) >= op.threshold) row[x] = op.tile;
        }
      }
      return;
    }
    case 'sketch': {
      const ox = op.at?.x ?? 0;
      const oy = op.at?.y ?? 0;
      const scale = Math.max(1, Math.round(op.scale ?? 1));
      const lines = op.data.split('\n');
      for (let row = 0; row < lines.length; row++) {
        const line = lines[row]!;
        for (let col = 0; col < line.length; col++) {
          const tile = op.legend[line[col]!];
          if (!tile) continue;
          paintRect(bb.grid, ox + col * scale, oy + row * scale, scale, scale, tile);
        }
      }
      return;
    }
    case 'voronoi': {
      applyVoronoi(op, bb);
      return;
    }
    case 'cave': {
      applyCave(op, bb);
      return;
    }
    case 'scatter_sites': {
      applyScatterSites(op, bb);
      return;
    }
    case 'route': {
      applyRoute(op, bb);
      return;
    }
  }
}

function toSet(v: string | string[] | undefined): Set<string> | null {
  if (v == null) return null;
  return Array.isArray(v) ? new Set(v) : new Set([v]);
}

/**
 * Blue-noise site placement (Poisson-disk by rejection). Scatters `count`
 * points at least `spacing` apart on free, optionally tile-restricted cells,
 * registers each as a `site` feature, and reserves a keepout disc so later
 * placements (and other sites) keep their distance.
 */
function applyScatterSites(op: Extract<GenOp, { type: 'scatter_sites' }>, bb: Blackboard): void {
  const region = op.bounds ? resolveBoundsRef(op.bounds, bb) : { x: 0, y: 0, w: bb.width, h: bb.height };
  const rng = bb.subRng(op.seed);
  const over = toSet(op.over);
  const spacing = Math.max(1, op.spacing);
  const claimR = op.claim_radius ?? Math.ceil(spacing / 2);
  const claimFlag = CLAIM_BY_NAME[op.claim ?? 'site'];
  const margin = op.margin ?? 2;
  const prefix = op.id_prefix ?? 'site';

  const placed: Array<{ x: number; y: number }> = [];
  const maxTries = Math.max(40, op.count * 40);
  for (let t = 0; t < maxTries && placed.length < op.count; t++) {
    const x = region.x + Math.floor(rng() * region.w);
    const y = region.y + Math.floor(rng() * region.h);
    if (x < margin || y < margin || x >= bb.width - margin || y >= bb.height - margin) continue;
    if (over && !over.has(bb.tileAt(x, y)!)) continue;
    if (!bb.isFree(x, y)) continue;                          // respect prior claims
    if (placed.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < spacing * spacing)) continue;
    placed.push({ x, y });
    const id = `${prefix}_${placed.length}`;
    bb.addSite(id, { x, y }, { tags: op.tags ?? [] });
    bb.claimDisc(x, y, claimR, claimFlag);
    if (op.clear) {
      const r = op.clear.radius ?? Math.max(1, claimR - 1);
      paintCircle(bb.grid, x + 0.5, y + 0.5, r, op.clear.tile);
    }
  }
  if (placed.length < op.count) {
    console.warn(
      `[mapgen] scatter_sites '${prefix}': placed ${placed.length}/${op.count} ` +
      `(spacing ${spacing} too tight for the free area).`,
    );
  }
}

/**
 * Cost-aware routing. A* over the (resynced) cost layer from each source to the
 * target, carving `tile` along the path. Endpoints are forced enterable so a
 * route can reach a door beside walls; intermediate impassable cells are
 * avoided, so roads bend around forests and water. Building-claimed cells are
 * never carved through. `from_tag` fans out from every tagged feature (a star
 * network); routes carved earlier become cheap, so later ones merge onto them.
 */
function applyRoute(op: Extract<GenOp, { type: 'route' }>, bb: Blackboard): void {
  bb.syncCostFromGrid();
  const claimRoad = op.claim_road ?? true;
  const width = op.width ?? 1;
  const goal = resolvePoint(op.to, bb);

  const sources: Array<{ x: number; y: number }> = [];
  if (op.from_tag) {
    for (const f of bb.features.byTag(op.from_tag)) {
      const p = f.at ?? (f.rect ? { x: f.rect.x + (f.rect.w >> 1), y: f.rect.y + (f.rect.h >> 1) } : null);
      if (p) sources.push(p);
    }
  } else if (op.from) {
    sources.push(resolvePoint(op.from, bb));
  } else {
    console.warn('[mapgen] route: neither from nor from_tag set — nothing to route.');
    return;
  }

  for (const start of sources) {
    const path = aStar(bb, start, goal);
    if (!path) {
      console.warn(`[mapgen] route: no path from (${start.x},${start.y}) to (${goal.x},${goal.y}).`);
      continue;
    }
    carvePath(bb, path, op.tile, width, claimRoad);
  }
}

/** Stamp a road along `path` at the given width, skipping building cells. */
function carvePath(
  bb: Blackboard, path: Array<{ x: number; y: number }>, tile: string, width: number, claimRoad: boolean,
): void {
  const half = Math.max(0, Math.floor((width - 1) / 2));
  for (const { x, y } of path) {
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        const px = x + ox, py = y + oy;
        if (!bb.inBounds(px, py)) continue;
        if (!bb.isFree(px, py, CLAIM.BUILDING)) continue;  // don't punch through buildings
        bb.paint(px, py, tile);
        if (claimRoad) bb.claim(px, py, CLAIM.ROAD);
      }
    }
  }
}

/**
 * A* over the cost layer (4-connected). Entering a cell costs bb.cost[cell];
 * the goal is always enterable so routes can terminate at a door. Returns the
 * cell path start→goal, or null if unreachable.
 */
function aStar(
  bb: Blackboard, start: { x: number; y: number }, goal: { x: number; y: number },
): Array<{ x: number; y: number }> | null {
  const W = bb.width, H = bb.height, N = W * H;
  if (!bb.inBounds(start.x, start.y) || !bb.inBounds(goal.x, goal.y)) return null;
  const sk = start.y * W + start.x;
  const gk = goal.y * W + goal.x;
  const g = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const heap = new MinHeap();
  const heur = (k: number) => Math.abs((k % W) - goal.x) + Math.abs(((k / W) | 0) - goal.y);

  g[sk] = 0;
  heap.push(heur(sk), sk);
  const DIRS = [-W, W, -1, 1];
  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === gk) break;
    const cx = cur % W;
    const gc = g[cur]!;
    for (const d of DIRS) {
      if (d === -1 && cx === 0) continue;
      if (d === 1 && cx === W - 1) continue;
      const nk = cur + d;
      if (nk < 0 || nk >= N) continue;
      const enter = nk === gk ? 1 : bb.cost[nk]!;       // goal forced reachable
      if (!Number.isFinite(enter)) continue;            // wall/water/tree → skip
      const ng = gc + enter;
      if (ng < g[nk]!) { g[nk] = ng; came[nk] = cur; heap.push(ng + heur(nk), nk); }
    }
  }
  if (gk !== sk && came[gk] === -1) return null;

  const path: Array<{ x: number; y: number }> = [];
  let c = gk;
  while (c !== -1) {
    path.push({ x: c % W, y: (c / W) | 0 });
    if (c === sk) break;
    c = came[c]!;
  }
  return path.reverse();
}

/** Minimal binary min-heap over (priority, value) pairs. Deterministic. */
class MinHeap {
  private pri: number[] = [];
  private val: number[] = [];
  get size(): number { return this.val.length; }
  push(priority: number, value: number): void {
    this.pri.push(priority); this.val.push(value);
    let i = this.val.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.pri[p]! <= this.pri[i]!) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const n = this.val.length;
    const topV = this.val[0]!;
    const lastV = this.val.pop()!; const lastP = this.pri.pop()!;
    if (n > 1) {
      this.val[0] = lastV; this.pri[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < this.val.length && this.pri[l]! < this.pri[s]!) s = l;
        if (r < this.val.length && this.pri[r]! < this.pri[s]!) s = r;
        if (s === i) break;
        this.swap(i, s); i = s;
      }
    }
    return topV;
  }
  private swap(a: number, b: number): void {
    [this.pri[a], this.pri[b]] = [this.pri[b]!, this.pri[a]!];
    [this.val[a], this.val[b]] = [this.val[b]!, this.val[a]!];
  }
}

/**
 * Cellular-automata cavern op. Generates an organic, guaranteed-connected open
 * field within `bounds`, paints open cells as `floor` (and solid cells as `wall`
 * when set), and registers the open extent as a named region plus a 1×1
 * `<region>_anchor` region at an always-open cell for spawn_point/focal use.
 */
function applyCave(op: Extract<GenOp, { type: 'cave' }>, bb: Blackboard): void {
  const b = op.bounds ? resolveBoundsRef(op.bounds, bb) : { x: 0, y: 0, w: bb.width, h: bb.height };
  const open = generateCave(b.w, b.h, {
    seed: op.seed,
    fill: op.fill,
    iterations: op.iterations,
    minPocket: op.min_pocket,
    connect: op.connect,
    tunnelWidth: op.tunnel_width,
  });

  for (let y = 0; y < b.h; y++) {
    const orow = open[y];
    if (!orow) continue;
    for (let x = 0; x < b.w; x++) {
      if (orow[x]) bb.paint(b.x + x, b.y + y, op.floor);
      else if (op.wall !== undefined) bb.paint(b.x + x, b.y + y, op.wall);
    }
  }

  if (op.region) {
    const { aabb, anchor } = openExtent(open);
    if (aabb) {
      bb.addRegion(op.region, { x: b.x + aabb.x, y: b.y + aabb.y, w: aabb.w, h: aabb.h }, { tags: ['cave'] });
    }
    if (anchor) {
      bb.addRegion(`${op.region}_anchor`, { x: b.x + anchor.x, y: b.y + anchor.y, w: 1, h: 1 }, { tags: ['anchor'] });
    }
  }
}

/**
 * Voronoi region decomposition. Assigns every tile in `bounds` to the nearest
 * cell seed (multiplicatively weighted, so higher-weight cells claim more
 * territory), paints that cell's floor, and registers each cell as a named
 * region. Optionally paints a one-tile seam where two cells meet. Fully
 * deterministic — territory is a pure function of the seed coordinates.
 */
function applyVoronoi(op: Extract<GenOp, { type: 'voronoi' }>, bb: Blackboard): void {
  if (!op.cells || op.cells.length === 0) return;
  const width = bb.width, height = bb.height;
  const b = op.bounds ? resolveBoundsRef(op.bounds, bb) : { x: 0, y: 0, w: width, h: height };
  const over = op.over == null
    ? null
    : (Array.isArray(op.over) ? new Set(op.over) : new Set([op.over]));

  const seeds = op.cells.map((c) => {
    const pt = resolvePoint(c.at, bb);
    return { id: c.id, floor: c.floor, weight: c.weight && c.weight > 0 ? c.weight : 1, x: pt.x, y: pt.y };
  });

  // Per-tile nearest-cell assignment. Store the seed index for the optional
  // border pass; track each cell's AABB for region registration.
  const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
  const x1 = Math.min(width, b.x + b.w), y1 = Math.min(height, b.y + b.h);
  const assign: Int16Array = new Int16Array(width * height).fill(-1);
  const aabb = seeds.map(() => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }));

  for (let y = y0; y < y1; y++) {
    const row = bb.grid[y]!;
    for (let x = x0; x < x1; x++) {
      if (over && !over.has(row[x]!)) continue;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i]!;
        const dx = x - s.x, dy = y - s.y;
        // Multiplicatively weighted: divide squared distance by weight² so a
        // cell with weight 2 reaches ~2× as far as a unit cell.
        const d = (dx * dx + dy * dy) / (s.weight * s.weight);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) continue;
      assign[y * width + x] = best;
      row[x] = seeds[best]!.floor;
      const bbx = aabb[best]!;
      if (x < bbx.minX) bbx.minX = x; if (x > bbx.maxX) bbx.maxX = x;
      if (y < bbx.minY) bbx.minY = y; if (y > bbx.maxY) bbx.maxY = y;
    }
  }

  // Optional seam: a tile whose assigned cell differs from its east/south
  // neighbour becomes the border tile. One-sided check avoids double-thick seams.
  if (op.border) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const me = assign[y * width + x];
        if (me < 0) continue;
        const right = x + 1 < x1 ? assign[y * width + x + 1] : me;
        const down = y + 1 < y1 ? assign[(y + 1) * width + x] : me;
        if ((right >= 0 && right !== me) || (down >= 0 && down !== me)) {
          bb.grid[y]![x] = op.border.tile;
        }
      }
    }
  }

  // Register each cell as a named region (AABB of its assigned tiles). Cells
  // that claimed no tiles fall back to a 1×1 box at their seed.
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]!;
    const bbx = aabb[i]!;
    const rect = bbx.maxX >= bbx.minX
      ? { x: bbx.minX, y: bbx.minY, w: bbx.maxX - bbx.minX + 1, h: bbx.maxY - bbx.minY + 1 }
      : { x: clampToZone(s, width, height).x, y: clampToZone(s, width, height).y, w: 1, h: 1 };
    bb.addRegion(s.id, rect, { tags: ['voronoi'] });
  }
}

export function isBlocked(
  grid: Grid,
  x: number,
  y: number,
  blockingTiles: ReadonlySet<string> = BLOCKING,
): boolean {
  if (y < 0 || y >= grid.length) return true;
  if (x < 0 || x >= grid[0]!.length) return true;
  return blockingTiles.has(grid[y]![x]!);
}

export type { Grid, RegionBounds };
export { Blackboard };
