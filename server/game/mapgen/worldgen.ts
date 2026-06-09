import { octaveNoise, mulberry32, resolveSeed } from './rng.js';
import type {
  BoundaryStyle, LevelBand, SettlementModifier,
  WorldBiome, WorldCell, WorldCellTag, WorldDef, WorldSettlement,
} from '../../../shared/types.js';

// Whittaker-style biome table: temperature (0=cold → 1=hot) × moisture (0=dry → 1=wet).
const BIOME_TABLE: [number, number, number, number, WorldBiome][] = [
  [0.0, 0.25, 0.0, 1.0, 'tundra'],
  [0.25, 0.45, 0.0, 0.3, 'plains'],
  [0.25, 0.45, 0.3, 0.6, 'grassland'],
  [0.25, 0.45, 0.6, 1.0, 'forest'],
  [0.45, 0.65, 0.0, 0.25, 'desert'],
  [0.45, 0.65, 0.25, 0.5, 'plains'],
  [0.45, 0.65, 0.5, 0.75, 'grassland'],
  [0.45, 0.65, 0.75, 1.0, 'swamp'],
  [0.65, 1.0,  0.0, 0.3, 'desert'],
  [0.65, 1.0,  0.3, 0.6, 'plains'],
  [0.65, 1.0,  0.6, 0.8, 'grassland'],
  [0.65, 1.0,  0.8, 1.0, 'swamp'],
];

function classifyBiome(temp: number, moisture: number, elevation: number): WorldBiome {
  if (elevation < 0.25) return 'ocean';
  if (elevation > 0.82) return 'mountain';
  for (const [tMin, tMax, mMin, mMax, biome] of BIOME_TABLE) {
    if (temp >= tMin && temp < tMax && moisture >= mMin && moisture < mMax) return biome;
  }
  return 'plains';
}

function getLevelBand(danger: number): LevelBand {
  if (danger < 0.2) return { tier: 1, minLevel: 1,  maxLevel: 5  };
  if (danger < 0.4) return { tier: 2, minLevel: 5,  maxLevel: 10 };
  if (danger < 0.6) return { tier: 3, minLevel: 10, maxLevel: 20 };
  if (danger < 0.8) return { tier: 4, minLevel: 20, maxLevel: 35 };
  return              { tier: 5, minLevel: 35, maxLevel: 50 };
}

function applyBoundaryMask(
  rawElevation: number,
  col: number, row: number,
  cols: number, rows: number,
  noiseScale: number,
  coastSeed: number,
  octaves: number, persistence: number, lacunarity: number,
  boundaryStyle: BoundaryStyle,
): number {
  const nx = (col / cols) * 2 - 1;
  const ny = (row / rows) * 2 - 1;
  const dist = Math.pow(
    Math.pow(Math.abs(nx), 4) + Math.pow(Math.abs(ny), 4),
    0.25,
  );
  const coastNoise = 0.15 * octaveNoise(col * 0.5, row * 0.5, octaves, noiseScale, persistence, lacunarity, coastSeed);
  const mask = Math.max(0, 1 - dist + coastNoise);

  if (boundaryStyle === 'ocean') {
    // Force outermost ring to elevation 0 so the border is always ocean.
    if (col === 0 || col === cols - 1 || row === 0 || row === rows - 1) return 0;
    return rawElevation * mask;
  }
  // Mountain: lerp from guaranteed land range at center → mountain range at edges.
  // landElev ∈ [0.36, 0.82] keeps center above the ocean threshold (<0.35).
  // mountainElev ∈ [0.82, 1.0] pushes edges above the mountain threshold (>0.82).
  const landElev     = 0.36 + rawElevation * 0.46;
  const mountainElev = 0.82 + rawElevation * 0.18;
  return landElev * mask + mountainElev * (1 - mask);
}

