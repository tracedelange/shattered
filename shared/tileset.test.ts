import { describe, expect, it } from 'vitest';
import { pickSeamTile, pickTileVariant } from './tileset.ts';
import type { Tileset } from './types.ts';

const ts: Tileset = {
  name: 'test',
  tile_size: 32,
  tiles: {
    grass: { color: '#0f0', blend: true },
    sand: { color: '#fc0', blend: true },
    snow: { color: '#fff', blend: true },
    water: { color: '#00f', blocking: true }, // no blend — must never leak
    chest: { color: '#a52' },                 // decoration, no blend
  },
  sprites: {},
};

describe('pickSeamTile', () => {
  it('leaves a tile alone when every neighbour is the same material', () => {
    for (let x = 0; x < 40; x++) {
      expect(pickSeamTile('grass', x, 7, ts, () => 'grass')).toBe('grass');
    }
  });

  it('never swaps a tile that has not opted into blending', () => {
    // A water tile fully surrounded by grass is the strongest possible pull.
    for (let x = 0; x < 40; x++) {
      expect(pickSeamTile('water', x, 3, ts, () => 'grass')).toBe('water');
    }
  });

  it('never swaps *to* a material that has not opted into blending', () => {
    // Drawing walkable grass as blocking water would lie about the map.
    for (let x = 0; x < 40; x++) {
      expect(pickSeamTile('grass', x, 5, ts, () => 'water')).toBe('grass');
      expect(pickSeamTile('grass', x, 6, ts, () => 'chest')).toBe('grass');
    }
  });

  it('only ever draws its own material or a neighbouring one', () => {
    for (let x = 0; x < 60; x++) {
      const drawn = pickSeamTile('grass', x, 0, ts, (dx, dy) => {
        if (dx === 0 && dy === -1) return 'sand';
        if (dx === 1 && dy === 0) return 'snow';
        return 'grass';
      });
      expect(['grass', 'sand', 'snow']).toContain(drawn);
    }
  });

  it('dithers along a seam without repainting the whole edge', () => {
    let swapped = 0;
    for (let y = 0; y < 200; y++) {
      if (pickSeamTile('grass', 0, y, ts, dx => (dx < 0 ? 'sand' : 'grass')) === 'sand') swapped++;
    }
    expect(swapped).toBeGreaterThan(0);
    expect(swapped).toBeLessThan(200);
  });

  it('blends harder the more of the other material surrounds it', () => {
    const count = (neighbor: (dx: number, dy: number) => string) => {
      let n = 0;
      for (let y = 0; y < 400; y++) if (pickSeamTile('grass', 11, y, ts, neighbor) === 'sand') n++;
      return n;
    };
    const cornerOnly = count((dx, dy) => (dx === -1 && dy === -1 ? 'sand' : 'grass'));
    const straightEdge = count(dx => (dx < 0 ? 'sand' : 'grass'));
    const surrounded = count(() => 'sand');
    expect(cornerOnly).toBeLessThan(straightEdge);
    expect(straightEdge).toBeLessThan(surrounded);
  });

  it('prefers the material with the most weight behind it', () => {
    // Sand on three cardinals, snow on one: snow never wins the tally.
    let sand = 0, snow = 0;
    for (let y = 0; y < 300; y++) {
      const drawn = pickSeamTile('grass', 3, y, ts, (dx, dy) => {
        if (dx === 1 && dy === 0) return 'snow';
        return dx === 0 || dy === 0 ? 'sand' : 'grass';
      });
      if (drawn === 'sand') sand++;
      if (drawn === 'snow') snow++;
    }
    expect(sand).toBeGreaterThan(0);
    expect(snow).toBe(0);
  });

  it('is deterministic in (x, y) — same coords, same answer', () => {
    const neighbor = (dx: number) => (dx < 0 ? 'sand' : 'grass');
    for (let y = 0; y < 50; y++) {
      expect(pickSeamTile('grass', 4, y, ts, neighbor))
        .toBe(pickSeamTile('grass', 4, y, ts, neighbor));
    }
  });
});

describe('pickTileVariant', () => {
  it('returns 0 when there is nothing to choose between', () => {
    expect(pickTileVariant('grass', 3, 9, 1)).toBe(0);
    expect(pickTileVariant('grass', 3, 9, 0)).toBe(0);
  });

  it('stays inside the variant range, weighted or not', () => {
    for (let x = 0; x < 100; x++) {
      const v = pickTileVariant('grass', x, 2, 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
      const w = pickTileVariant('grass', x, 2, 5, [3, 2, 2, 1, 1]);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(5);
    }
  });

  it('ignores weights whose length does not match the variant count', () => {
    for (let x = 0; x < 40; x++) {
      expect(pickTileVariant('grass', x, 1, 5, [1, 1])).toBe(pickTileVariant('grass', x, 1, 5));
    }
  });

  it('gives a zero-weight variant no patches at all', () => {
    for (let x = 0; x < 200; x++) {
      expect(pickTileVariant('sand', x, 6, 3, [1, 0, 1])).not.toBe(1);
    }
  });
});
