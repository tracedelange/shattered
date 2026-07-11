import express from 'express';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWorld } from '../../server/game/mapgen/worldgen.js';
import type { CellOverride, ProgressionDir, ProgressionMode } from '../../server/game/mapgen/worldgen.js';
import { ZONE_BIOME_MAP, worldToZoneGraphYaml } from './serialize.js';
import { deriveSeeds, biomeAt, dangerAt, getLevelBand, LEVEL_BAND_COUNT, DEFAULT_FIELD_PARAMS, weirdnessAt } from '../../shared/worldgen/field.ts';
import type { FieldGenParams } from '../../shared/worldgen/field.ts';
import { buildAtlas } from '../../shared/worldgen/atlas.ts';
import { DANGER_RADIUS } from '../../shared/worldgen/config.ts';

// Parse the wild-gen noise/reshape params, falling back to the live game's
// shipped defaults (DEFAULT_FIELD_PARAMS) for anything not supplied. This lets
// the tool explore alternatives without touching shared/worldgen/config.ts —
// once a set of values reads well, hand-copy them into config.ts to ship them.
function parseFieldParams(q: Record<string, unknown>): FieldGenParams {
  const num = (key: keyof FieldGenParams, min: number, max: number) => {
    if (q[key] === undefined) return DEFAULT_FIELD_PARAMS[key];
    return Math.min(max, Math.max(min, Number(q[key])));
  };
  return {
    elevScale: num('elevScale', 10, 2000),
    climateScale: num('climateScale', 10, 2000),
    octaves: num('octaves', 1, 8),
    persistence: num('persistence', 0.1, 1.0),
    lacunarity: num('lacunarity', 1.0, 4.0),
    elevBias: num('elevBias', -0.5, 0.5),
    elevContrast: num('elevContrast', 0.5, 3.0),
    tempBias: num('tempBias', -0.5, 0.5),
    tempContrast: num('tempContrast', 0.5, 3.0),
    moistBias: num('moistBias', -0.5, 0.5),
    moistContrast: num('moistContrast', 0.5, 3.0),
    weirdScale: num('weirdScale', 5, 1000),
    weirdThreshold: num('weirdThreshold', 0, 1),
    spawnAnchorRadius: num('spawnAnchorRadius', 0, 4000),
    spawnAnchorStrength: num('spawnAnchorStrength', 0, 1),
    spawnAnchorTemp: num('spawnAnchorTemp', 0, 1),
    spawnAnchorMoist: num('spawnAnchorMoist', 0, 1),
    spawnAnchorElev: num('spawnAnchorElev', 0, 1),
    blendScale: num('blendScale', 2, 200),
    blendAmount: num('blendAmount', 0, 0.5),
  };
}

const WILD_BIOME_ORDER = ['ocean', 'tundra', 'plains', 'grassland', 'forest', 'swamp', 'desert', 'mountain', 'badlands'] as const;
const WILD_BIOME_INDEX: Record<string, number> = Object.fromEntries(WILD_BIOME_ORDER.map((b, i) => [b, i]));

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3004;

const app = express();
app.use(express.static(__dirname));
app.use('/shared', express.static(join(__dirname, '../shared')));

function parseWorldParams(query: Record<string, unknown>) {
  const seed        = String(query.seed        ?? 'terracity');
  const cols        = Math.min(1000, Math.max(1, Number(query.cols        ?? 10)));
  const rows        = Math.min(1000, Math.max(1, Number(query.rows        ?? 10)));
  const cellWidth   = Math.min(500, Math.max(10, Number(query.cellWidth  ?? 100)));
  const cellHeight  = Math.min(500, Math.max(10, Number(query.cellHeight ?? 100)));
  const scale       = Math.min(2,   Math.max(0.05, Number(query.scale        ?? 0.35)));
  const octaves     = Math.min(8,   Math.max(1,    Number(query.octaves       ?? 5)));
  const persistence = Math.min(1,   Math.max(0.1,  Number(query.persistence   ?? 0.5)));
  const lacunarity  = Math.min(4,   Math.max(1,    Number(query.lacunarity    ?? 2.0)));
  const rawBoundary   = String(query.boundaryStyle ?? 'ocean');
  const boundaryStyle = (rawBoundary === 'mountain' ? 'mountain' : 'ocean') as 'mountain' | 'ocean';
  const elevationBias     = Math.min(0.5, Math.max(-0.5, Number(query.elevationBias     ?? 0.26)));
  const elevationContrast = Math.min(3.0, Math.max(0.5,  Number(query.elevationContrast ?? 1.5)));
  const temperatureBias = Math.min(0.5, Math.max(-0.5, Number(query.temperatureBias ?? 0)));
  const temperatureContrast = Math.min(3.0, Math.max(0.5, Number(query.temperatureContrast ?? 1.7)));
  const moistureBias    = Math.min(0.5, Math.max(-0.5, Number(query.moistureBias    ?? 0)));
  const moistureContrast = Math.min(3.0, Math.max(0.5, Number(query.moistureContrast ?? 1.7)));
  const cityCount    = Math.min(500,  Math.max(0, Number(query.cityCount    ?? 3)));
  const villageCount = Math.min(2000, Math.max(0, Number(query.villageCount ?? 8)));

  const progressionMode: ProgressionMode = query.progressionMode === 'linear' ? 'linear' : 'radial';
  const dir = String(query.progressionDir ?? 'WE');
  const progressionDir: ProgressionDir = (['WE', 'EW', 'NS', 'SN'].includes(dir) ? dir : 'WE') as ProgressionDir;

  let overrides: CellOverride[] = [];
  if (query.overrides) {
    try {
      const parsed = JSON.parse(String(query.overrides));
      if (Array.isArray(parsed)) overrides = parsed;
    } catch { /* ignore malformed override payloads */ }
  }

  return { seed, cols, rows, cellWidth, cellHeight, scale, octaves, persistence, lacunarity, boundaryStyle, elevationBias, elevationContrast, temperatureBias, temperatureContrast, moistureBias, moistureContrast, cityCount, villageCount, progressionMode, progressionDir, overrides };
}

