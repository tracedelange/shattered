import type { GenOp } from '../../../../shared/types.ts';
import type { PipelineEntry } from '../biomes/index.ts';

// ─── FeatureDef ───────────────────────────────────────────────────────────────

/**
 * A self-contained map feature. The blueprint is a fully engine-driven set of
 * pipeline entries — no coordinates. Placement is handled via `scatter_sites`,
 * `placement: 'internal' | 'perimeter'`, `at_tag`, etc.
 *
 * The LLM selects features by id; the engine resolves all positioning.
 */
export interface FeatureDef {
  id: string;
  /** One or two sentences describing what this feature adds to a zone.
   *  Written for an LLM selecting features for a zone. */
  note: string;
  /** Fully self-contained pipeline entries. Run after the biome pipeline. */
  blueprint: PipelineEntry[];
}

// ─── Registry ─────────────────────────────────────────────────────────────────

import { fountain }      from './fountain.ts';
import { well }          from './well.ts';
import { marketSquare }  from './market_square.ts';
import { campfirePit }   from './campfire_pit.ts';
import { ruinedShrine }  from './ruined_shrine.ts';
import { guardTower }    from './guard_tower.ts';
import { cityWalls }     from './city_walls.ts';
import { wallGates }     from './wall_gates.ts';

export const FEATURE_REGISTRY: Record<string, FeatureDef> = {
  fountain,
  well,
  market_square:  marketSquare,
  campfire_pit:   campfirePit,
  ruined_shrine:  ruinedShrine,
  guard_tower:    guardTower,
  city_walls:     cityWalls,
  wall_gates:     wallGates,
};

// ─── Resolution ───────────────────────────────────────────────────────────────

import { mulberry32 } from '../rng.ts';
import { resolvePipelineEntry } from '../biomes/index.ts';

/**
 * Resolves a list of feature ids to a flat GenOp sequence.
 * Unknown ids are warned and skipped. Uses a seed derived from the zone seed
 * so feature variance is deterministic and separate from the biome pipeline.
 */
export function resolveFeatureOps(featureIds: string[], zoneSeed: number): GenOp[] {
  const rng = mulberry32(zoneSeed ^ 0xfea70235);
  const ops: GenOp[] = [];
  for (const id of featureIds) {
    const def = FEATURE_REGISTRY[id];
    if (!def) { console.warn(`[features] Unknown feature '${id}' — skipped.`); continue; }
    for (const entry of def.blueprint) {
      ops.push(...resolvePipelineEntry(entry, rng));
    }
  }
  return ops;
}
