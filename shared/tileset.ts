// Shared tileset helpers. Both the client renderer (hex strings → canvas) and
// the pipeline PNG renderer (RGB tuples → raw pixels) need to read tile and
// sprite colors out of a Tileset. Keep that flatten-the-map logic here.
//
// Fallback colors are caller-specified — the client may want a less alarming
// default for missing sprites in-game, while the pipeline renderer wants
// magenta everywhere so missing assets shout at you in the PNG.

import type { Tileset } from './types.ts';

export function buildTileColorMap(ts: Tileset): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ts.tiles).map(([k, v]) => [k, v.color]),
  );
}

export function buildSpriteColorMap(ts: Tileset): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ts.sprites).map(([k, v]) => [k, v.color]),
  );
}

/** Parse "#rrggbb" (or "rrggbb") to an RGB tuple. Returns magenta on bad input. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [255, 0, 255];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
