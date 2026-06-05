import type { Direction, Entity } from '../../../shared/types.ts';
import type { World } from '../world.ts';

const DIRS: Record<Direction, { dx: number; dy: number }> = {
  north: { dx:  0, dy: -1 },
  south: { dx:  0, dy:  1 },
  east:  { dx:  1, dy:  0 },
  west:  { dx: -1, dy:  0 },
};

export function applyMovement(world: World, entity: Entity, dir: Direction): boolean {
  const d = DIRS[dir];
  if (!d) return false;
  const { zone, x, y } = entity.position;
  const nx = x + d.dx;
  const ny = y + d.dy;
  if (entity.type !== 'ground_item' && entity.type !== 'corpse') entity.facing = dir;
  if (!world.canMoveTo(zone, nx, ny)) return false;
  if (world.entityAt(zone, nx, ny)) return false;
  entity.position.x = nx;
  entity.position.y = ny;
  return true;
}

export { DIRS };
