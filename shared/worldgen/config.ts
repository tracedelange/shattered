// Continuous-wilderness configuration — the single source of compile-time
// constants shared by server (collision, spawn, streaming) and client (render).
// See docs/rework.md §12. Values are tunable but must stay identical on both
// sides or the determinism contract (R8.7) breaks.

/** Reserved pseudo-zone id for the open wilderness. When an entity's
 *  position.zone === WILD, its (x,y) are SIGNED world tile coords (not a
 *  0-based grid). Every other zone id is an enclosed grid zone as before. */
export const WILD = 'wild';

/** Chunk = N×N tiles. One Socket.IO room per chunk (R8.1). */
export const CHUNK_SIZE = 32;

/** Region cell = M×M tiles (= 8×8 chunks). Coarse semantic grid (R3.1). */
export const REGION_CELL_SIZE = 256;

/** Chunks loaded around the player's current chunk (Chebyshev radius). */
export const WILD_LOAD_RADIUS = 2;

/** Distance from origin (tiles) at which danger reaches its tier-5 ceiling and
 *  plateaus — coordinate limits never produce undefined danger (R4.2/R5.5). */
export const DANGER_RADIUS = 4000;

/** Amplitude of terrain danger-wobble relative to the radial trend (R5.7).
 *  Too low → radially symmetric/destinationless; too high → safe corridors
 *  trivialize distance. Starting tuning value. */
export const WOBBLE_AMP = 0.35;

/** Default world seed when none is supplied. */
export const DEFAULT_WORLD_SEED = 'silicon-soup';

// ── Field thresholds (elevation is normalized [0,1)) ─────────────────────────
/** Below this elevation reads as standing water (lakes/seas), soft terrain. */
export const SEA_LEVEL = 0.30;
/** Above this elevation reads as mountain/rock. */
export const MOUNTAIN_LEVEL = 0.78;

// ── Noise feature scales (tiles) — bigger = larger, smoother features ────────
export const ELEV_SCALE = 220;
export const CLIMATE_SCALE = 420;   // temperature + moisture
export const RIVER_SCALE = 160;     // cosmetic river ribbons
export const DANGER_WOBBLE_SCALE = 320;
export const TREE_SCALE = 14;       // fine scatter for forest/grassland trees

export const NOISE_OCTAVES = 4;
export const NOISE_PERSISTENCE = 0.5;
export const NOISE_LACUNARITY = 2;

// ── Field reshaping ──────────────────────────────────────────────────────────
// Raw octave noise clusters near 0.5. Contrast > 1 stretches values toward the
// extremes before biome classification (countering a grassland/plains
// monoculture); bias shifts the global mean. Mirrors the zone-grid generator's
// elevation/temperature/moisture bias+contrast knobs (server/game/mapgen/worldgen.ts).
export const ELEVATION_BIAS = 0;
export const ELEVATION_CONTRAST = 1.5;
export const TEMPERATURE_BIAS = 0;
export const TEMPERATURE_CONTRAST = 1.7;
export const MOISTURE_BIAS = 0;
export const MOISTURE_CONTRAST = 1.7;

// ── Weirdness ────────────────────────────────────────────────────────────────
// A fourth noise field, folded into a triangle wave so it produces multiple
// peaks/valleys as you cross the world rather than one smooth gradient — this
// is what lets "weird" terrain cut across climate boundaries instead of
// correlating with them. Sampled at a noticeably higher frequency (smaller
// scale) than elevation for the same reason (see docs write-up). abs() past
// WEIRDNESS_THRESHOLD overrides the climate-picked biome with `badlands`.
export const WEIRDNESS_SCALE = Math.round(ELEV_SCALE / 3);
export const WEIRDNESS_THRESHOLD = 0.55;

// ── Spawn climate anchor ─────────────────────────────────────────────────────
// Pulls temperature/moisture toward a temperate (grassland/forest) target near
// the origin, fading to pure noise by SPAWN_ANCHOR_RADIUS, so the starting area
// reads thematically consistent while distant terrain stays fully varied
// (tundra/desert/swamp still exist, just not right at spawn).
export const SPAWN_ANCHOR_RADIUS = 600;
export const SPAWN_ANCHOR_STRENGTH = 0.85;
export const SPAWN_ANCHOR_TEMP = 0.35;   // mid of the plains/grassland/forest temp band [0.25, 0.45)
export const SPAWN_ANCHOR_MOIST = 0.5;   // grassland/forest boundary — noise variance still yields both
export const SPAWN_ANCHOR_ELEV = 0.5;    // walkable mid-range, well clear of SEA_LEVEL/MOUNTAIN_LEVEL

// ── Biome-boundary blending ──────────────────────────────────────────────────
// Jitters temp/moisture by a small amount (patchy, higher-frequency noise)
// right before the biome table lookup, so classification flips back and forth
// near a boundary instead of drawing one hard line — reads as a mottled
// transition band (e.g. forest/desert) a few dozen tiles wide.
export const BIOME_BLEND_SCALE = 8;
export const BIOME_BLEND_AMOUNT = 0.05;

// ── Grassland tree clumping ──────────────────────────────────────────────────
// Grassland trees aren't a single uniform-density scatter: a coarse mask picks
// out clump zones (small groves) that fade into sparse individual trees
// everywhere else, so grassland reads as "mostly open, occasional clumps"
// rather than an even sprinkle. Plains stay a flat, sparser scatter — no
// clumps — to read more open than grassland.
export const GRASSLAND_CLUMP_SCALE = 90;      // patch size (tiles) for clump zones
export const GRASSLAND_CLUMP_LO = 0.55;       // mask value where a clump starts fading in
export const GRASSLAND_CLUMP_HI = 0.68;       // mask value where a clump is fully dense
export const GRASSLAND_SPARSE_DENSITY = 0.02; // outside clumps: scattered individuals
export const GRASSLAND_CLUMP_DENSITY = 0.32;  // inside a clump: near-forest thickness
export const PLAINS_TREE_DENSITY = 0.015;     // flat, sparse, no clumps — plains stay open
