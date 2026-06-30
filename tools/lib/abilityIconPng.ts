// Node-only: rasterize a procedural ability icon to a PNG buffer. Kept out of
// shared/ so the client/vite build never pulls in pngjs (the generator itself
// in shared/abilityIcon.ts is pure and browser-safe).

import { PNG } from 'pngjs';
import { renderAbilityIcon, type IconSpec } from '../../shared/abilityIcon.ts';

export function abilityIconPng(spec: IconSpec, size = 64): Buffer {
  const rgba = renderAbilityIcon(spec, size);
  const png = new PNG({ width: size, height: size });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png);
}
