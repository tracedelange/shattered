const DIRS = {
  north: { dx:  0, dy: -1 },
  south: { dx:  0, dy:  1 },
  east:  { dx:  1, dy:  0 },
  west:  { dx: -1, dy:  0 },
};

export function applyMovement(world, entity, dir) {
  const d = DIRS[dir];
  if (!d) return false;
  const { zone, x, y } = entity.position;
  const nx = x + d.dx;
  const ny = y + d.dy;
  // Track facing even if the move is blocked — feels better for attack aiming.
  entity.facing = dir;
  if (!world.canMoveTo(zone, nx, ny)) return false;
  if (world.entityAt(zone, nx, ny)) return false;
  entity.position.x = nx;
  entity.position.y = ny;
  return true;
}

export { DIRS };
