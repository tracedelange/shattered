// Pass 2 of the staged pipeline: parameterized ops applied to a Pass-1 base room.
// The LLM SELECTS ops (intent); the engine APPLIES them deterministically and
// enforces invariants — Gardener/Implementer split applied to layout. The
// load-bearing guarantee: any op that would split the floor into >1 region is
// reverted, so structure can't break no matter what the model asks.
//
// Ops address cells SEMANTICALLY ('center', 'ne', …); the engine resolves the
// concrete cell, so the model never does coordinate geometry (its weak spot).
//
// The op set deliberately spans LAYOUT, not just decoration — colonnade, dais,
// inner_chamber, partition, alcoves, pit — so a vault diverges from an arena
// from a shrine instead of every room being "box + center anchor + lattice".

import type { Role } from './shapes.ts';

export type Side = 'north' | 'south' | 'east' | 'west';
export type Position = 'center' | 'north' | 'south' | 'east' | 'west' | 'ne' | 'nw' | 'se' | 'sw';
export type Axis = 'horizontal' | 'vertical';
export type PillarPattern = 'lattice' | 'rows' | 'perimeter' | 'cluster' | 'paired';

export type PrefabOp =
  | { op: 'punch_door'; side: Side }
  | { op: 'place_portal'; at: Position; tag?: 'descend' | 'ascend' }
  | { op: 'place_anchor'; at: Position; tag: string }
  | { op: 'place_prop'; tile: string; at: Position }
  | { op: 'add_pillars'; count: number; pattern?: PillarPattern }
  | { op: 'colonnade'; axis?: Axis }
  | { op: 'inner_chamber'; at?: Position; size?: number }
  | { op: 'dais' }
  | { op: 'partition'; axis?: Axis }
  | { op: 'perimeter_alcoves'; count?: number }
  | { op: 'pit'; size?: number }
  | { op: 'erode_walls'; amount: number };

export interface RoomTiles {
  floor: string;
  wall: string;
  door: string;
  portal: string;
  loot?: string;
}

export interface ApplyResult {
  data: string;
  legend: Record<string, string>;
  anchors: Record<string, string>;
  applied: string[];
  skipped: string[];
}

interface AnchorCell { tag: string; tile: string }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (x: number, y: number) => `${x},${y}`;

/** Count connected floor regions (4-connectivity) — the connectivity invariant. */
function floorRegions(role: Role[][]): number {
  const h = role.length;
  const w = h ? role[0]!.length : 0;
  const seen = Array.from({ length: h }, () => new Array<boolean>(w).fill(false));
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (role[y]![x] !== 'floor' || seen[y]![x]) continue;
      n++;
      const st = [[x, y]];
      seen[y]![x] = true;
      while (st.length) {
        const [cx, cy] = st.pop()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && role[ny]![nx] === 'floor' && !seen[ny]![nx]) {
            seen[ny]![nx] = true;
            st.push([nx, ny]);
          }
        }
      }
    }
  }
  return n;
}

function allFloor(role: Role[][]): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < role.length; y++) for (let x = 0; x < role[0]!.length; x++) if (role[y]![x] === 'floor') out.push({ x, y });
  return out;
}

function centroidFloor(role: Role[][]): { x: number; y: number } {
  const f = allFloor(role);
  if (!f.length) return { x: Math.floor(role[0]!.length / 2), y: Math.floor(role.length / 2) };
  const sx = f.reduce((s, c) => s + c.x, 0) / f.length;
  const sy = f.reduce((s, c) => s + c.y, 0) / f.length;
  return f.reduce((best, c) => (Math.hypot(c.x - sx, c.y - sy) < Math.hypot(best.x - sx, best.y - sy) ? c : best));
}

