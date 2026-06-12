// Pure-Node PNG renderer for a ZoneDef. Generates the zone grid via the same
// mapgen pipeline the server uses, then rasterizes tiles to colored squares.
// Region outlines and portal markers are overlaid to help an LLM correlate
// the visual output with the YAML it produced.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { generateZoneGrid, resolveLandmark } from '../../server/game/mapgen/index.ts';
import { mulberry32, hashString } from '../../server/game/mapgen/rng.ts';
import { BLOCKING_TILES } from '../../shared/constants.ts';
import { buildSpriteColorMap, buildTileColorMap, hexToRgb } from '../../shared/tileset.ts';
import type { MobTemplate, Prefab, Tileset, ZoneDef } from '../../shared/types.ts';

export interface RenderOptions {
  /** Pixels per tile. Default 14 — enough resolution for vision models. */
  tileSize?: number;
  /** Show 1-pixel outlines around named regions. Default true. */
  showRegions?: boolean;
  /** Show portal locations as cyan markers. Default true. */
  showPortals?: boolean;
  /** Show mob spawn placements as colored dots. Default true (requires `mobs`). */
  showSpawns?: boolean;
  /** Mob template lookup. Required to draw mob markers. */
  mobs?: Record<string, MobTemplate>;
  /** Overlay an orange X on walkable tiles unreachable from portal entry points. Default true. */
  showInaccessible?: boolean;
  /** Overlay the landmark (purple diamond) and focal point (gold ring). Default true. */
  showAnchors?: boolean;
  /** Named prefab registry, so post_ops referencing named prefabs render accurately. */
  prefabs?: Record<string, Prefab>;
}

export interface RegionLegendEntry {
  id: string;
  x: number;      // tile coords
  y: number;
  w: number;
  h: number;
}

export interface RenderResult {
  png: Buffer;
  width: number;     // pixel dimensions
  height: number;
  legend: {
    regions: RegionLegendEntry[];
    portals: { from: { x: number; y: number }; to: string }[];
    spawns: { entity: string; region: string; count: number }[];  // region is "@x,y" for exact placements
    inaccessibleTiles: number;
    /** Non-zero when a non-blocking default_tile is reachable from portals — dungeon carving bug. */
    accessibleDefaultTiles: number;
    accessibleDefaultTileName: string;
    /** Structural archetype declared on the zone, if any. */
    archetype: string | null;
    /** The zone's heart point, if declared. */
    landmark: { x: number; y: number } | null;
    /** The resolved narrative anchor (from focal_point/landmark/archetype). */
    focal: { x: number; y: number } | null;
  };
}

/**
 * PNG-free structural check: generate the grid and run the same walkability
 * analysis as renderZoneToPNG's pass 4, returning only the two issue counts.
 * Used by the programmatic seed-retry repair to score candidate seeds without
 * rasterizing anything.
 */
export function evaluateZoneStructure(
  zoneDef: ZoneDef,
  tileset: Tileset,
  prefabs?: Record<string, Prefab>,
): { inaccessibleTiles: number; accessibleDefaultTiles: number } {
  const blockingTiles = computeBlockingTiles(tileset);
  const zone = generateZoneGrid(zoneDef, blockingTiles, prefabs);
  const defaultTile = zoneDef.default_tile ?? 'grass';
  const connections = zoneDef.connections || {};
  const hasEdgeConnections = ['north', 'south', 'east', 'west'].some((d) => connections[d]);
  const portalSeeds = (zoneDef.portals || []).filter((p) => p?.at).map((p) => p.at);
  const edgeSeeds: { x: number; y: number }[] = [];
  for (const [dir, target] of Object.entries(connections)) {
    if (!target) continue;
    if (dir === 'west')  for (let y = 0; y < zone.height; y++) edgeSeeds.push({ x: 0, y });
    if (dir === 'east')  for (let y = 0; y < zone.height; y++) edgeSeeds.push({ x: zone.width - 1, y });
    if (dir === 'north') for (let x = 0; x < zone.width;  x++) edgeSeeds.push({ x, y: 0 });
    if (dir === 'south') for (let x = 0; x < zone.width;  x++) edgeSeeds.push({ x, y: zone.height - 1 });
  }
  const { inaccessible, accessibleDefaultTiles } = findInaccessibleTiles(
    zone.grid, [...portalSeeds, ...edgeSeeds], hasEdgeConnections ? null : defaultTile,
    blockingTiles,
  );
  return { inaccessibleTiles: inaccessible.size, accessibleDefaultTiles };
}

