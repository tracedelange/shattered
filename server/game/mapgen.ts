import type { Direction, RegionType, ZoneDef, ZoneRegion } from '../../shared/types.ts';

const DEFAULT_GRID_W = 40;
const DEFAULT_GRID_H = 30;
const DEFAULT_FALLBACK_TILE = 'grass';

type Grid = string[][];
export interface RegionBounds { x: number; y: number; w: number; h: number; type: string }

function fill(grid: Grid, tile: string): void {
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]!;
    for (let x = 0; x < row.length; x++) row[x] = tile;
  }
}

function paintRect(grid: Grid, x0: number, y0: number, w: number, h: number, tile: string): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (y < 0 || y >= grid.length || x < 0 || x >= grid[0]!.length) continue;
      grid[y]![x] = tile;
    }
  }
}

function paintWalls(grid: Grid, x0: number, y0: number, w: number, h: number, doorSide: Direction): void {
  for (let x = x0; x < x0 + w; x++) {
    grid[y0]![x] = 'wall';
    grid[y0 + h - 1]![x] = 'wall';
  }
  for (let y = y0; y < y0 + h; y++) {
    grid[y]![x0] = 'wall';
    grid[y]![x0 + w - 1] = 'wall';
  }
  if (doorSide === 'north')      grid[y0]![x0 + Math.floor(w / 2)] = 'door';
  else if (doorSide === 'south') grid[y0 + h - 1]![x0 + Math.floor(w / 2)] = 'door';
  else if (doorSide === 'west')  grid[y0 + Math.floor(h / 2)]![x0] = 'door';
  else if (doorSide === 'east')  grid[y0 + Math.floor(h / 2)]![x0 + w - 1] = 'door';
}

function placeRelative(parent: RegionBounds, side: Direction, w: number, h: number): { x: number; y: number } {
  const cx = parent.x + Math.floor(parent.w / 2);
  const cy = parent.y + Math.floor(parent.h / 2);
  if (side === 'north') return { x: cx - Math.floor(w / 2), y: parent.y - h - 1 };
  if (side === 'south') return { x: cx - Math.floor(w / 2), y: parent.y + parent.h + 1 };
  if (side === 'east')  return { x: parent.x + parent.w + 1, y: cy - Math.floor(h / 2) };
  return { x: parent.x - w - 1, y: cy - Math.floor(h / 2) };
}

function oppositeSide(side: Direction): Direction {
  return ({ north: 'south', south: 'north', east: 'west', west: 'east' } as const)[side];
}

interface ResolvedShape { w: number; h: number; floor: string; walled: boolean }

function resolveRegionShape(regionDef: ZoneRegion, regionTypes: Record<string, RegionType>): ResolvedShape {
  const def = regionTypes[regionDef.type] || regionTypes.plaza;
  if (!def) return { w: 6, h: 6, floor: DEFAULT_FALLBACK_TILE, walled: false };
  let mult = 1.0;
  const size = regionDef.size;
  if (size && def.size_multipliers && def.size_multipliers[size] != null) {
    mult = def.size_multipliers[size];
  }
  return {
    w: Math.max(2, Math.round((def.width  || 6) * mult)),
    h: Math.max(2, Math.round((def.height || 6) * mult)),
    floor: def.floor || DEFAULT_FALLBACK_TILE,
    walled: !!def.walled,
  };
}

export interface ZoneGrid {
  grid: Grid;
  bounds: Record<string, RegionBounds>;
  width: number;
  height: number;
}

export function generateZoneGrid(zoneDef: ZoneDef, regionTypes: Record<string, RegionType> = {}): ZoneGrid {
  const width = zoneDef.width || DEFAULT_GRID_W;
  const height = zoneDef.height || DEFAULT_GRID_H;
  const defaultTile = zoneDef.default_tile || DEFAULT_FALLBACK_TILE;
  const grid: Grid = Array.from({ length: height }, () => new Array(width).fill(defaultTile));
  fill(grid, defaultTile);

  const bounds: Record<string, RegionBounds> = {};
  const regions = zoneDef.regions || [];

  for (const r of regions) {
    if (!r.center) continue;
    const shape = resolveRegionShape(r, regionTypes);
    const x = Math.floor((width - shape.w) / 2);
    const y = Math.floor((height - shape.h) / 2);
    paintRect(grid, x, y, shape.w, shape.h, shape.floor);
    if (shape.walled) paintWalls(grid, x, y, shape.w, shape.h, r.door_side || 'south');
    bounds[r.id] = { x, y, w: shape.w, h: shape.h, type: r.type };
  }

  let placedThisRound: boolean;
  const remaining = regions.filter(r => !r.center);
  do {
    placedThisRound = false;
    for (let i = remaining.length - 1; i >= 0; i--) {
      const r = remaining[i]!;
      const parent = r.connects_to ? bounds[r.connects_to] : undefined;
      if (!parent) continue;
      const shape = resolveRegionShape(r, regionTypes);
      const side = r.side || 'south';
      const pos = placeRelative(parent, side, shape.w, shape.h);
      paintRect(grid, pos.x, pos.y, shape.w, shape.h, shape.floor);
      if (shape.walled) paintWalls(grid, pos.x, pos.y, shape.w, shape.h, oppositeSide(side));
      bounds[r.id] = { x: pos.x, y: pos.y, w: shape.w, h: shape.h, type: r.type };
      remaining.splice(i, 1);
      placedThisRound = true;
    }
  } while (placedThisRound && remaining.length > 0);

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

const BLOCKING = new Set(['wall', 'water', 'void']);

export function isBlocked(grid: Grid, x: number, y: number): boolean {
  if (y < 0 || y >= grid.length) return true;
  if (x < 0 || x >= grid[0]!.length) return true;
  return BLOCKING.has(grid[y]![x]!);
}
