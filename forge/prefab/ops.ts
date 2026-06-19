// Pass 2 of the staged pipeline: parameterized ops applied to a Pass-1 base room.
// The LLM SELECTS ops (intent); the engine APPLIES them deterministically and
// enforces invariants — Gardener/Implementer split applied to layout. The
// load-bearing guarantee: an op that would break floor connectivity is rejected,
// so structure can't break no matter what the model asks for.
//
// Ops address cells SEMANTICALLY ('center', 'north', …); the engine resolves the
// concrete cell, so the model never does coordinate geometry (its weak spot).

import type { Role } from './shapes.ts';

export type Side = 'north' | 'south' | 'east' | 'west';
export type Position = 'center' | 'north' | 'south' | 'east' | 'west';

export type PrefabOp =
  | { op: 'punch_door'; side: Side }
  | { op: 'place_portal'; at: Position; tag?: 'descend' | 'ascend' }
  | { op: 'place_anchor'; at: Position; tag: string }
  | { op: 'add_pillars'; count: number }
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
    }
  };
  return floor.reduce((best, c) => (score(c) < score(best) ? c : best));
}

export interface ApplyOpts {
  seed?: number;
  /** Anchor tags the result MUST contain; any missing after ops are auto-placed. */
  requireAnchors?: string[];
}

export function applyOps(base: Role[][], ops: PrefabOp[], tiles: RoomTiles, opts: ApplyOpts = {}): ApplyResult {
  const role: Role[][] = base.map((r) => [...r]);
  const h = role.length;
  const w = h ? role[0]!.length : 0;
  const doors = new Set<string>();
  const anchors = new Map<string, AnchorCell>();
  const applied: string[] = [];
  const skipped: string[] = [];
  const rnd = mulberry32((opts.seed ?? 1) >>> 0);

  const anchorTile = (tag: string): string => (tag === 'loot' && tiles.loot ? tiles.loot : tiles.floor);

  const placeAnchorNear = (pos: Position, tag: string, tile: string): boolean => {
    const cell = resolveFloorCell(role, pos, new Set(anchors.keys()));
    if (!cell) return false;
    anchors.set(key(cell.x, cell.y), { tag, tile });
    return true;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'punch_door': {
        // A wall cell on the named side that borders interior floor → opening.
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
      case 'add_pillars': {
        // Lattice candidates, seeded-shuffled; each pillar guarded by connectivity.
        const cands: Array<{ x: number; y: number }> = [];
        for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
          if (role[y]![x] === 'floor' && x % 2 === 0 && y % 2 === 0) cands.push({ x, y });
        }
        for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cands[i], cands[j]] = [cands[j]!, cands[i]!]; }
        let placed = 0;
        for (const c of cands) {
          if (placed >= op.count) break;
          if (anchors.has(key(c.x, c.y))) continue;
          role[c.y]![c.x] = 'wall';
          if (floorRegions(role) === 1) placed++;
          else { role[c.y]![c.x] = 'floor'; skipped.push(`pillar @${c.x},${c.y} (would disconnect)`); }
        }
        applied.push(`add_pillars ${placed}/${op.count}`);
        break;
      }
      case 'erode_walls': {
        // Turn wall cells that border floor into floor (structural gaps); adding
        // floor can't disconnect, so no guard needed.
        const cands: Array<{ x: number; y: number }> = [];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (role[y]![x] === 'wall' && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => role[y + dy]?.[x + dx] === 'floor')) {
            cands.push({ x, y });
          }
        }
        for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cands[i], cands[j]] = [cands[j]!, cands[i]!]; }
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

  return { ...serialize(role, doors, anchors, tiles), applied, skipped };
}

const POOL = 'PLBNEQRSTUVWXYZabefghijkmnoqrstuvwxyz';

function serialize(
  role: Role[][],
  doors: Set<string>,
  anchors: Map<string, AnchorCell>,
  tiles: RoomTiles,
): { data: string; legend: Record<string, string>; anchors: Record<string, string> } {
  const legend: Record<string, string> = {};
  const anchorOut: Record<string, string> = {};
  let used = false;
  let usedWall = false;
  let usedDoor = false;
  let poolIdx = 0;
  const cellChar = new Map<string, string>();

  // Assign a unique char per anchor cell (legend → tile, anchors → tag).
  for (const [k, a] of anchors) {
    const ch = POOL[poolIdx++] ?? '?';
    cellChar.set(k, ch);
    legend[ch] = a.tile;
    anchorOut[ch] = a.tag;
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

/** Pick concrete floor/wall/door/portal tiles for a tileset (deterministic). */
export function roleTilesFor(tileNames: string[]): RoomTiles {
  const has = (t: string) => tileNames.includes(t);
  const firstWalkable = tileNames.find((t) => !/wall|void|water/.test(t)) ?? tileNames[0] ?? 'stone_floor';
  const firstWall = tileNames.find((t) => t.endsWith('wall')) ?? 'wall';
  return {
    floor: has('stone_floor') ? 'stone_floor' : firstWalkable,
    wall: has('wall') ? 'wall' : firstWall,
    door: has('door') ? 'door' : (has('stone_floor') ? 'stone_floor' : firstWalkable),
    portal: has('portal') ? 'portal' : (has('stone_floor') ? 'stone_floor' : firstWalkable),
    loot: has('chest') ? 'chest' : undefined,
  };
}