app.get('/api/world-gen', (req, res) => {
  const params = parseWorldParams(req.query as Record<string, unknown>);
  const world = generateWorld(params);
  res.json(world);
});

// Continuous wilderness field sampler — visualizes the pointwise field.ts +
// atlas.ts generation used in-game, NOT the zone-grid model above. Samples a
// square viewport of world-tile coords centered on (cx, cy) at `samples`
// resolution and returns two packed byte arrays (biome index, danger 0-255)
// plus any settlement gates that fall within the viewport.
app.get('/api/wild-gen', (req, res) => {
  const q = req.query as Record<string, unknown>;
  const seed = String(q.seed ?? 'silicon-soup');
  const cx = Number(q.cx ?? 0);
  const cy = Number(q.cy ?? 0);
  const radius = Math.min(100000, Math.max(4, Number(q.radius ?? 500)));
  const samples = Math.min(1024, Math.max(16, Number(q.samples ?? 512)));
  const fieldParams = parseFieldParams(q);

  const seeds = deriveSeeds(seed);
  const atlas = buildAtlas(seed);
  const step = (radius * 2) / samples;

  const biomeBytes = Buffer.alloc(samples * samples);
  const dangerBytes = Buffer.alloc(samples * samples);
  const weirdBytes = Buffer.alloc(samples * samples);

  for (let row = 0; row < samples; row++) {
    const wy = Math.round(cy - radius + row * step);
    for (let col = 0; col < samples; col++) {
      const wx = Math.round(cx - radius + col * step);
      const biome = biomeAt(wx, wy, seeds, fieldParams);
      const danger = dangerAt(wx, wy, seeds, atlas);
      const weird = weirdnessAt(wx, wy, seeds, fieldParams); // [-1, 1]
      const idx = row * samples + col;
      biomeBytes[idx] = WILD_BIOME_INDEX[biome] ?? 0;
      dangerBytes[idx] = Math.round(danger * 255);
      weirdBytes[idx] = Math.round((weird + 1) * 127.5);
    }
  }

  const settlements = atlas.settlements
    .filter((s) => Math.abs(s.worldX - cx) <= radius && Math.abs(s.worldY - cy) <= radius)
    .map((s) => ({ id: s.id, worldX: s.worldX, worldY: s.worldY, portalX: s.portalX, portalY: s.portalY }));

  res.json({
    seed, cx, cy, radius, samples, step,
    dangerRadius: atlas.dangerRadius,
    biomes: WILD_BIOME_ORDER,
    biomeBytes: biomeBytes.toString('base64'),
    dangerBytes: dangerBytes.toString('base64'),
    weirdBytes: weirdBytes.toString('base64'),
    settlements,
    fieldParams,
  });
});

// The live game's shipped noise/reshape constants (shared/worldgen/config.ts),
// so the tool's sliders default to what's actually running, not a hand-copied
// duplicate that can drift out of sync.
app.get('/api/wild-defaults', (_req, res) => {
  res.json(DEFAULT_FIELD_PARAMS);
});

// Level-band lookup for the danger legend (tier boundaries in tile-distance).
app.get('/api/wild-bands', (_req, res) => {
  const bands = Array.from({ length: LEVEL_BAND_COUNT }, (_, i) => {
    const d = i / LEVEL_BAND_COUNT;
    return { danger: d, ...getLevelBand(d), distance: Math.round(d * DANGER_RADIUS) };
  });
  res.json({ dangerRadius: DANGER_RADIUS, bandCount: LEVEL_BAND_COUNT, bands });
});

