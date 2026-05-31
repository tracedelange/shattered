// Zone tile-grid generator. Pure placement logic — region geometry comes from
// data (world/region_types/*.yaml) rather than this file. Zones may declare
// their own width/height/default_tile and may use `void` tiles to carve out
// non-rectangular shapes.

const DEFAULT_GRID_W = 40;
const DEFAULT_GRID_H = 30;
const DEFAULT_FALLBACK_TILE = 'grass';

function fill(grid, tile) {
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[0].length; x++) grid[y][x] = tile;
  }
}

function paintRect(grid, x0, y0, w, h, tile) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (y < 0 || y >= grid.length || x < 0 || x >= grid[0].length) continue;
      grid[y][x] = tile;
    }
  }
}

function paintWalls(grid, x0, y0, w, h, doorSide) {
  for (let x = x0; x < x0 + w; x++) {
    grid[y0][x] = 'wall';
    grid[y0 + h - 1][x] = 'wall';
  }
  for (let y = y0; y < y0 + h; y++) {
    grid[y][x0] = 'wall';
    grid[y][x0 + w - 1] = 'wall';
  }
  if (doorSide === 'north')      grid[y0][x0 + Math.floor(w / 2)] = 'door';
  else if (doorSide === 'south') grid[y0 + h - 1][x0 + Math.floor(w / 2)] = 'door';
  else if (doorSide === 'west')  grid[y0 + Math.floor(h / 2)][x0] = 'door';
  else if (doorSide === 'east')  grid[y0 + Math.floor(h / 2)][x0 + w - 1] = 'door';
}

function placeRelative(parentBounds, side, w, h) {
  const cx = parentBounds.x + Math.floor(parentBounds.w / 2);
  const cy = parentBounds.y + Math.floor(parentBounds.h / 2);
  if (side === 'north') return { x: cx - Math.floor(w / 2), y: parentBounds.y - h - 1 };
  if (side === 'south') return { x: cx - Math.floor(w / 2), y: parentBounds.y + parentBounds.h + 1 };
  if (side === 'east')  return { x: parentBounds.x + parentBounds.w + 1, y: cy - Math.floor(h / 2) };
  if (side === 'west')  return { x: parentBounds.x - w - 1, y: cy - Math.floor(h / 2) };
  return { x: cx - Math.floor(w / 2), y: cy - Math.floor(h / 2) };
}

function oppositeSide(side) {
  return { north: 'south', south: 'north', east: 'west', west: 'east' }[side];
}

// Resolve a region's shape from its type + optional size override. Falls back
// to the `plaza` type, then to a minimal default, so unknown types degrade
// gracefully rather than crashing the zone build.
function resolveRegionShape(regionDef, regionTypes) {
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

export function generateZoneGrid(zoneDef, regionTypes = {}) {
  const width = zoneDef.width || DEFAULT_GRID_W;
  const height = zoneDef.height || DEFAULT_GRID_H;
  const defaultTile = zoneDef.default_tile || DEFAULT_FALLBACK_TILE;
  const grid = Array.from({ length: height }, () => new Array(width));
  fill(grid, defaultTile);

  const bounds = {};
  const regions = zoneDef.regions || [];

  // Pass 1: place center region(s). Center regions can still be walled —
  // they get a door on r.door_side (defaults to 'south' since there's no
  // parent to face).
  for (const r of regions) {
    if (!r.center) continue;
    const shape = resolveRegionShape(r, regionTypes);
    const x = Math.floor((width - shape.w) / 2);
    const y = Math.floor((height - shape.h) / 2);
    paintRect(grid, x, y, shape.w, shape.h, shape.floor);
    if (shape.walled) paintWalls(grid, x, y, shape.w, shape.h, r.door_side || 'south');
    bounds[r.id] = { x, y, w: shape.w, h: shape.h, type: r.type };
  }

  // Pass 2: place regions relative to already-placed parents. Iterate until
  // no progress so dependency chains resolve.
  let placedThisRound;
  const remaining = regions.filter(r => !r.center);
  do {
    placedThisRound = false;
    for (let i = remaining.length - 1; i >= 0; i--) {
      const r = remaining[i];
      const parent = bounds[r.connects_to];
      if (!parent) continue;
      const shape = resolveRegionShape(r, regionTypes);
      const pos = placeRelative(parent, r.side, shape.w, shape.h);
      paintRect(grid, pos.x, pos.y, shape.w, shape.h, shape.floor);
      if (shape.walled) paintWalls(grid, pos.x, pos.y, shape.w, shape.h, oppositeSide(r.side));
      bounds[r.id] = { x: pos.x, y: pos.y, w: shape.w, h: shape.h, type: r.type };
      remaining.splice(i, 1);
      placedThisRound = true;
    }
  } while (placedThisRound && remaining.length > 0);

  // Pass 3: portal tile markers. Each portal in the zone YAML may declare a
  // `tile` override (default 'portal'); painting it on top is purely visual —
  // teleport behavior is wired up by the loop checking world.portalAt().
  for (const p of zoneDef.portals || []) {
    if (!p?.at) continue;
    const px = p.at.x | 0;
    const py = p.at.y | 0;
    const t = p.tile === undefined ? 'portal' : p.tile;
    if (t === null) continue; // explicit `tile: null` skips painting
    if (px < 0 || px >= width || py < 0 || py >= height) continue;
    grid[py][px] = t;
  }

  return { grid, bounds, width, height };
}

// Tiles entities cannot walk onto. `void` is included so zones can carve out
// non-rectangular shapes by filling unwalkable regions with void.
const BLOCKING = new Set(['wall', 'water', 'void']);

export function isBlocked(grid, x, y) {
  if (y < 0 || y >= grid.length) return true;
  if (x < 0 || x >= grid[0].length) return true;
  return BLOCKING.has(grid[y][x]);
}
