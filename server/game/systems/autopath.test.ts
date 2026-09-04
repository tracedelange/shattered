import { describe, expect, it } from 'vitest';
import { planPath } from './autopath.ts';
import type { World } from '../world.ts';

/** A zone from an ASCII map: '#' blocks, anything else walks. Only the fields
 *  planPath actually reads are present — it never touches the rest of World. */
function worldFrom(rows: string[], entities: Array<{ x: number; y: number }> = []): World {
  const grid = rows.map((r) => [...r].map((c) => (c === '#' ? 'wall' : 'floor')));
  return {
    zones: { test: { grid, width: rows[0]!.length, height: rows.length } },
    defs: { blockingTiles: new Set(['wall']) },
    entities: new Map(entities.map((e, i) => [`e${i}`, { id: `e${i}`, position: { zone: 'test', ...e } }])),
  } as unknown as World;
}

describe('planPath walks diagonals', () => {
  it('crosses open ground on the diagonal, one step per tile', () => {
    const world = worldFrom(Array(6).fill('......'));
    const path = planPath(world, 'test', 0, 0, 4, 4);
    expect(path).toEqual([
      { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 },
    ]);
  });

  it('keeps a straight run straight', () => {
    const world = worldFrom(Array(6).fill('......'));
    const path = planPath(world, 'test', 0, 0, 4, 0);
    expect(path).toEqual([{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }]);
  });

  it('never cuts the corner of a wall', () => {
    // The direct diagonal from (0,0) to (1,1) would slip past the corner where
    // the two walls meet; the only legal route is the long way round.
    const world = worldFrom([
      '....',
      '.#..',
      '#...',
      '....',
    ]);
    const path = planPath(world, 'test', 0, 1, 1, 2);
    expect(path).not.toBeNull();
    for (const [i, step] of path!.entries()) {
      const prev = i === 0 ? { x: 0, y: 1 } : path![i - 1]!;
      const dx = step.x - prev.x, dy = step.y - prev.y;
      // Every diagonal in the route has both of its side tiles open.
      if (dx !== 0 && dy !== 0) {
        expect(world.zones.test!.grid[prev.y]![prev.x + dx]).not.toBe('wall');
        expect(world.zones.test!.grid[prev.y + dy]![prev.x]).not.toBe('wall');
      }
    }
  });

  it('will not squeeze diagonally between two bodies', () => {
    const world = worldFrom(Array(4).fill('....'), [{ x: 1, y: 0 }, { x: 0, y: 1 }]);
    expect(planPath(world, 'test', 0, 0, 1, 1)).toBeNull();
  });

  it('returns null when the goal is walled off', () => {
    const world = worldFrom([
      '..#..',
      '..#..',
      '..#..',
    ]);
    expect(planPath(world, 'test', 0, 1, 4, 1)).toBeNull();
  });
});