app.post('/api/export', (req, res) => {
  const params = parseWorldParams(req.query as Record<string, unknown>);
  const world = generateWorld(params);

  const zonesDir = join(__dirname, '../../world/zones');
  mkdirSync(zonesDir, { recursive: true });

  // Build a settlement lookup keyed by "x_y" for O(1) access per cell.
  const settlementAt = new Map<string, typeof world.settlements[number]>();
  for (const s of [...world.settlements, ...world.cities]) {
    settlementAt.set(`${s.gridX}_${s.gridY}`, s);
  }

  // Pre-compute zone ID for every non-ocean cell so connections can reference neighbors.
  const zoneIdAt = new Map<string, string>();
  for (const row of world.cells) {
    for (const cell of row) {
      if (cell.worldBiome === 'ocean') continue;
      const s = settlementAt.get(`${cell.gridX}_${cell.gridY}`);
      zoneIdAt.set(`${cell.gridX}_${cell.gridY}`, s
        ? `${s.type}_${cell.gridX}_${cell.gridY}`
        : `zone_${cell.gridX}_${cell.gridY}`);
    }
  }

  const DIRS: Array<[string, number, number]> = [
    ['north', 0, -1],
    ['south', 0,  1],
    ['west', -1,  0],
    ['east',  1,  0],
  ];

  const DIAGONALS: Array<[string, number, number, string, string]> = [
    ['NE',  1, -1, 'north', 'east'],
    ['NW', -1, -1, 'north', 'west'],
    ['SE',  1,  1, 'south', 'east'],
    ['SW', -1,  1, 'south', 'west'],
  ];

  function isOcean(gx: number, gy: number): boolean {
    const c = world.cells[gy]?.[gx];
    return !c || c.worldBiome === 'ocean';
  }

  const written: string[] = [];

  for (const row of world.cells) {
    for (const cell of row) {
      if (cell.worldBiome === 'ocean') continue;

      const id = zoneIdAt.get(`${cell.gridX}_${cell.gridY}`)!;
      const settlement = settlementAt.get(`${cell.gridX}_${cell.gridY}`);
      const zoneBiome = settlement
        ? 'village'
        : (ZONE_BIOME_MAP[cell.worldBiome] ?? 'forest');

      const connections: Record<string, string> = {};
      for (const [dir, dx, dy] of DIRS) {
        const neighborId = zoneIdAt.get(`${cell.gridX + dx}_${cell.gridY + dy}`);
        if (neighborId) connections[dir] = neighborId;
      }

      // Compute beach features.
      const features: string[] = [];
      const cardinalOcean = new Set<string>();

      const DIR_LETTER: Record<string, string> = { north: 'N', south: 'S', east: 'E', west: 'W' };
      for (const [dir, dx, dy] of DIRS) {
        if (isOcean(cell.gridX + dx, cell.gridY + dy)) {
          features.push(`beach_${DIR_LETTER[dir]}`);
          cardinalOcean.add(dir);
        }
      }

      for (const [diagKey, dx, dy, c1, c2] of DIAGONALS) {
        if (cardinalOcean.has(c1) || cardinalOcean.has(c2)) continue;
        if (isOcean(cell.gridX + dx, cell.gridY + dy)) {
          features.push(`beach_${diagKey}`);
        }
      }

      const zoneDef: Record<string, unknown> = {
        id,
        biome: zoneBiome,
        seed: `${world.seed}_${cell.gridX}_${cell.gridY}`,
        level_band: cell.levelBand,
        spawn_point: { focal: true },
        ...(Object.keys(connections).length ? { connections } : {}),
        ...(features.length ? { features } : {}),
      };
      if (settlement?.modifier) zoneDef['modifier'] = settlement.modifier;

      const filePath = join(zonesDir, `${id}.json`);
      writeFileSync(filePath, JSON.stringify(zoneDef, null, 2));
      written.push(id);
    }
  }

  res.json({ written, count: written.length });
});

// Single-file YAML export in the `zones:` graph schema (id/biome/seed/level_band/links).
app.post('/api/export-yaml', (req, res) => {
  const params = parseWorldParams(req.query as Record<string, unknown>);
  const world = generateWorld(params);

  // Shared serializer (also used by scripts/gen-forge-seed.ts) — emits river/
  // beach terrain features so UI exports match the regen script.
  const body = worldToZoneGraphYaml(world);
  const count = body.split('\n').filter((l) => l.includes('- id:')).length;

  const outPath = join(__dirname, '../../world/world.yaml');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body);

  res.json({ path: 'world/world.yaml', count });
});

app.listen(PORT, () => {
  console.log(`\n  World Gen  →  http://localhost:${PORT}\n`);
});