const FALLBACK_COLOR       = '#ff00ff'; // magenta — unmapped tile, screams visually
const REGION_OUTLINE       = [0xff, 0xff, 0xff, 0xff]; // white
const PORTAL_MARKER        = [0x7a, 0xff, 0xff, 0xff]; // cyan
const MOB_OUTLINE          = [0x10, 0x10, 0x10, 0xff]; // near-black, for contrast
const SPAWN_ID_RING        = [0xff, 0xff, 0xff, 0xff]; // white ring for unique spawns
const MOB_FALLBACK: [number, number, number] = [0xff, 0x00, 0xff]; // missing sprite → magenta
const INACCESSIBLE_MARKER  = [0xff, 0x66, 0x00, 0xff]; // orange X on disconnected walkable tiles
const LANDMARK_MARKER      = [0xb0, 0x6c, 0xff, 0xff]; // purple diamond — the zone's heart point
const FOCAL_MARKER         = [0xff, 0xd2, 0x3f, 0xff]; // gold ring — the narrative anchor

export function renderZoneToPNG(
  zoneDef: ZoneDef,
  tileset: Tileset,
  opts: RenderOptions = {},
): RenderResult {
  const tileSize        = opts.tileSize        ?? 14;
  const showRegions     = opts.showRegions     ?? true;
  const showPortals     = opts.showPortals     ?? true;
  const showInaccessible = opts.showInaccessible ?? true;

  // Extend the base blocking set with any tiles declared blocking in this tileset.
  const blockingTiles = computeBlockingTiles(tileset);

  const zone = generateZoneGrid(zoneDef, blockingTiles, opts.prefabs);
  const wPx = zone.width  * tileSize;
  const hPx = zone.height * tileSize;
  const png = new PNG({ width: wPx, height: hPx });

  // Pre-resolve tile + sprite colors once (shared with the client renderer).
  const tileHex   = buildTileColorMap(tileset);
  const spriteHex = buildSpriteColorMap(tileset);
  const tileRgb = new Map<string, [number, number, number]>();
  for (const [name, hex] of Object.entries(tileHex)) tileRgb.set(name, hexToRgb(hex));

  // --- Pass 1: paint tiles ------------------------------------------------
  for (let ty = 0; ty < zone.height; ty++) {
    const row = zone.grid[ty]!;
    for (let tx = 0; tx < zone.width; tx++) {
      const tile = row[tx]!;
      const [r, g, b] = tileRgb.get(tile) ?? hexToRgb(FALLBACK_COLOR);
      paintTile(png, tx * tileSize, ty * tileSize, tileSize, r, g, b);
    }
  }

  // --- Pass 2: region outlines -------------------------------------------
  if (showRegions) {
    for (const b of Object.values(zone.bounds)) {
      strokeRect(
        png,
        b.x * tileSize, b.y * tileSize,
        b.w * tileSize, b.h * tileSize,
        REGION_OUTLINE,
      );
    }
  }

  // --- Pass 3: spawn markers ---------------------------------------------
  const showSpawns = (opts.showSpawns ?? true) && !!opts.mobs;
  if (showSpawns) {
    for (let i = 0; i < (zoneDef.spawns || []).length; i++) {
      const spawn = zoneDef.spawns![i]!;
      // Exact-placement spawns (e.g. torches) carry `at` instead of a region;
      // treat them as a single marker on a 1×1 region at that tile.
      const region = spawn.at
        ? { x: spawn.at.x, y: spawn.at.y, w: 1, h: 1 }
        : zone.bounds[spawn.region!];
      if (!region) continue;
      const mob = opts.mobs![spawn.entity];
      const color = mob ? hexToRgb(spriteHex[mob.sprite] || FALLBACK_COLOR) : MOB_FALLBACK;
      const count = spawn.at ? 1 : (spawn.count ?? 1);
      const seedKey = `${zoneDef.id}:${spawn.entity}:${i}:${spawn.spawn_id || ''}`;
      placeMobMarkers(
        png, zone.grid, region, count,
        hashString(seedKey), color, tileSize,
        !!spawn.spawn_id,
        blockingTiles,
      );
    }
  }

  // --- Pass 4: inaccessible-tile markers -----------------------------------
  let inaccessibleCount = 0;
  let accessibleDefaultCount = 0;
  const defaultTile = (zoneDef as { default_tile?: string }).default_tile ?? 'grass';
  const connections = (zoneDef as { connections?: Record<string, unknown> }).connections || {};
  // Only track accessible-background for zones with no edge connections (dungeons/
  // interiors). Outdoor zones with connections intentionally have walkable background.
  const hasEdgeConnections = Object.values(connections).some(Boolean);
  if (showInaccessible) {
    const portalSeeds = (zoneDef.portals || []).filter(p => p?.at).map(p => p.at);
    // For zones with edge connections, seed the BFS from all walkable tiles along
    // each connected edge — that's where the player actually enters, not from portals.
    const edgeSeeds: { x: number; y: number }[] = [];
    for (const [dir, target] of Object.entries(connections)) {
      if (!target) continue;
      if (dir === 'west')  for (let y = 0; y < zone.height; y++) edgeSeeds.push({ x: 0, y });
      if (dir === 'east')  for (let y = 0; y < zone.height; y++) edgeSeeds.push({ x: zone.width - 1, y });
      if (dir === 'north') for (let x = 0; x < zone.width;  x++) edgeSeeds.push({ x, y: 0 });
      if (dir === 'south') for (let x = 0; x < zone.width;  x++) edgeSeeds.push({ x, y: zone.height - 1 });
    }
    const { inaccessible, accessibleDefaultTiles } = findInaccessibleTiles(
      zone.grid, [...portalSeeds, ...edgeSeeds], hasEdgeConnections ? null : defaultTile,
      blockingTiles,
    );
    inaccessibleCount = inaccessible.size;
    accessibleDefaultCount = accessibleDefaultTiles;
    for (const key of inaccessible) {
      const [xs, ys] = key.split(',');
      paintInaccessibleX(png, Number(xs), Number(ys), tileSize);
    }
  }

  // --- Pass 5: portal markers (drawn last so they sit on top of mobs) ----
  if (showPortals) {
    for (const p of zoneDef.portals || []) {
      if (!p?.at) continue;
      paintMarker(png, p.at.x * tileSize, p.at.y * tileSize, tileSize, PORTAL_MARKER);
    }
  }

  // --- Pass 6: structural anchors (landmark + focal point) ----------------
  const showAnchors = opts.showAnchors ?? true;
  const landmark = resolveLandmark(zoneDef.landmark, zone.bounds);
  if (showAnchors) {
    if (landmark) {
      const cx = landmark.x * tileSize + Math.floor(tileSize / 2);
      const cy = landmark.y * tileSize + Math.floor(tileSize / 2);
      paintDiamond(png, cx, cy, Math.max(3, Math.floor(tileSize / 2)), LANDMARK_MARKER);
    }
    if (zone.focal) {
      const cx = zone.focal.x * tileSize + Math.floor(tileSize / 2);
      const cy = zone.focal.y * tileSize + Math.floor(tileSize / 2);
      strokeDisc(png, cx, cy, Math.max(3, Math.floor(tileSize / 2)), FOCAL_MARKER);
      strokeDisc(png, cx, cy, Math.max(2, Math.floor(tileSize / 2) - 1), FOCAL_MARKER);
    }
  }

  const buf = PNG.sync.write(png);

  // --- Legend ------------------------------------------------------------
  const legend: RenderResult['legend'] = {
    regions: Object.entries(zone.bounds).map(([id, b]) => ({ id, ...b })),
    portals: (zoneDef.portals || []).map(p => ({ from: { x: p.at.x, y: p.at.y }, to: p.to.zone })),
    spawns: (zoneDef.spawns || []).map(s => ({
      entity: s.entity,
      region: s.at ? `@${s.at.x},${s.at.y}` : s.region!,
      count:  s.at ? 1 : (s.count ?? 1),
    })),
    inaccessibleTiles: inaccessibleCount,
    accessibleDefaultTiles: accessibleDefaultCount,
    accessibleDefaultTileName: defaultTile,
    archetype: (zoneDef as { archetype?: string }).archetype ?? null,
    landmark,
    focal: zone.focal,
  };

  return { png: buf, width: wPx, height: hPx, legend };
}

