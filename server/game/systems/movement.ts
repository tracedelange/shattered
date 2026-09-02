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
  const { zone, x, y } = entity.position;
  const nx = x + d.dx;
  const ny = y + d.dy;
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
  if (entity.type !== 'ground_item' && entity.type !== 'corpse') entity.facing = dir;
  if (!world.canMoveTo(zone, nx, ny)) return false;
  if (world.entityAt(zone, nx, ny)) return false;
  entity.position.x = nx;
  entity.position.y = ny;
  return true;
}

export { DIRS };
