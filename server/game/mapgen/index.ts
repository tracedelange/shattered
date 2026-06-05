// Op-driven zone generator. Walks the zone's ordered ops list, paints tiles
// via primitives, and tracks named region bounds for spawns/portals/roads.
// 100% deterministic: given the same ZoneDef, produces the same grid.

import {
  fillGrid, paintArc, paintCircle, paintEllipse, paintLine, paintPath,
  paintPolygon, paintRect, paintScatter, paintWalls, type Grid,
} from './primitives.ts';
import { resolveSeed, valueNoise } from './rng.ts';
import type {
  BoundsRef, GenOp, PointRef, PositionSpec, ShapeSpec, ZoneDef,
} from '../../../shared/types.ts';

const DEFAULT_GRID_W = 40;
const DEFAULT_GRID_H = 30;
const DEFAULT_FALLBACK_TILE = 'grass';
import { BLOCKING_TILES as BLOCKING } from '../../../shared/constants.ts';

export interface RegionBounds { x: number; y: number; w: number; h: number }

export interface ZoneGrid {
  grid: Grid;
  bounds: Record<string, RegionBounds>;
  width: number;
  height: number;
}

interface ResolvedShape {
  // Axis-aligned bounding box, post-positioning.
  bounds: RegionBounds;
  // Polygon point list relative to bounds (for paintPolygon).
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

function resolvePosition(
  size: { w: number; h: number },
  at: PositionSpec,
  bounds: Record<string, RegionBounds>,
  zoneW: number,
  zoneH: number,
): { x: number; y: number } {
  if ('center' in at) {
    return { x: Math.floor((zoneW - size.w) / 2), y: Math.floor((zoneH - size.h) / 2) };
  }
  if ('x' in at) {
    return { x: at.x, y: at.y };
  }
  const parent = bounds[at.relative_to];
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

function resolveShape(
  shape: ShapeSpec,
  at: PositionSpec,
  bounds: Record<string, RegionBounds>,
  zoneW: number,
  zoneH: number,
): ResolvedShape {
  const size = shapeAABBSize(shape);
  const pos = resolvePosition(size, at, bounds, zoneW, zoneH);
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
      // H3: warn when the caller supplied a meaningful at value so they know
      // it had no effect. (at: { x:0, y:0 } is the default fallback — skip it.)
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

function resolveBoundsRef(
  ref: BoundsRef,
  bounds: Record<string, RegionBounds>,
  width: number,
  height: number,
): RegionBounds {
  if ('all' in ref) return { x: 0, y: 0, w: width, h: height };
  if ('rect' in ref) return ref.rect;
  const r = bounds[ref.region];
  if (!r) throw new Error(`bounds ref: region '${ref.region}' not defined`);
  return r;
}

function resolvePoint(
  ref: PointRef,
  bounds: Record<string, RegionBounds>,
  width: number,
  height: number,
): { x: number; y: number } {
  if ('x' in ref) return { x: ref.x, y: ref.y };
  if ('edge' in ref) {
    const t = Math.min(1, Math.max(0, ref.t ?? 0.5));
    switch (ref.edge) {
      case 'north': return { x: Math.round(t * (width  - 1)), y: 0 };
      case 'south': return { x: Math.round(t * (width  - 1)), y: height - 1 };
      case 'west':  return { x: 0,             y: Math.round(t * (height - 1)) };
      case 'east':  return { x: width - 1,     y: Math.round(t * (height - 1)) };
    }
  }
  const r = bounds[ref.region];
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
  const grid: Grid = Array.from({ length: height }, () => new Array<string>(width).fill(defaultTile));
  fillGrid(grid, defaultTile);

  const bounds: Record<string, RegionBounds> = {};
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

  for (const op of ops) applyOp(op, grid, bounds, width, height);

  // Paint portal markers last so they sit on top of any underlying terrain.
  for (const p of zoneDef.portals || []) {
    if (!p?.at) continue;
    const px = p.at.x | 0;
    const py = p.at.y | 0;
    const t = p.tile === undefined ? 'portal' : p.tile;
    if (t === null) continue;
    if (px < 0 || px >= width || py < 0 || py >= height) continue;
    grid[py]![px] = t;
  }

  return { grid, bounds, width, height };
}

function applyOp(
  op: GenOp,
  grid: Grid,
  bounds: Record<string, RegionBounds>,
  width: number,
  height: number,
): void {
  switch (op.type) {
    case 'fill': {
      const b = op.bounds ? resolveBoundsRef(op.bounds, bounds, width, height) : { x: 0, y: 0, w: width, h: height };
      paintRect(grid, b.x, b.y, b.w, b.h, op.tile);
      return;
    }
    case 'region': {
      const r = resolveShape(op.shape, op.at, bounds, width, height);
      if (op.floor) r.paint(grid, op.floor);
      if (op.walls) {
        // Walls only meaningful for rectangular regions; circles/polygons skip.
        if (op.shape.kind === 'rect') {
          paintWalls(grid, r.bounds.x, r.bounds.y, r.bounds.w, r.bounds.h, op.walls.tile, op.walls.door?.side, op.walls.door?.tile);
        } else {
          // H2: warn so the LLM/author knows the walls field was silently discarded.
          console.warn(
            `[mapgen] region '${op.id}': walls is only supported for rect shapes. ` +
            `Shape '${op.shape.kind}' — walls field ignored. ` +
            `Use separate shape ops to paint wall tiles manually for non-rect regions.`,
          );
        }
      }
      bounds[op.id] = r.bounds;
      return;
    }
    case 'shape': {
      const r = resolveShape(op.shape, op.at, bounds, width, height);
      r.paint(grid, op.tile);
      return;
    }
    case 'road': {
      const a = resolvePoint(op.from, bounds, width, height);
      const b = resolvePoint(op.to,   bounds, width, height);
      paintLine(grid, a.x, a.y, b.x, b.y, op.tile, op.width ?? 1);
      return;
    }
    case 'path': {
      const pts: [number, number][] = op.points.map(p => {
        const r = resolvePoint(p, bounds, width, height);
        return [r.x, r.y];
      });
      const seed = op.seed != null ? resolveSeed(op.seed) : 0;
      paintPath(grid, pts, op.tile, op.width ?? 1, op.jitter ?? 0, seed);
      return;
    }
    case 'arc': {
      const a = resolvePoint(op.from, bounds, width, height);
      const b = resolvePoint(op.to,   bounds, width, height);
      paintArc(grid, a.x, a.y, b.x, b.y, op.bulge, op.tile, op.width ?? 1);
      return;
    }
    case 'scatter': {
      const b = resolveBoundsRef(op.bounds, bounds, width, height);
      const seed = resolveSeed(op.seed);
      const over = op.over == null
        ? undefined
        : (Array.isArray(op.over) ? new Set(op.over) : new Set([op.over]));
      paintScatter(grid, b.x, b.y, b.w, b.h, op.tile, op.count, seed, over);
      return;
    }
    case 'noise_patch': {
      const b = resolveBoundsRef(op.bounds, bounds, width, height);
      const seed = resolveSeed(op.seed);
      const over = op.over == null
        ? null
        : (Array.isArray(op.over) ? new Set(op.over) : new Set([op.over]));
      for (let y = b.y; y < b.y + b.h; y++) {
        if (y < 0 || y >= grid.length) continue;
        const row = grid[y]!;
        for (let x = b.x; x < b.x + b.w; x++) {
          if (x < 0 || x >= row.length) continue;
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
          paintRect(grid, ox + col * scale, oy + row * scale, scale, scale, tile);
        }
      }
      return;
    }
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

export type { Grid };