// ---------------------------------------------------------------------------
// Pathfinding helpers
// ---------------------------------------------------------------------------

/**
 * Builds a blocking-tile set for the given tileset: base BLOCKING_TILES plus
 * any tile entries with `blocking: true`. Used to make the render pipeline
 * consistent with the server's runtime blocking set.
 */
function computeBlockingTiles(tileset: Tileset): ReadonlySet<string> {
  const extra = new Set(BLOCKING_TILES);
  for (const [name, entry] of Object.entries(tileset.tiles)) {
    if ((entry as { blocking?: boolean }).blocking) extra.add(name);
  }
  return extra;
}

/**
 * BFS from seed positions over 4-connected non-blocking tiles. Returns:
 * - `inaccessible`: walkable tile coords the player CANNOT reach from portals.
 * - `accessibleDefaultTiles`: count of reachable tiles matching `defaultTile`
 *   when it is non-blocking. A high count indicates the dungeon-carving bug
 *   (background sea is traversable instead of the zone using default_tile: wall).
 *
 * Seeds are portal entry points; falls back to the first walkable tile when
 * no portals exist (e.g. interior zones with no player entry point defined).
 */
function findInaccessibleTiles(
  grid: string[][],
  seeds: Array<{ x: number; y: number }>,
  defaultTile: string | null,
  blockingTiles: ReadonlySet<string> = BLOCKING_TILES,
): { inaccessible: Set<string>; accessibleDefaultTiles: number } {
  const h = grid.length;

  const walkable = new Set<string>();
  for (let y = 0; y < h; y++) {
    const row = grid[y]!;
    for (let x = 0; x < row.length; x++) {
      if (!blockingTiles.has(row[x]!)) walkable.add(`${x},${y}`);
    }
  }
  if (walkable.size === 0) return { inaccessible: new Set(), accessibleDefaultTiles: 0 };

  const visited = new Set<string>();
  const queue: Array<{ x: number; y: number }> = [];

  const validSeeds = seeds.filter(s => walkable.has(`${s.x},${s.y}`));
  if (validSeeds.length > 0) {
    for (const s of validSeeds) {
      const key = `${s.x},${s.y}`;
      if (!visited.has(key)) { visited.add(key); queue.push(s); }
    }
  } else {
    // No portal seeds — start from the first walkable tile we can find.
    outer: for (let y = 0; y < h; y++) {
      const row = grid[y]!;
      for (let x = 0; x < row.length; x++) {
        if (!blockingTiles.has(row[x]!)) {
          visited.add(`${x},${y}`);
          queue.push({ x, y });
          break outer;
        }
      }
    }
  }

  const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]] as const;
  let i = 0;
  while (i < queue.length) {
    const { x, y } = queue[i++]!;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (!visited.has(key) && walkable.has(key)) {
        visited.add(key);
        queue.push({ x: nx, y: ny });
      }
    }
  }

  const inaccessible = new Set<string>();
  for (const key of walkable) {
    if (!visited.has(key)) inaccessible.add(key);
  }

  // Count reachable tiles that are still the default tile. When default_tile is
  // non-blocking, a high count means the background sea is accessible — the
  // dungeon carving bug. Skip for outdoor zones (defaultTile === null).
  let accessibleDefaultTiles = 0;
  if (defaultTile !== null && !blockingTiles.has(defaultTile)) {
    for (const key of visited) {
      const [xs, ys] = key.split(',');
      const tile = grid[Number(ys)]?.[Number(xs)];
      if (tile === defaultTile) accessibleDefaultTiles++;
    }
  }

  return { inaccessible, accessibleDefaultTiles };
}

