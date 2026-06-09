// generateZone — primary entry point for biome-driven zone generation.
//
// Accepts a biome name and optional seed. Resolves the biome's operator
// pipeline and returns the full ZoneGrid extended with biome metadata.
//
// Design contract:
//   generateZone({ biome, seed? }) → GenerateZoneResult
//   Same inputs → identical geometry (fully deterministic).

import { generateZoneGrid, type ZoneGrid } from './index.ts';
import {
  BIOME_REGISTRY,
  resolvePipeline,
  resolveConstraintOps,
  mixZoneSeed,
  type BiomeConstraint,
  type BiomePalette,
  type BiomeTag,
} from './biomes/index.ts';
import { resolveSeed } from './rng.ts';
import type { ZoneDef } from '../../../shared/types.ts';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GenerateZoneRequest {
  biome: string;
  seed?: number | string;
}

export interface ZoneMetadata {
  entrance: { x: number; y: number } | null;
  centroid: { x: number; y: number };
  tags: BiomeTag[];
  palette: BiomePalette;
  constraints: BiomeConstraint[];
  spawnWeights: Record<string, number>;
  featureWeights: Record<string, number>;
}

export interface GenerateZoneResult extends ZoneGrid {
  biomeId: string;
  metadata: ZoneMetadata;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class BiomeNotFoundError extends Error {
  constructor(id: string) {
    super(
      `Biome '${id}' is not registered. ` +
      `Available: ${Object.keys(BIOME_REGISTRY).sort().join(', ')}`,
    );
    this.name = 'BiomeNotFoundError';
  }
}

export class RequiredConstraintError extends Error {
  constructor(feature: string, anchor: string) {
    super(`Required biome constraint unsatisfied: feature '${feature}' at anchor '${anchor}'.`);
    this.name = 'RequiredConstraintError';
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function generateZone(req: GenerateZoneRequest): GenerateZoneResult {
  const { biome: biomeId, seed: rawSeed } = req;

  const biomeDef = BIOME_REGISTRY[biomeId];
  if (!biomeDef) throw new BiomeNotFoundError(biomeId);

  const numericSeed: number = rawSeed !== undefined
    ? resolveSeed(rawSeed)
    : resolveSeed(`${biomeId}:default`);

  const pipelineOps  = resolvePipeline(biomeDef.pipeline, numericSeed);
  const constraintOps = resolveConstraintOps(biomeDef.defaultConstraints, numericSeed);
  const ops = mixZoneSeed([...pipelineOps, ...constraintOps], numericSeed);

  const zoneId = `biome_${biomeId}_${numericSeed.toString(16)}`;
  const zoneDef: ZoneDef = {
    id: zoneId,
    tileset: biomeDef.tileset,
    width: biomeDef.width,
    height: biomeDef.height,
    default_tile: biomeDef.defaultTile,
    ops,
  };

  const grid = generateZoneGrid(zoneDef);

  const regionNames = new Set(Object.keys(grid.bounds));
  for (const c of biomeDef.defaultConstraints) {
    if (c.priority !== 'required') continue;
    const satisfied =
      regionNames.size === 0 ||
      [...regionNames].some(r => r.includes(c.feature) || c.feature.includes(r));
    if (!satisfied) {
      console.warn(
        `[biome] required constraint unsatisfied: feature '${c.feature}' ` +
        `at anchor '${c.anchor}' (no matching region found).`,
      );
    }
  }

  const entrance = grid.autoConnectionPortals[0]?.at ?? grid.focal ?? null;
  const centroid = grid.focal ?? {
    x: Math.floor(biomeDef.width / 2),
    y: Math.floor(biomeDef.height / 2),
  };

  return {
    ...grid,
    biomeId,
    metadata: {
      entrance,
      centroid,
      tags:           biomeDef.tags,
      palette:        biomeDef.palette,
      constraints:    biomeDef.defaultConstraints,
      spawnWeights:   biomeDef.spawnWeights,
      featureWeights: biomeDef.featureWeights,
    },
  };
}
