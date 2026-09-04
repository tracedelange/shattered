import { ccFlags, ccSource } from './stats.ts';
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
  return applyStep(world, entity, d.dx, d.dy);
}

/** Facing stays a cardinal even when the step is diagonal — sprites, attack
 *  cones and `attackInFacing` all speak the four-way Direction. The horizontal
 *  component wins, because the side-on sprites read better than the back. */
function facingFromStep(dx: number, dy: number): Direction {
  if (dx > 0) return 'east';
  if (dx < 0) return 'west';
  return dy > 0 ? 'south' : 'north';
}

/** One step by a tile delta, each component in -1..1. Diagonals only reach here
 *  from the autopath stepper; WASD and the mob AI still go through
 *  `applyMovement`. */
export function applyStep(world: World, entity: Entity, dx: number, dy: number): boolean {
  if (dx === 0 && dy === 0) return false;
  const { zone, x, y } = entity.position;
  const nx = x + dx;
  const ny = y + dy;
  if (entity.type === 'player' || entity.type === 'mob') {
    const flags = ccFlags(entity);
    if (flags.has('root') || flags.has('stun')) return false;
    // Antagonized: can't retreat from the taunt source — this is the actual
    // "can't disengage" enforcement (ai.ts's antagonize branch only forces a
    // *mob's* target selection; it never constrained a player's own movement,
    // so a taunted player could always just walk away). Approaching or
    // strafing at the same distance is still allowed, only backing away is
    // blocked.
    if (flags.has('antagonize')) {
      const srcId = ccSource(entity, 'antagonize');
      const source = srcId ? world.entities.get(srcId) : undefined;
      if (source && source.position.zone === zone) {
        const curDist = Math.max(Math.abs(x - source.position.x), Math.abs(y - source.position.y));
        const newDist = Math.max(Math.abs(nx - source.position.x), Math.abs(ny - source.position.y));
        if (newDist > curDist) return false;
      }
    }
  }
  if (entity.type !== 'ground_item' && entity.type !== 'corpse') entity.facing = facingFromStep(dx, dy);
  if (!world.canMoveTo(zone, nx, ny)) return false;
  if (world.entityAt(zone, nx, ny)) return false;
  // No cutting corners and no squeezing between two bodies: a diagonal needs
  // both tiles it passes between to be walkable, or it would clip through the
  // corner of a wall (and through the gap in a two-mob pinch, which the melee
  // rules treat as a wall you have to go around).
  if (dx !== 0 && dy !== 0) {
    if (!world.canMoveTo(zone, x + dx, y) || world.entityAt(zone, x + dx, y)) return false;
    if (!world.canMoveTo(zone, x, y + dy) || world.entityAt(zone, x, y + dy)) return false;
  }
  entity.position.x = nx;
  entity.position.y = ny;
  return true;
}

export { DIRS };
