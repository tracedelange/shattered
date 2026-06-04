import { isBlocked } from '../mapgen/index.ts';
import type { World } from '../world.ts';

const MAX_NODES = 4000;

export function planPath(
  world: World,
  zoneId: string,
  sx: number, sy: number,
  gx: number, gy: number,
  excludeEntityId?: string,
): Array<{ x: number; y: number }> | null {
  if (sx === gx && sy === gy) return [];
  const z = world.zones[zoneId];
  if (!z) return null;
  if (isBlocked(z.grid, gx, gy)) return null;

  // Snapshot occupied tiles (excluding the moving entity and the destination,
  // which may be occupied by the target mob).
  const occupied = new Set<number>();
  const w = z.width;
  const snapKey = (x: number, y: number) => y * w + x;
  for (const e of world.entities.values()) {
    if (e.position.zone !== zoneId) continue;
    if (excludeEntityId && e.id === excludeEntityId) continue;
    if (e.position.x === gx && e.position.y === gy) continue; // destination allowed
    occupied.add(snapKey(e.position.x, e.position.y));
  }

  const h = (x: number, y: number) => Math.abs(x - gx) + Math.abs(y - gy);
  const key = (x: number, y: number) => y * w + x;
  type Node = { x: number; y: number; g: number; f: number; from: number | null };
  const nodes = new Map<number, Node>();
  const open = new Map<number, Node>();
  const closed = new Set<number>();
  const start: Node = { x: sx, y: sy, g: 0, f: h(sx, sy), from: null };
  open.set(key(sx, sy), start);
  nodes.set(key(sx, sy), start);
  let visited = 0;

  while (open.size > 0) {
    let bestK = -1;
    let bestF = Infinity;
    for (const [k, n] of open) if (n.f < bestF) { bestF = n.f; bestK = k; }
    const cur = open.get(bestK)!;
    open.delete(bestK);
    closed.add(bestK);
    if (cur.x === gx && cur.y === gy) {
      const path: Array<{ x: number; y: number }> = [];
      let nodeK: number | null = bestK;
      while (nodeK !== null) {
        const n: Node = nodes.get(nodeK)!;
        if (n.from !== null) path.push({ x: n.x, y: n.y });
        nodeK = n.from;
      }
      return path.reverse();
    }
    if (++visited > MAX_NODES) return null;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const nx = cur.x + dx, ny = cur.y + dy;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      if (isBlocked(z.grid, nx, ny)) continue;
      if (occupied.has(nk)) continue;
      const g = cur.g + 1;
      const existing = open.get(nk);
      if (existing && existing.g <= g) continue;
      const node: Node = { x: nx, y: ny, g, f: g + h(nx, ny), from: bestK };
      open.set(nk, node);
      nodes.set(nk, node);
    }
  }
  return null;
}
