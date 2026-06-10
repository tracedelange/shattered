import type { FeatureDef } from './index.ts';

// Cardinal edge features: 6-tile sand strip, then 3-tile water strip on top.
// Result: 3 water tiles + 3 sand tiles from the ocean edge inward.

export const beachN: FeatureDef = {
  id: 'beach_N',
  note: 'Ocean border on the north edge: water strip with sand transition.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill', tile: 'sand', bounds: { edge_strip: 'north', depth: 6 } } },
    { kind: 'fixed', op: { type: 'fill', tile: 'water', bounds: { edge_strip: 'north', depth: 3 } } },
  ],
};

export const beachS: FeatureDef = {
  id: 'beach_S',
  note: 'Ocean border on the south edge: water strip with sand transition.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill', tile: 'sand', bounds: { edge_strip: 'south', depth: 6 } } },
    { kind: 'fixed', op: { type: 'fill', tile: 'water', bounds: { edge_strip: 'south', depth: 3 } } },
  ],
};

export const beachE: FeatureDef = {
  id: 'beach_E',
  note: 'Ocean border on the east edge: water strip with sand transition.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill', tile: 'sand', bounds: { edge_strip: 'east', depth: 6 } } },
    { kind: 'fixed', op: { type: 'fill', tile: 'water', bounds: { edge_strip: 'east', depth: 3 } } },
  ],
};

export const beachW: FeatureDef = {
  id: 'beach_W',
  note: 'Ocean border on the west edge: water strip with sand transition.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill', tile: 'sand', bounds: { edge_strip: 'west', depth: 6 } } },
    { kind: 'fixed', op: { type: 'fill', tile: 'water', bounds: { edge_strip: 'west', depth: 3 } } },
  ],
};

// Corner patch features: 7×7 sand corner, then 4×4 water corner on top.
// Applied only when the diagonal neighbor is ocean but neither cardinal neighbor is.

export const beachNE: FeatureDef = {
  id: 'beach_NE',
  note: 'Ocean at the northeast corner only: water+sand patch at the NE corner.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill', tile: 'sand', bounds: { corner_patch: 'NE', depth: 7 } } },
    { kind: 'fixed', op: { type: 'fill', tile: 'water', bounds: { corner_patch: 'NE', depth: 4 } } },
  ],
};

export const beachNW: FeatureDef = {
  id: 'beach_NW',
  note: 'Ocean at the northwest corner only: water+sand patch at the NW corner.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill', tile: 'sand', bounds: { corner_patch: 'NW', depth: 7 } } },
    { kind: 'fixed', op: { type: 'fill', tile: 'water', bounds: { corner_patch: 'NW', depth: 4 } } },
  ],
};

export const beachSE: FeatureDef = {
  id: 'beach_SE',
  note: 'Ocean at the southeast corner only: water+sand patch at the SE corner.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill', tile: 'sand', bounds: { corner_patch: 'SE', depth: 7 } } },
    { kind: 'fixed', op: { type: 'fill', tile: 'water', bounds: { corner_patch: 'SE', depth: 4 } } },
  ],
};

export const beachSW: FeatureDef = {
  id: 'beach_SW',
  note: 'Ocean at the southwest corner only: water+sand patch at the SW corner.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill', tile: 'sand', bounds: { corner_patch: 'SW', depth: 7 } } },
    { kind: 'fixed', op: { type: 'fill', tile: 'water', bounds: { corner_patch: 'SW', depth: 4 } } },
  ],
};
