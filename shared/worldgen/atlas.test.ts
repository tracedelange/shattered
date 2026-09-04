import { describe, it, expect } from 'vitest';
import { buildAtlas, siteAt } from './atlas.ts';
import { deriveSeeds, isWildBlocked, wildTileAt } from './field.ts';
import { DANGER_RADIUS } from './config.ts';
import { epochSeed } from './epoch.ts';
import type { DungeonDef } from '../types.ts';

const roster: DungeonDef[] = [
  {
    id: 'shallow_den', name: 'Shallow Den',
    placement: { min_level: 3, max_level: 6, biomes: ['forest', 'grassland'] },
    zone: { biome: 'cave' },
  },
  {
    id: 'mid_warren', name: 'Mid Warren',
    placement: { min_level: 10, max_level: 14 },
    zone: { biome: 'dungeon' },
  },
  {
    id: 'deep_vault', name: 'Deep Vault',
    placement: { min_level: 30, max_level: 36, biomes: ['badlands', 'mountain'] },
    zone: { biome: 'cave' },
  },
];

describe('dungeon site placement', () => {
  it('is deterministic in the seed', () => {
    const a = buildAtlas(epochSeed('test', 1), 'zone_0_0', roster, 1);
    const b = buildAtlas(epochSeed('test', 1), 'zone_0_0', roster, 1);
    expect(a.sites).toEqual(b.sites);
  });

  it('does not depend on roster file order', () => {
    const a = buildAtlas(epochSeed('test', 1), 'zone_0_0', roster, 1);
    const b = buildAtlas(epochSeed('test', 1), 'zone_0_0', [...roster].reverse(), 1);
    expect(b.sites).toEqual(a.sites);
  });

  it('re-rolls positions on the next epoch', () => {
    const a = buildAtlas(epochSeed('test', 1), 'zone_0_0', roster, 1);
    const b = buildAtlas(epochSeed('test', 2), 'zone_0_0', roster, 2);
    for (const site of a.sites) {
      const moved = b.sites.find(s => s.id === site.id)!;
      expect(moved.worldX === site.worldX && moved.worldY === site.worldY).toBe(false);
    }
  });

  it('places every roster entry — a discovered site must never go missing', () => {
    for (let epoch = 1; epoch <= 12; epoch++) {
      const atlas = buildAtlas(epochSeed('test', epoch), 'zone_0_0', roster, epoch);
      expect(atlas.sites.map(s => s.id).sort()).toEqual(roster.map(d => d.id).sort());
    }
  });

  it('keeps each entrance inside its level band, which is what fixes difficulty across rotations', () => {
    for (let epoch = 1; epoch <= 12; epoch++) {
      const atlas = buildAtlas(epochSeed('test', epoch), 'zone_0_0', roster, epoch);
      for (const site of atlas.sites) {
        const def = roster.find(d => d.id === site.id)!;
        const dist = Math.hypot(site.worldX, site.worldY);
        // Danger is radial, so the band IS the annulus. The lower bound is
        // clamped clear of the origin grove, hence the max() here.
        const rMin = Math.max(140, ((def.placement.min_level - 1) / 100) * DANGER_RADIUS);
        const rMax = Math.max(200, (def.placement.max_level / 100) * DANGER_RADIUS);
        expect(dist).toBeGreaterThanOrEqual(rMin - 1);
        expect(dist).toBeLessThanOrEqual(rMax + 1);
      }
    }
  });

  it('puts entrances on reachable ground, never in water or a thicket', () => {
    for (let epoch = 1; epoch <= 12; epoch++) {
      const seed = epochSeed('test', epoch);
      const atlas = buildAtlas(seed, 'zone_0_0', roster, epoch);
      const seeds = deriveSeeds(atlas.numericSeed);
      for (const site of atlas.sites) {
        // The tile itself reads as a walkable portal (the footprint stamped
        // around it must never seal its own entrance)...
        expect(wildTileAt(site.worldX, site.worldY, seeds, atlas)).toBe('portal');
        // ...and the surrounding field is genuinely open, so it can be walked to.
        let open = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const t = wildTileAt(site.worldX + dx, site.worldY + dy, seeds);
            if (t !== 'water' && t !== 'swamp_water' && !isWildBlocked(t)) open++;
          }
        }
        expect(open).toBeGreaterThanOrEqual(16);
      }
    }
  });

  it('spaces entrances apart', () => {
    for (let epoch = 1; epoch <= 12; epoch++) {
      const { sites } = buildAtlas(epochSeed('test', epoch), 'zone_0_0', roster, epoch);
      for (let i = 0; i < sites.length; i++) {
        for (let j = i + 1; j < sites.length; j++) {
          const a = sites[i]!, b = sites[j]!;
          expect(Math.hypot(a.worldX - b.worldX, a.worldY - b.worldY)).toBeGreaterThanOrEqual(220);
        }
      }
    }
  });

  it('resolves an entrance tile back to its site', () => {
    const atlas = buildAtlas(epochSeed('test', 3), 'zone_0_0', roster, 3);
    const site = atlas.sites[0]!;
    expect(siteAt(atlas, site.worldX, site.worldY)?.id).toBe(site.id);
    expect(siteAt(atlas, site.worldX + 3, site.worldY)).toBeNull();
  });

  it('leaves the village untouched by the roster', () => {
    const bare = buildAtlas(epochSeed('test', 5), 'zone_0_0', [], 5);
    const full = buildAtlas(epochSeed('test', 5), 'zone_0_0', roster, 5);
    expect(full.settlements).toEqual(bare.settlements);
  });
});