// BFS outward from every coast cell (non-ocean adjacent to ocean).
// Depth is normalized to [0,1], noise-jittered, then mapped to level bands.
// Falls back to outermost non-ocean ring for mountain mode (no ocean present).
function assignDangerByCoastDistance(
  cells: WorldCell[][], cols: number, rows: number,
  dangerSeed: number, noiseScale: number,
): void {
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
  const dist: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  const queue: [number, number][] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r][c].worldBiome === 'ocean') continue;
      const isCoast = DIRS.some(([dr, dc]) => {
        const n = cells[r + dr]?.[c + dc];
        return n === undefined || n.worldBiome === 'ocean';
      });
      if (isCoast) { dist[r][c] = 0; queue.push([r, c]); }
    }
  }

  // Mountain mode fallback: seed from outermost non-ocean cells.
  if (queue.length === 0) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if ((r === 0 || r === rows - 1 || c === 0 || c === cols - 1) && cells[r][c].worldBiome !== 'ocean') {
          dist[r][c] = 0;
          queue.push([r, c]);
        }
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const [r, c] = queue[head++];
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (dist[nr][nc] !== -1 || cells[nr][nc].worldBiome === 'ocean') continue;
      dist[nr][nc] = dist[r][c] + 1;
      queue.push([nr, nc]);
    }
  }

  let maxDist = 1;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (dist[r][c] > maxDist) maxDist = dist[r][c];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r][c];
      const d = dist[r][c];
      if (d < 0) { cell.danger = 0; cell.levelBand = getLevelBand(0); continue; }
      // Jitter the normalized depth with low-frequency noise to break up concentric rings.
      const normalized = d / maxDist;
      const jitter = 0.18 * (octaveNoise(c, r, 3, noiseScale * 0.6, 0.5, 2.0, dangerSeed) * 2 - 1);
      const danger = Math.max(0, Math.min(1, normalized + jitter));
      cell.danger = danger;
      cell.levelBand = getLevelBand(danger);
    }
  }
}

const CITY_BIOMES    = new Set<WorldBiome>(['grassland', 'plains', 'forest']);
const VILLAGE_BIOMES = new Set<WorldBiome>(['grassland', 'plains', 'forest', 'swamp', 'tundra']);

const MIN_VILLAGE_SPACING      = 6;
const MIN_CITY_SPACING         = 15;
const MIN_CITY_VILLAGE_SPACING = 6;

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function isVillageEligible(cell: WorldCell): boolean {
  return VILLAGE_BIOMES.has(cell.worldBiome);
}

function scoreCityCandidate(cell: WorldCell): number {
  if (!CITY_BIOMES.has(cell.worldBiome)) return -1;
  if (cell.levelBand.tier > 2) return -1;
  let score = 0;
  score += 1 - Math.abs(cell.elevation - 0.5) * 2;
  score += (1 - cell.danger) * 1.2;
  return score;
}

function rollVillageModifier(cell: WorldCell, rng: () => number): SettlementModifier | undefined {
  if (cell.levelBand.tier >= 3 && rng() < 0.5) return rng() < 0.6 ? 'ruined' : 'contested';
  if (cell.levelBand.tier <= 1 && rng() < 0.15) return rng() < 0.5 ? 'deserted' : 'hidden';
  if (rng() < 0.08) return rng() < 0.5 ? 'cursed' : 'blessed';
  return undefined;
}

function placeSettlements(
  cells: WorldCell[][],
  cols: number,
  rows: number,
  cityCount: number,
  villageCount: number,
  rng: () => number,
): { settlements: WorldSettlement[]; cities: WorldSettlement[] } {
  const villages: WorldSettlement[] = [];
  const cities: WorldSettlement[] = [];

  // ── Villages (random shuffle + greedy spacing — no score bias) ───────────
  const villageCandidates = cells.flat().filter(isVillageEligible);
  for (let i = villageCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [villageCandidates[i], villageCandidates[j]] = [villageCandidates[j], villageCandidates[i]];
  }

  for (const cell of villageCandidates) {
    if (villages.length >= villageCount) break;
    const tooClose = villages.some(v => chebyshev(cell.gridX, cell.gridY, v.gridX, v.gridY) < MIN_VILLAGE_SPACING);
    if (!tooClose) {
      villages.push({
        type: 'village',
        gridX: cell.gridX,
        gridY: cell.gridY,
        worldBiome: cell.worldBiome,
        modifier: rollVillageModifier(cell, rng),
      });
    }
  }

  // ── Cities (scored, post-village pass) ───────────────────────────────────
  const cityCandidates = cells.flat()
    .map(c => ({ cell: c, score: scoreCityCandidate(c) }))
    .filter(({ score, cell }) => score >= 0 && cell.gridX < cols && cell.gridY < rows)
    .sort((a, b) => b.score - a.score);

  for (const { cell } of cityCandidates) {
    if (cities.length >= cityCount) break;
    const tooCloseToCity    = cities.some(c => chebyshev(cell.gridX, cell.gridY, c.gridX, c.gridY) < MIN_CITY_SPACING);
    const tooCloseToVillage = villages.some(v => chebyshev(cell.gridX, cell.gridY, v.gridX, v.gridY) < MIN_CITY_VILLAGE_SPACING);
    if (!tooCloseToCity && !tooCloseToVillage) {
      cities.push({
        type: 'city',
        gridX: cell.gridX,
        gridY: cell.gridY,
        worldBiome: cell.worldBiome,
      });
    }
  }

  return { settlements: villages, cities };
}