/** Resolve a semantic position to a concrete floor cell (nearest free one). */
function resolveFloorCell(role: Role[][], pos: Position, taken: Set<string>): { x: number; y: number } | null {
  const floor = allFloor(role).filter((c) => !taken.has(key(c.x, c.y)));
  if (!floor.length) return null;
  const w = role[0]!.length;
  const h = role.length;
  const score = (c: { x: number; y: number }): number => {
    switch (pos) {
      case 'center': return Math.hypot(c.x - (w - 1) / 2, c.y - (h - 1) / 2);
      case 'north': return c.y * 100 + Math.abs(c.x - (w - 1) / 2);
      case 'south': return (h - 1 - c.y) * 100 + Math.abs(c.x - (w - 1) / 2);
      case 'west': return c.x * 100 + Math.abs(c.y - (h - 1) / 2);
      case 'east': return (w - 1 - c.x) * 100 + Math.abs(c.y - (h - 1) / 2);
      case 'ne': return c.y + (w - 1 - c.x);
      case 'nw': return c.y + c.x;
      case 'se': return (h - 1 - c.y) + (w - 1 - c.x);
      case 'sw': return (h - 1 - c.y) + c.x;
    }
  };
  return floor.reduce((best, c) => (score(c) < score(best) ? c : best));
}

export interface ApplyOpts {
  seed?: number;
  /** Anchor tags the result MUST contain; any missing after ops are auto-placed. */
  requireAnchors?: string[];
  /** Tile names that block movement — a blocking prop occupies its cell. */
  blocking?: Set<string>;
  /** Tile names that exist in the tileset — place_prop tiles must be in here. */
  validTiles?: Set<string>;
}

