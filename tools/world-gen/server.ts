import express from 'express';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWorld } from '../../server/game/mapgen/worldgen.js';
import type { WorldBiome } from '../../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3004;

const app = express();
app.use(express.static(__dirname));
app.use('/shared', express.static(join(__dirname, '../shared')));

// Maps WorldBiome → zone biome key in BIOME_REGISTRY. ocean has no zone.
const ZONE_BIOME_MAP: Partial<Record<WorldBiome, string>> = {
  forest:    'forest',
  grassland: 'grassland',
  plains:    'plains',
  tundra:    'tundra',
  desert:    'desert',
  swamp:     'swamp',
  mountain:  'mountain',
};

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
  const moistureBias    = Math.min(0.5, Math.max(-0.5, Number(query.moistureBias    ?? 0)));
  const cityCount    = Math.min(500,  Math.max(0, Number(query.cityCount    ?? 3)));
  const villageCount = Math.min(2000, Math.max(0, Number(query.villageCount ?? 8)));
  return { seed, cols, rows, cellWidth, cellHeight, scale, octaves, persistence, lacunarity, boundaryStyle, elevationBias, elevationContrast, temperatureBias, moistureBias, cityCount, villageCount };
}

app.get('/api/world-gen', (req, res) => {
  const params = parseWorldParams(req.query as Record<string, unknown>);
  const world = generateWorld(params);
  res.json(world);
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

app.listen(PORT, () => {
  console.log(`\n  World Gen  →  http://localhost:${PORT}\n`);
});