export interface WorldGenParams {
  seed: string;
  cols?: number;
  rows?: number;
  cellWidth?: number;
  cellHeight?: number;
  scale?: number;
  octaves?: number;
  persistence?: number;
  lacunarity?: number;
  boundaryStyle?: BoundaryStyle;
  elevationBias?: number;
  elevationContrast?: number;
  temperatureBias?: number;
  moistureBias?: number;
  cityCount?: number;
  villageCount?: number;
}

export function generateWorld(params: WorldGenParams): WorldDef {
  const {
    seed,
    cols          = 50,
    rows          = 50,
    cellWidth     = 100,
    cellHeight    = 100,
    scale         = 0.35,
    octaves       = 5,
    persistence   = 0.5,
    lacunarity    = 2.0,
    boundaryStyle     = 'ocean',
    elevationBias     = 0.26,
    elevationContrast = 1.5,
    temperatureBias   = -0.17,
    moistureBias      = 0.07,
    villageCount      = 8,
  } = params;

  const numericSeed   = resolveSeed(seed);
  const tempSeed      = numericSeed;
  const moistSeed     = (numericSeed   * 1664525 + 1013904223) >>> 0;
  const elevationSeed = (moistSeed     * 1664525 + 1013904223) >>> 0;
  const coastSeed     = (elevationSeed * 1664525 + 1013904223) >>> 0;
  const dangerSeed    = (coastSeed     * 1664525 + 1013904223) >>> 0;
  // Separate RNG stream for placement so noise params don't affect settlement positions.
  const placementRng  = mulberry32((dangerSeed * 1664525 + 1013904223) >>> 0);

  // Roll city count from seed if not provided.
  const cityCount = params.cityCount ?? (1 + Math.floor(placementRng() * 3));

  const noiseScale = Math.max(cols, rows) * scale;
  const cells: WorldCell[][] = [];

  for (let row = 0; row < rows; row++) {
    const rowArr: WorldCell[] = [];
    for (let col = 0; col < cols; col++) {
      const temperature  = Math.max(0, Math.min(1, octaveNoise(col, row, octaves, noiseScale, persistence, lacunarity, tempSeed)  + temperatureBias));
      const moisture     = Math.max(0, Math.min(1, octaveNoise(col, row, octaves, noiseScale, persistence, lacunarity, moistSeed) + moistureBias));
      const rawElevation  = octaveNoise(col, row, octaves, noiseScale, persistence, lacunarity, elevationSeed);
      const contrastElev  = Math.max(0, Math.min(1, (rawElevation - 0.5) * elevationContrast + 0.5));
      const maskedElev    = applyBoundaryMask(contrastElev, col, row, cols, rows, noiseScale, coastSeed, octaves, persistence, lacunarity, boundaryStyle);
      const elevation     = Math.max(0, Math.min(1, maskedElev + elevationBias));
      const worldBiome    = classifyBiome(temperature, moisture, elevation);
      // danger/levelBand are filled in by assignDangerByCoastDistance after the cell loop.
      rowArr.push({
        gridX: col, gridY: row,
        worldBiome,
        seed: `${seed}_${col}_${row}`,
        width: cellWidth, height: cellHeight,
        temperature, moisture, elevation, danger: 0, levelBand: getLevelBand(0),
        tags: [],
      });
    }
    cells.push(rowArr);
  }

  // Assign danger and level bands based on BFS depth from coastline.
  assignDangerByCoastDistance(cells, cols, rows, dangerSeed, noiseScale);

  // Beach tag pass: any non-ocean cell with at least one ocean cardinal neighbor gets the 'beach' tag.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = cells[row][col];
      if (cell.worldBiome === 'ocean') continue;
      const neighbors = [
        cells[row - 1]?.[col],
        cells[row + 1]?.[col],
        cells[row]?.[col - 1],
        cells[row]?.[col + 1],
      ];
      if (neighbors.some(n => n?.worldBiome === 'ocean')) {
        (cell.tags as WorldCellTag[]).push('beach');
      }
    }
  }

  const { settlements, cities } = placeSettlements(
    cells, cols, rows, cityCount, villageCount, placementRng,
  );

  return { seed, cols, rows, cellWidth, cellHeight, boundaryStyle, cells, settlements, cities };
}
