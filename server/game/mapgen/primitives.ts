// Pure tile-painting primitives. Each writes deterministically given inputs.
// Out-of-bounds writes are silently clipped — callers don't need to bound-check.

export type Grid = string[][];

function inBounds(grid: Grid, x: number, y: number): boolean {
  return y >= 0 && y < grid.length && x >= 0 && x < grid[0]!.length;
}

export function fillGrid(grid: Grid, tile: string): void {
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]!;
    for (let x = 0; x < row.length; x++) row[x] = tile;
  }
}

export function paintRect(grid: Grid, x0: number, y0: number, w: number, h: number, tile: string): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (inBounds(grid, x, y)) grid[y]![x] = tile;
    }
  }
}

// Midpoint circle, filled.
export function paintCircle(grid: Grid, cx: number, cy: number, r: number, tile: string): void {
  paintEllipse(grid, cx, cy, r, r, tile);
}

export function paintEllipse(grid: Grid, cx: number, cy: number, rx: number, ry: number, tile: string): void {
  if (rx <= 0 || ry <= 0) return;
  const rx2 = rx * rx, ry2 = ry * ry;
  const x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx);
  const y0 = Math.floor(cy - ry), y1 = Math.ceil(cy + ry);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const ddx = (x + 0.5 - cx);
      const ddy = (y + 0.5 - cy);
      if ((ddx * ddx) / rx2 + (ddy * ddy) / ry2 <= 1) {
        if (inBounds(grid, x, y)) grid[y]![x] = tile;
      }
    }
  }
}

// Filled polygon via scanline. Points are [x, y] in grid coords; polygon is
// closed implicitly (last → first).
export function paintPolygon(grid: Grid, points: ReadonlyArray<readonly [number, number]>, tile: string): void {
  if (points.length < 3) return;
  let yMin = Infinity, yMax = -Infinity;
  for (const [, py] of points) { if (py < yMin) yMin = py; if (py > yMax) yMax = py; }
  yMin = Math.max(0, Math.floor(yMin));
  yMax = Math.min(grid.length - 1, Math.ceil(yMax));
  for (let y = yMin; y <= yMax; y++) {
    const intersections: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i]!;
      const [x1, y1] = points[(i + 1) % points.length]!;
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const t = (y - y0) / (y1 - y0);
        intersections.push(x0 + t * (x1 - x0));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const xa = Math.ceil(intersections[i]!);
      const xb = Math.floor(intersections[i + 1]!);
      for (let x = xa; x <= xb; x++) {
        if (inBounds(grid, x, y)) grid[y]![x] = tile;
      }
    }
  }
}

// Bresenham line with optional thickness. Width=1 is a single-cell trail.
export function paintLine(
  grid: Grid, x0: number, y0: number, x1: number, y1: number, tile: string, width = 1,
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  const half = Math.max(0, Math.floor((width - 1) / 2));
  const stamp = (cx: number, cy: number) => {
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        if (inBounds(grid, cx + ox, cy + oy)) grid[cy + oy]![cx + ox] = tile;
      }
    }
  };
  while (true) {
    stamp(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 <  dx) { err += dx; y += sy; }
  }
}

// Rectangle wall border with an optional door cut. `doorSide` picks the wall;
// the cut sits at the midpoint of that wall.
export function paintWalls(
  grid: Grid, x0: number, y0: number, w: number, h: number,
  wallTile: string, doorSide?: 'north' | 'south' | 'east' | 'west', doorTile = 'door',
): void {
  for (let x = x0; x < x0 + w; x++) {
    if (inBounds(grid, x, y0))         grid[y0]![x] = wallTile;
    if (inBounds(grid, x, y0 + h - 1)) grid[y0 + h - 1]![x] = wallTile;
  }
  for (let y = y0; y < y0 + h; y++) {
    if (inBounds(grid, x0, y))         grid[y]![x0] = wallTile;
    if (inBounds(grid, x0 + w - 1, y)) grid[y]![x0 + w - 1] = wallTile;
  }
  if (!doorSide) return;
  const mx = x0 + Math.floor(w / 2);
  const my = y0 + Math.floor(h / 2);
  if (doorSide === 'north' && inBounds(grid, mx, y0))         grid[y0]![mx]         = doorTile;
  if (doorSide === 'south' && inBounds(grid, mx, y0 + h - 1)) grid[y0 + h - 1]![mx] = doorTile;
  if (doorSide === 'west'  && inBounds(grid, x0, my))         grid[my]![x0]         = doorTile;
  if (doorSide === 'east'  && inBounds(grid, x0 + w - 1, my)) grid[my]![x0 + w - 1] = doorTile;
}