export function applyOps(base: Role[][], ops: PrefabOp[], tiles: RoomTiles, opts: ApplyOpts = {}): ApplyResult {
  const role: Role[][] = base.map((r) => [...r]);
  const h = role.length;
  const w = h ? role[0]!.length : 0;
  const doors = new Set<string>();
  const anchors = new Map<string, AnchorCell>();
  const props = new Map<string, string>(); // cell key → prop tile
  const applied: string[] = [];
  const skipped: string[] = [];
  const rnd = mulberry32((opts.seed ?? 1) >>> 0);

  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  const setWallIfFloor = (x: number, y: number) => { if (inBounds(x, y) && role[y]![x] === 'floor' && !anchors.has(key(x, y))) role[y]![x] = 'wall'; };
  const anchorTile = (tag: string): string => (tag === 'loot' && tiles.loot ? tiles.loot : tiles.floor);

  // Revert any structural op that breaks connectivity → a bad op is a no-op,
  // never a broken room.
  const guarded = (label: string, fn: () => void): void => {
    const snap = role.map((r) => [...r]);
    fn();
    if (floorRegions(role) === 1) applied.push(label);
    else { for (let y = 0; y < h; y++) role[y] = snap[y]!; skipped.push(`${label} (would disconnect)`); }
  };

  const placeAnchorNear = (pos: Position, tag: string, tile: string): boolean => {
    const cell = resolveFloorCell(role, pos, new Set([...anchors.keys(), ...props.keys()]));
    if (!cell) return false;
    anchors.set(key(cell.x, cell.y), { tag, tile });
    return true;
  };

  const shuffle = <T>(arr: T[]): T[] => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j]!, arr[i]!]; } return arr; };

  for (const op of ops) {
    switch (op.op) {
      case 'punch_door': {
        let pick: { x: number; y: number } | null = null;
        let bestScore = Infinity;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (role[y]![x] !== 'wall') continue;
            const bordersFloor = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => role[y + dy]?.[x + dx] === 'floor');
            if (!bordersFloor) continue;
            const s = op.side === 'north' ? y : op.side === 'south' ? h - 1 - y : op.side === 'west' ? x : w - 1 - x;
            if (s < bestScore) { bestScore = s; pick = { x, y }; }
          }
        }
        if (pick) { role[pick.y]![pick.x] = 'floor'; doors.add(key(pick.x, pick.y)); applied.push(`punch_door ${op.side}`); }
        else skipped.push(`punch_door ${op.side} (no boundary wall)`);
        break;
      }
      case 'place_portal': {
        const ok = placeAnchorNear(op.at, op.tag ?? 'descend', tiles.portal);
        (ok ? applied : skipped).push(`place_portal ${op.at} (${op.tag ?? 'descend'})`);
        break;
      }
      case 'place_anchor': {
        const ok = placeAnchorNear(op.at, op.tag, anchorTile(op.tag));
        (ok ? applied : skipped).push(`place_anchor ${op.at} (${op.tag})`);
        break;
      }
      case 'place_prop': {
        if (opts.validTiles && !opts.validTiles.has(op.tile)) { skipped.push(`place_prop ${op.tile} (not in tileset)`); break; }
        const taken = new Set([...anchors.keys(), ...props.keys()]);
        const cell = resolveFloorCell(role, op.at, taken);
        if (!cell) { skipped.push(`place_prop ${op.tile} (no cell)`); break; }
        const blocks = (opts.blocking ?? new Set()).has(op.tile);
        if (blocks) {
          // A blocking prop occupies its cell as an obstacle → guard connectivity.
          const k = key(cell.x, cell.y);
          role[cell.y]![cell.x] = 'wall';
          if (floorRegions(role) === 1) { props.set(k, op.tile); applied.push(`place_prop ${op.tile} ${op.at}`); }
          else { role[cell.y]![cell.x] = 'floor'; skipped.push(`place_prop ${op.tile} (would block the room)`); }
        } else {
          props.set(key(cell.x, cell.y), op.tile); // walkable decoration
          applied.push(`place_prop ${op.tile} ${op.at}`);
        }
        break;
      }
      case 'add_pillars': {
        const cands = pillarCandidates(role, op.pattern ?? 'lattice', centroidFloor(role));
        if (op.pattern !== 'rows' && op.pattern !== 'perimeter') shuffle(cands);
        let placed = 0;
        for (const c of cands) {
          if (placed >= op.count) break;
          if (role[c.y]![c.x] !== 'floor' || anchors.has(key(c.x, c.y))) continue;
          role[c.y]![c.x] = 'wall';
          if (floorRegions(role) === 1) placed++;
          else { role[c.y]![c.x] = 'floor'; }
        }
        applied.push(`add_pillars ${placed}/${op.count} (${op.pattern ?? 'lattice'})`);
        break;
      }
      case 'colonnade': {
        const axis = op.axis ?? (w >= h ? 'horizontal' : 'vertical');
        const c = centroidFloor(role);
        guarded(`colonnade ${axis}`, () => {
          if (axis === 'horizontal') {
            for (let x = 2; x < w - 2; x += 2) { setWallIfFloor(x, c.y - 1); setWallIfFloor(x, c.y + 1); }
          } else {
            for (let y = 2; y < h - 2; y += 2) { setWallIfFloor(c.x - 1, y); setWallIfFloor(c.x + 1, y); }
          }
        });
        break;
      }
      case 'inner_chamber': {
        const c = op.at ? (resolveFloorCell(role, op.at, new Set()) ?? centroidFloor(role)) : centroidFloor(role);
        const half = Math.max(1, op.size ?? Math.floor(Math.min(w, h) / 4));
        guarded('inner_chamber', () => buildRing(role, c.x, c.y, half, half, setWallIfFloor, w, h, 'south'));
        break;
      }
      case 'dais': {
        const c = centroidFloor(role);
        guarded('dais', () => { for (const [dx, dy] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) setWallIfFloor(c.x + dx, c.y + dy); });
        break;
      }
      case 'partition': {
        const axis = op.axis ?? (w >= h ? 'vertical' : 'horizontal');
        const c = centroidFloor(role);
        guarded(`partition ${axis}`, () => {
          if (axis === 'horizontal') { for (let x = 1; x < w - 1; x++) if (Math.abs(x - c.x) > 0) setWallIfFloor(x, c.y); }
          else { for (let y = 1; y < h - 1; y++) if (Math.abs(y - c.y) > 0) setWallIfFloor(c.x, y); }
        });
        break;
      }
      case 'perimeter_alcoves': {
        const n = op.count ?? 4;
        guarded(`perimeter_alcoves ${n}`, () => {
          // Inward wall stubs at intervals along each wall → recesses between them.
          let placed = 0;
          for (let x = 3; x < w - 3 && placed < n; x += 3) { setWallIfFloor(x, 1); setWallIfFloor(x, h - 2); placed++; }
          for (let y = 3; y < h - 3 && placed < n * 2; y += 3) { setWallIfFloor(1, y); setWallIfFloor(w - 2, y); }
        });
        break;
      }
      case 'pit': {
        const c = centroidFloor(role);
        const half = Math.max(1, op.size ?? 1);
        guarded('pit', () => {
          for (let dy = -half; dy <= half; dy++) {
            if (dy === 0) continue; // keep a 1-wide floor bridge across
            for (let dx = -half; dx <= half; dx++) {
              const x = c.x + dx;
              const y = c.y + dy;
              if (inBounds(x, y) && role[y]![x] === 'floor' && !anchors.has(key(x, y))) role[y]![x] = 'void';
            }
          }
        });
        break;
      }
      case 'erode_walls': {
        const cands: Array<{ x: number; y: number }> = [];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (role[y]![x] === 'wall' && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => role[y + dy]?.[x + dx] === 'floor')) cands.push({ x, y });
        }
        shuffle(cands);
        let n = 0;
        for (const c of cands) { if (n >= op.amount) break; role[c.y]![c.x] = 'floor'; n++; }
        applied.push(`erode_walls ${n}/${op.amount}`);
        break;
      }
    }
  }

  // Guarantee required anchors exist (auto-place any the model forgot).
  const haveTags = new Set([...anchors.values()].map((a) => a.tag));
  for (const tag of opts.requireAnchors ?? []) {
    if (haveTags.has(tag)) continue;
    const tile = tag === 'descend' || tag === 'ascend' ? tiles.portal : anchorTile(tag);
    if (placeAnchorNear('center', tag, tile)) { haveTags.add(tag); applied.push(`auto place_anchor center (${tag})`); }
  }

  return { ...serialize(role, doors, anchors, props, tiles), applied, skipped };
}

