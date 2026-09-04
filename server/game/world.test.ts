import { describe, it, expect, beforeEach } from 'vitest';
import { World } from './world.ts';
import { makePlayer } from './entities.ts';
import { buildAtlas } from '../../shared/worldgen/atlas.ts';
import { deriveSeeds } from '../../shared/worldgen/field.ts';
import { WILD } from '../../shared/worldgen/config.ts';
import type { TeleportFxEvent, WorldDefs } from '../../shared/types.ts';

// Teleport effects are the one contract every relocation source shares — /tp, a
// portal, a blink, a wilds rotation. The rule under test is that a teleport
// always announces BOTH ends: the origin puff is what bystanders see, and it is
// emitted after the entity has already moved, so it has to be captured up front
// rather than read back off the entity.
describe('World.teleportFx', () => {
  let world: World;
  let fx: TeleportFxEvent[];

  beforeEach(() => {
    world = new World();
    // Only the wilderness is exercised here: an enclosed zone would need a full
    // definition load, and the funnel is identical on both branches.
    const atlas = buildAtlas('teleport-fx-test');
    world.atlas = atlas;
    world.wildSeeds = deriveSeeds(atlas.numericSeed);
    world.defs = { blockingTiles: new Set<string>() } as unknown as WorldDefs;
    fx = [];
    world.onTeleport = (ev) => fx.push(ev);
  });

  const player = () => {
    const p = makePlayer({ id: 'p1', zone: WILD, x: 300, y: 300, name: 'Hero', klass: 'fighter' });
    world.addEntity(p);
    return p;
  };

  it('emits a departure at the old position and an arrival at the new one', () => {
    const p = player();
    world.teleportPlayer(p, WILD, 900, -400);

    expect(fx).toHaveLength(2);
    expect(fx[0]).toMatchObject({ entityId: 'p1', zoneId: WILD, x: 300, y: 300, phase: 'depart' });
    expect(fx[1]).toMatchObject({ entityId: 'p1', zoneId: WILD, phase: 'arrive' });
  });

  it('reports the arrival where the entity actually landed', () => {
    // teleportPlayer snaps to the nearest free tile, so the arrival puff must
    // come off the entity's resolved position, not the requested coordinates —
    // otherwise smoke appears in the lake next to the player.
    const p = player();
    world.teleportPlayer(p, WILD, 900, -400);
    expect(fx[1]).toMatchObject({ x: p.position.x, y: p.position.y });
  });

  it('says nothing when no emitter is attached', () => {
    // Tools and the generator fixtures drive a World with no sockets.
    world.onTeleport = null;
    const p = player();
    expect(() => world.teleportPlayer(p, WILD, 500, 500)).not.toThrow();
    expect(fx).toHaveLength(0);
  });

  it('stays quiet for continuous movement across a zone seam', () => {
    // transitionPlayer is walking, not teleporting. A puff on every zone edge
    // would turn ordinary travel into a firework show — this is why the hook
    // lives on the explicit teleport entry points and not in _relocate.
    const p = player();
    world.transitionPlayer(p, 'north', 'nonexistent_zone');
    expect(fx).toHaveLength(0);
  });
});