// ---------------------------------------------------------------------------
// Internal pixel-painting helpers
// ---------------------------------------------------------------------------

function paintTile(png: PNG, x0: number, y0: number, size: number, r: number, g: number, b: number): void {
  for (let yy = 0; yy < size; yy++) {
    const py = y0 + yy;
    if (py < 0 || py >= png.height) continue;
    let idx = (png.width * py + x0) << 2;
    for (let xx = 0; xx < size; xx++) {
      const px = x0 + xx;
      if (px >= 0 && px < png.width) {
        png.data[idx]     = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = 0xff;
      }
      idx += 4;
    }
  }
}

function setPixel(png: PNG, x: number, y: number, rgba: number[]): void {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx]     = rgba[0]!;
  png.data[idx + 1] = rgba[1]!;
  png.data[idx + 2] = rgba[2]!;
  png.data[idx + 3] = rgba[3]!;
}

function strokeRect(png: PNG, x0: number, y0: number, w: number, h: number, rgba: number[]): void {
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  for (let x = x0; x <= x1; x++) {
    setPixel(png, x, y0, rgba);
    setPixel(png, x, y1, rgba);
  }
  for (let y = y0; y <= y1; y++) {
    setPixel(png, x0, y, rgba);
    setPixel(png, x1, y, rgba);
  }
}