/** Build a rectangular wall ring with one door gap (for inner_chamber). */
function buildRing(
  role: Role[][], cx: number, cy: number, halfW: number, halfH: number,
  setWallIfFloor: (x: number, y: number) => void, w: number, h: number, gap: Side,
): void {
  const x0 = Math.max(1, cx - halfW);
  const x1 = Math.min(w - 2, cx + halfW);
  const y0 = Math.max(1, cy - halfH);
  const y1 = Math.min(h - 2, cy + halfH);
  for (let x = x0; x <= x1; x++) { setWallIfFloor(x, y0); setWallIfFloor(x, y1); }
  for (let y = y0; y <= y1; y++) { setWallIfFloor(x0, y); setWallIfFloor(x1, y); }
  // Carve a 1-cell door gap so inside stays reachable.
  const gx = Math.floor((x0 + x1) / 2);
  const gy = Math.floor((y0 + y1) / 2);
  if (gap === 'south' && role[y1]?.[gx]) role[y1]![gx] = 'floor';
  else if (gap === 'north' && role[y0]?.[gx]) role[y0]![gx] = 'floor';
  else if (gap === 'east' && role[gy]?.[x1]) role[gy]![x1] = 'floor';
  else if (role[gy]?.[x0]) role[gy]![x0] = 'floor';
}

/** Candidate cells for a pillar pattern. */
function pillarCandidates(role: Role[][], pattern: PillarPattern, c: { x: number; y: number }): Array<{ x: number; y: number }> {
  const h = role.length;
  const w = h ? role[0]!.length : 0;
  const out: Array<{ x: number; y: number }> = [];
  const floor = (x: number, y: number) => role[y]?.[x] === 'floor';
  const nearWall = (x: number, y: number) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => role[y + dy]?.[x + dx] === 'wall');
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      if (!floor(x, y)) continue;
      let ok = false;
      switch (pattern) {
        case 'lattice': ok = x % 2 === 0 && y % 2 === 0; break;
        case 'rows': ok = y % 3 === 0 && x % 2 === 0; break;
        case 'perimeter': ok = nearWall(x, y); break;
        case 'cluster': ok = Math.abs(x - c.x) <= 2 && Math.abs(y - c.y) <= 2 && (x + y) % 2 === 0; break;
        case 'paired': ok = (x === c.x - 2 || x === c.x + 2) && y % 2 === 0; break;
      }
      if (ok) out.push({ x, y });
    }
  }
  return out;
}

const POOL = 'PLBNEQRSTUVWXYZabefghijkmnoqrstuvwxyz';

