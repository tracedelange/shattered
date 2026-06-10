import type { FeatureDef } from './index.ts';

// Each beach feature runs four ops (sorted by resolveFeatureOps: sand ops first, water ops last):
//   1. fill sand       — solid base strip
//   2. noise_patch sand — feathers sand into land tiles on the far edge
//   3. noise_patch water — jagged water fingers reaching into the sand zone
//   4. fill water      — solid core water (always wins at the zone edge)
//
// Execution order across multiple beach features is safe: resolveFeatureOps
// defers ALL water-tile ops to after ALL sand-tile ops, preventing adjacent
// beach features from clobbering each other's water at corners.

export const beachN: FeatureDef = {
  id: 'beach_N',
  note: 'Ocean border on the north edge: water strip with noisy sand transition.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill',        tile: 'sand',  bounds: { edge_strip: 'north', depth: 8  } } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'sand',  bounds: { edge_strip: 'north', depth: 12 }, threshold: 0.67, scale: 2.5, seed: 'bN_s' } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'water', bounds: { edge_strip: 'north', depth: 7  }, over: 'sand', threshold: 0.60, scale: 3.5, seed: 'bN_w' } },
    { kind: 'fixed', op: { type: 'fill',         tile: 'water', bounds: { edge_strip: 'north', depth: 3  } } },
  ],
};

export const beachS: FeatureDef = {
  id: 'beach_S',
  note: 'Ocean border on the south edge: water strip with noisy sand transition.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill',        tile: 'sand',  bounds: { edge_strip: 'south', depth: 8  } } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'sand',  bounds: { edge_strip: 'south', depth: 12 }, threshold: 0.67, scale: 2.5, seed: 'bS_s' } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'water', bounds: { edge_strip: 'south', depth: 7  }, over: 'sand', threshold: 0.60, scale: 3.5, seed: 'bS_w' } },
    { kind: 'fixed', op: { type: 'fill',         tile: 'water', bounds: { edge_strip: 'south', depth: 3  } } },
  ],
};

export const beachE: FeatureDef = {
  id: 'beach_E',
  note: 'Ocean border on the east edge: water strip with noisy sand transition.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill',        tile: 'sand',  bounds: { edge_strip: 'east', depth: 8  } } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'sand',  bounds: { edge_strip: 'east', depth: 12 }, threshold: 0.67, scale: 2.5, seed: 'bE_s' } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'water', bounds: { edge_strip: 'east', depth: 7  }, over: 'sand', threshold: 0.60, scale: 3.5, seed: 'bE_w' } },
    { kind: 'fixed', op: { type: 'fill',         tile: 'water', bounds: { edge_strip: 'east', depth: 3  } } },
  ],
};

export const beachW: FeatureDef = {
  id: 'beach_W',
  note: 'Ocean border on the west edge: water strip with noisy sand transition.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill',        tile: 'sand',  bounds: { edge_strip: 'west', depth: 8  } } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'sand',  bounds: { edge_strip: 'west', depth: 12 }, threshold: 0.67, scale: 2.5, seed: 'bW_s' } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'water', bounds: { edge_strip: 'west', depth: 7  }, over: 'sand', threshold: 0.60, scale: 3.5, seed: 'bW_w' } },
    { kind: 'fixed', op: { type: 'fill',         tile: 'water', bounds: { edge_strip: 'west', depth: 3  } } },
  ],
};

// Corner patches (diagonal ocean only). Slightly tighter depths since the
// patch is a square inset, not a full edge.
export const beachNE: FeatureDef = {
  id: 'beach_NE',
  note: 'Ocean at the northeast corner only: noisy water+sand patch at NE.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill',        tile: 'sand',  bounds: { corner_patch: 'NE', depth: 8 } } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'sand',  bounds: { corner_patch: 'NE', depth: 11 }, threshold: 0.65, scale: 2.5, seed: 'bNE_s' } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'water', bounds: { corner_patch: 'NE', depth: 6  }, over: 'sand', threshold: 0.58, scale: 2.5, seed: 'bNE_w' } },
    { kind: 'fixed', op: { type: 'fill',         tile: 'water', bounds: { corner_patch: 'NE', depth: 4  } } },
  ],
};

export const beachNW: FeatureDef = {
  id: 'beach_NW',
  note: 'Ocean at the northwest corner only: noisy water+sand patch at NW.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill',        tile: 'sand',  bounds: { corner_patch: 'NW', depth: 8 } } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'sand',  bounds: { corner_patch: 'NW', depth: 11 }, threshold: 0.65, scale: 2.5, seed: 'bNW_s' } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'water', bounds: { corner_patch: 'NW', depth: 6  }, over: 'sand', threshold: 0.58, scale: 2.5, seed: 'bNW_w' } },
    { kind: 'fixed', op: { type: 'fill',         tile: 'water', bounds: { corner_patch: 'NW', depth: 4  } } },
  ],
};

export const beachSE: FeatureDef = {
  id: 'beach_SE',
  note: 'Ocean at the southeast corner only: noisy water+sand patch at SE.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill',        tile: 'sand',  bounds: { corner_patch: 'SE', depth: 8 } } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'sand',  bounds: { corner_patch: 'SE', depth: 11 }, threshold: 0.65, scale: 2.5, seed: 'bSE_s' } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'water', bounds: { corner_patch: 'SE', depth: 6  }, over: 'sand', threshold: 0.58, scale: 2.5, seed: 'bSE_w' } },
    { kind: 'fixed', op: { type: 'fill',         tile: 'water', bounds: { corner_patch: 'SE', depth: 4  } } },
  ],
};

export const beachSW: FeatureDef = {
  id: 'beach_SW',
  note: 'Ocean at the southwest corner only: noisy water+sand patch at SW.',
  blueprint: [
    { kind: 'fixed', op: { type: 'fill',        tile: 'sand',  bounds: { corner_patch: 'SW', depth: 8 } } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'sand',  bounds: { corner_patch: 'SW', depth: 11 }, threshold: 0.65, scale: 2.5, seed: 'bSW_s' } },
    { kind: 'fixed', op: { type: 'noise_patch',  tile: 'water', bounds: { corner_patch: 'SW', depth: 6  }, over: 'sand', threshold: 0.58, scale: 2.5, seed: 'bSW_w' } },
    { kind: 'fixed', op: { type: 'fill',         tile: 'water', bounds: { corner_patch: 'SW', depth: 4  } } },
  ],
};