function paintMarker(png: PNG, x0: number, y0: number, size: number, rgba: number[]): void {
  // Filled inner square, leaving a 2-pixel margin so the tile color still shows.
  const margin = Math.max(1, Math.floor(size / 4));
  for (let yy = margin; yy < size - margin; yy++) {
    for (let xx = margin; xx < size - margin; xx++) {
      setPixel(png, x0 + xx, y0 + yy, rgba);
    }
  }
}

function fillDisc(png: PNG, cx: number, cy: number, r: number, rgba: number[]): void {
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) setPixel(png, cx + dx, cy + dy, rgba);
    }
  }
}

/** Filled diamond (rotated square) centered at (cx, cy) with the given radius. */
function paintDiamond(png: PNG, cx: number, cy: number, r: number, rgba: number[]): void {
  for (let dy = -r; dy <= r; dy++) {
    const span = r - Math.abs(dy);
    for (let dx = -span; dx <= span; dx++) setPixel(png, cx + dx, cy + dy, rgba);
  }
}

function strokeDisc(png: PNG, cx: number, cy: number, r: number, rgba: number[]): void {
  const r2Outer = r * r;
  const r2Inner = (r - 1) * (r - 1);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2Outer && d2 >= r2Inner) setPixel(png, cx + dx, cy + dy, rgba);
    }
  }
}

function placeMobMarkers(
  png: PNG,
  grid: string[][],
  region: { x: number; y: number; w: number; h: number },
  count: number,
  seed: number,
  color: [number, number, number],
  tileSize: number,
  isUnique: boolean,
  blockingTiles: ReadonlySet<string> = BLOCKING_TILES,
): void {
  const rng = mulberry32(seed);
  const fillRgba = [color[0], color[1], color[2], 0xff];
  const innerR  = Math.max(2, Math.floor(tileSize / 3));
  const ringR   = innerR + 2;
  const maxAttempts = Math.max(count * 20, 40);
  let placed = 0;
  for (let i = 0; placed < count && i < maxAttempts; i++) {
    const tx = region.x + Math.floor(rng() * region.w);
    const ty = region.y + Math.floor(rng() * region.h);
    if (ty < 0 || ty >= grid.length) continue;
    const row = grid[ty]!;
    if (tx < 0 || tx >= row.length) continue;
    if (blockingTiles.has(row[tx]!)) continue; // skip walls/water/void
    const cx = tx * tileSize + Math.floor(tileSize / 2);
    const cy = ty * tileSize + Math.floor(tileSize / 2);
    if (isUnique) strokeDisc(png, cx, cy, ringR, SPAWN_ID_RING);
    strokeDisc(png, cx, cy, innerR + 1, MOB_OUTLINE);
    fillDisc(png, cx, cy, innerR, fillRgba);
    placed++;
  }
}

/** Paint a small orange diagonal-X over a tile to signal inaccessibility. */
function paintInaccessibleX(png: PNG, tx: number, ty: number, tileSize: number): void {
  const x0 = tx * tileSize;
  const y0 = ty * tileSize;
  const margin = Math.max(2, Math.floor(tileSize / 5));
  const x1 = x0 + tileSize - 1 - margin;
  const y1 = y0 + tileSize - 1 - margin;
  const steps = tileSize - 2 * margin;
  for (let s = 0; s < steps; s++) {
    const t = steps > 1 ? s / (steps - 1) : 0;
    setPixel(png, Math.round(x0 + margin + s),           Math.round(y0 + margin + s),           INACCESSIBLE_MARKER);
    setPixel(png, Math.round(x0 + margin + s) + 1,       Math.round(y0 + margin + s),           INACCESSIBLE_MARKER);
    setPixel(png, Math.round(x1 - s),                    Math.round(y0 + margin + s),           INACCESSIBLE_MARKER);
    setPixel(png, Math.round(x1 - s) + 1,                Math.round(y0 + margin + s),           INACCESSIBLE_MARKER);
    void t; // suppress unused-var
  }
}