function serialize(
  role: Role[][],
  doors: Set<string>,
  anchors: Map<string, AnchorCell>,
  props: Map<string, string>,
  tiles: RoomTiles,
): { data: string; legend: Record<string, string>; anchors: Record<string, string> } {
  const legend: Record<string, string> = {};
  const anchorOut: Record<string, string> = {};
  let used = false;
  let usedWall = false;
  let usedDoor = false;
  let poolIdx = 0;
  const cellChar = new Map<string, string>();

  for (const [k, a] of anchors) {
    const ch = POOL[poolIdx++] ?? '?';
    cellChar.set(k, ch);
    legend[ch] = a.tile;
    anchorOut[ch] = a.tag;
  }

  // Props share one char per distinct tile (no gameplay tag).
  const propChar = new Map<string, string>();
  for (const [k, tile] of props) {
    if (!propChar.has(tile)) { const ch = POOL[poolIdx++] ?? '?'; propChar.set(tile, ch); legend[ch] = tile; }
    cellChar.set(k, propChar.get(tile)!);
  }

  const rows: string[] = [];
  for (let y = 0; y < role.length; y++) {
    let row = '';
    for (let x = 0; x < role[0]!.length; x++) {
      const k = key(x, y);
      if (cellChar.has(k)) { row += cellChar.get(k); continue; }
      if (doors.has(k)) { row += 'D'; usedDoor = true; continue; }
      if (role[y]![x] === 'floor') { row += '.'; used = true; }
      else if (role[y]![x] === 'wall') { row += '#'; usedWall = true; }
      else row += ' ';
    }
    rows.push(row);
  }
  if (used) legend['.'] = tiles.floor;
  if (usedWall) legend['#'] = tiles.wall;
  if (usedDoor) legend['D'] = tiles.door;
  return { data: rows.join('\n'), legend, anchors: anchorOut };
}

// Theme → material palette. The first entry whose regex matches the theme AND
// whose tiles exist in the tileset wins; otherwise stone. This is what turns
// "every room is a stone box" into wooden groves, sand halls, barred cells, etc.
const PALETTES: Array<{ re: RegExp; floor: string; wall: string }> = [
  { re: /tree|grove|wood|forest|root|bark|sap|hollow log/, floor: 'wood_floor', wall: 'tree' },
  { re: /sand|desert|dune|oasis|sun-?baked|arid/, floor: 'sand', wall: 'pale_wall' },
  { re: /coast|drift|wreck|tidal|shore|fish|silt|wharf/, floor: 'driftwood', wall: 'wall' },
  { re: /prison|cell|jail|gaol|penitent|cage/, floor: 'stone_floor', wall: 'cell_bars' },
  { re: /cairn|prehistor|barrow|menhir|standing stone|ancient wild/, floor: 'dirt', wall: 'cairn_stone' },
  { re: /ruin|crumbl|derelict|broken|abandon|decay|fallen/, floor: 'cracked_stone_floor', wall: 'cracked_wall' },
  { re: /ice|snow|frost|pale|bone|ivory|ghost/, floor: 'stone_floor', wall: 'pale_wall' },
  { re: /grass|meadow|glade|wild|verdant|overgrow|jungle/, floor: 'grass', wall: 'tree' },
];

/** Pick floor/wall/door/portal tiles for a tileset, themed by the brief. */
export function roleTilesFor(tileNames: string[], theme = ''): RoomTiles {
  const has = (t: string) => tileNames.includes(t);
  const firstWalkable = tileNames.find((t) => !/wall|void|water/.test(t)) ?? tileNames[0] ?? 'stone_floor';
  const firstWall = tileNames.find((t) => t.endsWith('wall')) ?? 'wall';
  let floor = has('stone_floor') ? 'stone_floor' : firstWalkable;
  let wall = has('wall') ? 'wall' : firstWall;
  const t = theme.toLowerCase();
  for (const p of PALETTES) {
    if (p.re.test(t) && has(p.floor) && has(p.wall)) { floor = p.floor; wall = p.wall; break; }
  }
  return {
    floor,
    wall,
    door: has('door') ? 'door' : floor,
    portal: has('portal') ? 'portal' : floor,
    loot: has('chest') ? 'chest' : undefined,
  };
}
