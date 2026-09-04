import { describe, it, expect } from 'vitest';
import { planRotation } from './rotation.ts';
import { WILD } from '../../shared/worldgen/config.ts';
import type { Entity } from '../../shared/types.ts';

// Minimal positional stand-ins — planRotation reads only `type` and
// `position.zone`, so building real entities here would test the factory, not
// the rule.
const at = (id: string, type: Entity['type'], zone: string): Entity =>
  ({ id, type, position: { zone, x: 0, y: 0 } }) as Entity;

const SITES = ['spiderfall_hollow', 'ashen_vault'];

describe('planRotation', () => {
  it('evacuates players standing in the wilderness', () => {
    const plan = planRotation([at('p1', 'player', WILD)], SITES);
    expect(plan.evacuate.map(p => p.id)).toEqual(['p1']);
  });

  it('evacuates players inside a dungeon — its interior re-rolls under them', () => {
    // The subtle case: a dungeon's zone ID survives the rotation, so nothing
    // else in the system would notice that the rooms are about to change.
    const plan = planRotation([at('p1', 'player', 'ashen_vault')], SITES);
    expect(plan.evacuate.map(p => p.id)).toEqual(['p1']);
  });

  it('leaves players in ordinary zones alone', () => {
    // Enclosed zones are seed-independent — the village is the fixed point a
    // rotation is supposed to preserve.
    const plan = planRotation([
      at('p1', 'player', 'zone_0_0'),
      at('p2', 'player', 'zone_0_0_tavern'),
    ], SITES);
    expect(plan.evacuate).toEqual([]);
    expect(plan.cull).toEqual([]);
  });

  it('culls every non-player entity in the wilderness, not just mobs', () => {
    // Corpses and dropped loot are as invalid as the mobs are — the tile they
    // sit on may be open water in the next epoch.
    const plan = planRotation([
      at('m1', 'mob', WILD),
      at('c1', 'corpse', WILD),
      at('g1', 'ground_item', WILD),
      at('p1', 'player', WILD),
    ], SITES);
    expect(plan.cull.sort()).toEqual(['c1', 'g1', 'm1']);
    expect(plan.evacuate.map(p => p.id)).toEqual(['p1']);
  });

  it('never culls a player', () => {
    const plan = planRotation([at('p1', 'player', WILD)], SITES);
    expect(plan.cull).toEqual([]);
  });

  it('leaves grid-zone entities to World._rebuildZone', () => {
    // Zone rebuilds already clear and respawn their own entities. Culling them
    // here too would double-remove, and would delete mobs in zones the rotation
    // has no business touching.
    const plan = planRotation([
      at('m1', 'mob', 'zone_0_0'),
      at('m2', 'mob', 'ashen_vault'),
    ], SITES);
    expect(plan.cull).toEqual([]);
  });

  it('handles a world with nothing in it', () => {
    expect(planRotation([], SITES)).toEqual({ evacuate: [], cull: [] });
  });
});
