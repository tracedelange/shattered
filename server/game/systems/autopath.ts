import { isBlocked } from '../mapgen/index.ts';
import { WILD } from '../../../shared/worldgen/config.ts';
import type { World } from '../world.ts';

const MAX_NODES = 4000;
// Diagonal step cost. Charging √2 (rather than 1) is what keeps a staircase
// from being planned as a free shortcut: the route it produces is the one that
// is actually shorter on the ground, and the stepper bills the same √2 against
// its movement accumulator so a diagonal walk isn't faster than a straight one.
const DIAG = Math.SQRT2;
// Cardinals first: with equal f-scores the cardinal is expanded first, which
// keeps a straight run straight instead of zig-zagging across it.
const NEIGHBOURS = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
] as const;

export function planPath(
  world: World,
  zoneId: string,
  sx: number, sy: number,
  gx: number, gy: number,
  excludeEntityId?: string,
): Array<{ x: number; y: number }> | null {
  if (sx === gx && sy === gy) return [];
  // Wilderness is a gridless, signed-coordinate field — walkability comes from
  // World.canMoveTo (which samples the shared terrain function). Enclosed zones
  // index their bounded grid. String keys work for both (signed coords would
  // collide under y*w+x).
  const wild = zoneId === WILD;
  const z = wild ? null : world.zones[zoneId];
  if (!wild && !z) return null;
  const blocked = wild
    ? (x: number, y: number) => !world.canMoveTo(WILD, x, y)
    : (x: number, y: number) => isBlocked(z!.grid, x, y, world.defs.blockingTiles);
  if (blocked(gx, gy)) return null;

  // Snapshot occupied tiles (excluding the moving entity and the destination,
  // which may be occupied by the target mob).
  const occupied = new Set<string>();
  const snapKey = (x: number, y: number) => `${x},${y}`;
  for (const e of world.entities.values()) {
    if (e.position.zone !== zoneId) continue;
    if (excludeEntityId && e.id === excludeEntityId) continue;
    if (e.position.x === gx && e.position.y === gy) continue; // destination allowed
    occupied.add(snapKey(e.position.x, e.position.y));
  }

  // Octile distance: the diagonal legs of the route cost DIAG each, the rest 1.
  // Plus a tiny straight-line deviation term — the cross product of (tile->goal)
  // and (start->goal) over the line length is the tile's perpendicular distance
  // from the direct start->goal line, and preferring tiles that hug that line
  // breaks ties towards the route that looks intentional. Normalizing keeps the
  // term well below 1, so it only ever separates equal-cost paths and never
  // overrides real distance — obstacle avoidance and optimality are unaffected.
  const dxsg = sx - gx, dysg = sy - gy;
  const lineMag = Math.abs(dxsg) + Math.abs(dysg) || 1;
  const h = (x: number, y: number) => {
    const ax = Math.abs(x - gx), ay = Math.abs(y - gy);
    const octile = (ax + ay) + (DIAG - 2) * Math.min(ax, ay);
    const deviation = Math.abs((x - gx) * dysg - dxsg * (y - gy)) / lineMag;
    return octile + deviation * 0.001;
  };
  const key = (x: number, y: number) => `${x},${y}`;
  type Node = { x: number; y: number; g: number; f: number; from: string | null };
  const nodes = new Map<string, Node>();
  const open = new Map<string, Node>();
  const closed = new Set<string>();
  const start: Node = { x: sx, y: sy, g: 0, f: h(sx, sy), from: null };
  open.set(key(sx, sy), start);
  nodes.set(key(sx, sy), start);
  let visited = 0;

  while (open.size > 0) {
    let bestK = '';
    let bestF = Infinity;
    for (const [k, n] of open) if (n.f < bestF) { bestF = n.f; bestK = k; }
    const cur = open.get(bestK)!;
    open.delete(bestK);
    closed.add(bestK);
    if (cur.x === gx && cur.y === gy) {
      const path: Array<{ x: number; y: number }> = [];
      let nodeK: string | null = bestK;
      while (nodeK !== null) {
        const n: Node = nodes.get(nodeK)!;
        if (n.from !== null) path.push({ x: n.x, y: n.y });
        nodeK = n.from;
      }
      return path.reverse();
    }
    if (++visited > MAX_NODES) return null;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      if (blocked(nx, ny)) continue;
      if (occupied.has(nk)) continue;
      // A diagonal squeezes between two tiles; both have to be open, or the
      // path clips a wall corner. Mirrors the same rule in applyStep, so the
      // stepper never finds a planned step it can't actually take.
      if (dx !== 0 && dy !== 0) {
        const sideA = key(cur.x + dx, cur.y), sideB = key(cur.x, cur.y + dy);
        if (blocked(cur.x + dx, cur.y) || occupied.has(sideA)) continue;
        if (blocked(cur.x, cur.y + dy) || occupied.has(sideB)) continue;
      }
      const g = cur.g + (dx !== 0 && dy !== 0 ? DIAG : 1);
      const existing = open.get(nk);
      if (existing && existing.g <= g) continue;
      const node: Node = { x: nx, y: ny, g, f: g + h(nx, ny), from: bestK };
      open.set(nk, node);
      nodes.set(nk, node);
    }
  }
  return null;
}
