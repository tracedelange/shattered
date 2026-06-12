import type { FeatureOperator } from './index.ts';

// Each beach operator runs four ops, all in the decorate phase:
//   1. fill sand       — solid base strip
//   2. noise_patch sand — feathers sand into land tiles on the far edge
//   3. noise_patch water — jagged water fingers reaching into the sand zone
//   4. fill water      — solid core water (always wins at the zone edge)
//
// The decorate phase defers ALL water-tile ops after ALL non-water ops (see
// resolveFeatureOperators), so adjacent beach features cannot clobber each
// other's water at shared corners.

export const beachN: FeatureOperator = {
  id: 'beach_N',
  note: 'Ocean border on the north edge: water strip with noisy sand transition.',
  phase: 'decorate',
  blueprint: () => [
    { type: 'fill',        tile: 'sand',  bounds: { edge_strip: 'north', depth: 8  }, region: 'beach_N' },
    { type: 'noise_patch',  tile: 'sand',  bounds: { edge_strip: 'north', depth: 12 }, threshold: 0.67, scale: 2.5, seed: 'bN_s' },
    { type: 'noise_patch',  tile: 'water', bounds: { edge_strip: 'north', depth: 7  }, over: 'sand', threshold: 0.60, scale: 3.5, seed: 'bN_w' },
    { type: 'fill',         tile: 'water', bounds: { edge_strip: 'north', depth: 3  } },
  ],
};

export const beachS: FeatureOperator = {
  id: 'beach_S',
  note: 'Ocean border on the south edge: water strip with noisy sand transition.',
  phase: 'decorate',
  blueprint: () => [
    { type: 'fill',        tile: 'sand',  bounds: { edge_strip: 'south', depth: 8  }, region: 'beach_S' },
    { type: 'noise_patch',  tile: 'sand',  bounds: { edge_strip: 'south', depth: 12 }, threshold: 0.67, scale: 2.5, seed: 'bS_s' },
    { type: 'noise_patch',  tile: 'water', bounds: { edge_strip: 'south', depth: 7  }, over: 'sand', threshold: 0.60, scale: 3.5, seed: 'bS_w' },
    { type: 'fill',         tile: 'water', bounds: { edge_strip: 'south', depth: 3  } },
  ],
};

export const beachE: FeatureOperator = {
  id: 'beach_E',
  note: 'Ocean border on the east edge: water strip with noisy sand transition.',
  phase: 'decorate',
  blueprint: () => [
    { type: 'fill',        tile: 'sand',  bounds: { edge_strip: 'east', depth: 8  }, region: 'beach_E' },
    { type: 'noise_patch',  tile: 'sand',  bounds: { edge_strip: 'east', depth: 12 }, threshold: 0.67, scale: 2.5, seed: 'bE_s' },
    { type: 'noise_patch',  tile: 'water', bounds: { edge_strip: 'east', depth: 7  }, over: 'sand', threshold: 0.60, scale: 3.5, seed: 'bE_w' },
    { type: 'fill',         tile: 'water', bounds: { edge_strip: 'east', depth: 3  } },
  ],
};

export const beachW: FeatureOperator = {
  id: 'beach_W',
  note: 'Ocean border on the west edge: water strip with noisy sand transition.',
  phase: 'decorate',
  blueprint: () => [
    { type: 'fill',        tile: 'sand',  bounds: { edge_strip: 'west', depth: 8  }, region: 'beach_W' },
    { type: 'noise_patch',  tile: 'sand',  bounds: { edge_strip: 'west', depth: 12 }, threshold: 0.67, scale: 2.5, seed: 'bW_s' },
    { type: 'noise_patch',  tile: 'water', bounds: { edge_strip: 'west', depth: 7  }, over: 'sand', threshold: 0.60, scale: 3.5, seed: 'bW_w' },
    { type: 'fill',         tile: 'water', bounds: { edge_strip: 'west', depth: 3  } },
  ],
};

// Corner patches (diagonal ocean only). Slightly tighter depths since the
// patch is a square inset, not a full edge.
export const beachNE: FeatureOperator = {
  id: 'beach_NE',
  note: 'Ocean at the northeast corner only: noisy water+sand patch at NE.',
  phase: 'decorate',
  blueprint: () => [
    { type: 'fill',        tile: 'sand',  bounds: { corner_patch: 'NE', depth: 8 }, region: 'beach_NE' },
    { type: 'noise_patch',  tile: 'sand',  bounds: { corner_patch: 'NE', depth: 11 }, threshold: 0.65, scale: 2.5, seed: 'bNE_s' },
    { type: 'noise_patch',  tile: 'water', bounds: { corner_patch: 'NE', depth: 6  }, over: 'sand', threshold: 0.58, scale: 2.5, seed: 'bNE_w' },
    { type: 'fill',         tile: 'water', bounds: { corner_patch: 'NE', depth: 4  } },
  ],
};

export const beachNW: FeatureOperator = {
  id: 'beach_NW',
  note: 'Ocean at the northwest corner only: noisy water+sand patch at NW.',
  phase: 'decorate',
  blueprint: () => [
    { type: 'fill',        tile: 'sand',  bounds: { corner_patch: 'NW', depth: 8 }, region: 'beach_NW' },
    { type: 'noise_patch',  tile: 'sand',  bounds: { corner_patch: 'NW', depth: 11 }, threshold: 0.65, scale: 2.5, seed: 'bNW_s' },
    { type: 'noise_patch',  tile: 'water', bounds: { corner_patch: 'NW', depth: 6  }, over: 'sand', threshold: 0.58, scale: 2.5, seed: 'bNW_w' },
    { type: 'fill',         tile: 'water', bounds: { corner_patch: 'NW', depth: 4  } },
  ],
};

export const beachSE: FeatureOperator = {
  id: 'beach_SE',
  note: 'Ocean at the southeast corner only: noisy water+sand patch at SE.',
  phase: 'decorate',
  blueprint: () => [
    { type: 'fill',        tile: 'sand',  bounds: { corner_patch: 'SE', depth: 8 }, region: 'beach_SE' },
    { type: 'noise_patch',  tile: 'sand',  bounds: { corner_patch: 'SE', depth: 11 }, threshold: 0.65, scale: 2.5, seed: 'bSE_s' },
    { type: 'noise_patch',  tile: 'water', bounds: { corner_patch: 'SE', depth: 6  }, over: 'sand', threshold: 0.58, scale: 2.5, seed: 'bSE_w' },
    { type: 'fill',         tile: 'water', bounds: { corner_patch: 'SE', depth: 4  } },
  ],
};

export const beachSW: FeatureOperator = {
  id: 'beach_SW',
  note: 'Ocean at the southwest corner only: noisy water+sand patch at SW.',
  phase: 'decorate',
  blueprint: () => [
    { type: 'fill',        tile: 'sand',  bounds: { corner_patch: 'SW', depth: 8 }, region: 'beach_SW' },
    { type: 'noise_patch',  tile: 'sand',  bounds: { corner_patch: 'SW', depth: 11 }, threshold: 0.65, scale: 2.5, seed: 'bSW_s' },
    { type: 'noise_patch',  tile: 'water', bounds: { corner_patch: 'SW', depth: 6  }, over: 'sand', threshold: 0.58, scale: 2.5, seed: 'bSW_w' },
    { type: 'fill',         tile: 'water', bounds: { corner_patch: 'SW', depth: 4  } },
  ],
};