// ---------------------------------------------------------------------------
// ASCII renderer
// ---------------------------------------------------------------------------

// Preferred single-char codes for common tiles. Chosen to be visually intuitive
// so the LLM can read and write the grid without memorising the legend.
const TILE_CHARS: Record<string, string> = {
  wall:                '#',
  void:                ' ',
  tree:                'T',
  water:               '~',
  grass:               '.',
  dirt:                ',',
  stone_floor:         's',
  wood_floor:          'w',
  cracked_stone_floor: ':',
  door:                'D',
  portal:              'P',
};

// Fallback pool assigned in order to any tiles not covered above.
// '!' is reserved as the inaccessible-tile marker and must not appear here.
const FALLBACK_POOL = 'abcdefghijklmnopqrtuvxyzABCEFGHIJKLMNOQRUVXYZ0123456789@$%^&*';

/**
 * Renders the zone grid as a labelled ASCII map. Each tile becomes one
 * character. Axis labels help the LLM write precise `at:` coordinates.
 *
 * Walkable tiles unreachable from portal/edge entry points are marked `!`
 * so the LLM can see exactly where disconnected pockets are.
 *
 * Returns the printable text, the char→tile legend, and the inaccessible count.
 */
export function renderZoneToAscii(
  zoneDef: ZoneDef,
  opts: { tileset?: Tileset; prefabs?: Record<string, Prefab> } = {},
): { text: string; legend: Record<string, string>; inaccessibleCount: number } {
  // Run connectivity BFS to find inaccessible walkable tiles.
  const blockingTiles = opts.tileset ? computeBlockingTiles(opts.tileset) : BLOCKING_TILES;
  const zone = generateZoneGrid(zoneDef, blockingTiles, opts.prefabs);
  const { width, height, grid } = zone;
  const connections = (zoneDef as { connections?: Record<string, unknown> }).connections || {};
  const hasEdgeConnections = Object.values(connections).some(Boolean);
  const defaultTile = (zoneDef as { default_tile?: string }).default_tile ?? 'grass';

  const portalSeeds = (zoneDef.portals || []).filter(p => p?.at).map(p => p.at);
  const edgeSeeds: { x: number; y: number }[] = [];
  for (const [dir, target] of Object.entries(connections)) {
    if (!target) continue;
    if (dir === 'west')  for (let y = 0; y < height; y++) edgeSeeds.push({ x: 0, y });
    if (dir === 'east')  for (let y = 0; y < height; y++) edgeSeeds.push({ x: width - 1, y });
    if (dir === 'north') for (let x = 0; x < width;  x++) edgeSeeds.push({ x, y: 0 });
    if (dir === 'south') for (let x = 0; x < width;  x++) edgeSeeds.push({ x, y: height - 1 });
  }
  const { inaccessible } = findInaccessibleTiles(
    grid, [...portalSeeds, ...edgeSeeds], hasEdgeConnections ? null : defaultTile,
    blockingTiles,
  );

  // Collect tiles that actually appear in this zone.
  const tilesPresent = new Set<string>();
  for (const row of grid) for (const t of row) tilesPresent.add(t);

  // Build tile→char, assigning well-known chars first then falling back.
  const tileToChar = new Map<string, string>();
  const usedChars = new Set<string>(['!']); // reserve '!' for inaccessible marker

  for (const tile of tilesPresent) {
    const ch = TILE_CHARS[tile];
    if (ch) { tileToChar.set(tile, ch); usedChars.add(ch); }
  }
  let poolIdx = 0;
  for (const tile of tilesPresent) {
    if (tileToChar.has(tile)) continue;
    while (poolIdx < FALLBACK_POOL.length && usedChars.has(FALLBACK_POOL[poolIdx]!)) poolIdx++;
    const ch = poolIdx < FALLBACK_POOL.length ? FALLBACK_POOL[poolIdx++]! : '?';
    tileToChar.set(tile, ch);
    usedChars.add(ch);
  }

  // Axis labels — two header rows: tens digit (at multiples of 10) + units digit.
  const rowNumW = String(height - 1).length;
  const indent  = ' '.repeat(rowNumW + 2);
  let tensRow  = indent;
  let unitsRow = indent;
  for (let x = 0; x < width; x++) {
    tensRow  += x % 10 === 0 ? String(Math.floor(x / 10) % 10) : ' ';
    unitsRow += String(x % 10);
  }

  const lines: string[] = [tensRow, unitsRow];
  for (let y = 0; y < height; y++) {
    let row = String(y).padStart(rowNumW) + '  ';
    for (let x = 0; x < width; x++) {
      row += inaccessible.has(`${x},${y}`) ? '!' : (tileToChar.get(grid[y]![x]!) ?? '?');
    }
    lines.push(row);
  }

  // Compact inline legend: char=tile_name pairs separated by spaces.
  const legendParts = [...tileToChar.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ch, tile]) => `${ch}=${tile}`);
  lines.push('');
  lines.push('Legend: ' + legendParts.join('  '));
  if (inaccessible.size > 0) {
    lines.push(`!=inaccessible_walkable_tile (${inaccessible.size} total — add ensure_reach to fix)`);
  }

  // Connectivity summary so it's impossible to miss.
  lines.push('');
  if (inaccessible.size > 0) {
    lines.push(`⚠ Connectivity: ${inaccessible.size} walkable tile(s) unreachable from entry points (marked !)`);
  } else {
    lines.push('✓ Connectivity: all walkable tiles reachable from entry points');
  }

  const legend: Record<string, string> = {};
  for (const [tile, ch] of tileToChar) legend[ch] = tile;

  return { text: lines.join('\n'), legend, inaccessibleCount: inaccessible.size };
}

// ---------------------------------------------------------------------------
// Legend formatter
// ---------------------------------------------------------------------------

/**
 * Convenience: render a zone and write the PNG to disk. Creates parent
 * directories as needed. Returns the RenderResult so callers can also format
 * a legend or inspect dimensions.
 */
export function renderZoneToFile(
  zoneDef: ZoneDef,
  tileset: Tileset,
  outPath: string,
  opts: RenderOptions = {},
): RenderResult {
  const result = renderZoneToPNG(zoneDef, tileset, opts);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, result.png);
  return result;
}

export function formatLegend(zoneId: string, result: RenderResult): string {
  const lines: string[] = [];
  lines.push(`Zone: ${zoneId}`);
  lines.push(`Image: ${result.width}x${result.height}px`);
  if (result.legend.archetype) lines.push(`Archetype: ${result.legend.archetype}`);
  if (result.legend.landmark) {
    lines.push(`Landmark (purple diamond): (${result.legend.landmark.x}, ${result.legend.landmark.y})`);
  }
  if (result.legend.focal) {
    lines.push(`Focal point (gold ring): (${result.legend.focal.x}, ${result.legend.focal.y})`);
  }
  lines.push('');
  if (result.legend.regions.length > 0) {
    lines.push('Regions (tile coords):');
    for (const r of result.legend.regions) {
      lines.push(`  ${r.id}  →  x:${r.x}..${r.x + r.w - 1}, y:${r.y}..${r.y + r.h - 1}  (${r.w}x${r.h})`);
    }
    lines.push('');
  }
  if (result.legend.spawns.length > 0) {
    lines.push('Spawns:');
    for (const s of result.legend.spawns) {
      lines.push(`  ${s.entity} × ${s.count}  in  ${s.region}`);
    }
    lines.push('');
  }
  if (result.legend.portals.length > 0) {
    lines.push('Portals:');
    for (const p of result.legend.portals) {
      lines.push(`  (${p.from.x}, ${p.from.y})  →  ${p.to}`);
    }
    lines.push('');
  }
  if (result.legend.inaccessibleTiles > 0) {
    lines.push(`⚠  Inaccessible walkable tiles: ${result.legend.inaccessibleTiles} (orange X markers on image)`);
  }
  if (result.legend.accessibleDefaultTiles > 0) {
    lines.push(
      `⚠  Accessible background tiles: ${result.legend.accessibleDefaultTiles} tiles of '${result.legend.accessibleDefaultTileName}' ` +
      `are reachable from portals. If this is a dungeon/indoor zone, ` +
      `change default_tile to 'wall' or 'void' so only carved regions are walkable.`,
    );
  }
  return lines.join('\n');
}
