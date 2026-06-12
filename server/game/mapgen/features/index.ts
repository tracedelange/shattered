import type { GenOp } from '../../../../shared/types.ts';

// ─── Feature operators ─────────────────────────────────────────────────────────
//
// A feature operator is the single, unified concept for a named piece of zone
// content (a fountain, a market, a guard tower, a beach). It replaces the old
// trio of FeatureDef + BiomeConstraint + module: one registry, one toggle, one
// placement pass.
//
// An operator is a coordinate-free, optionally-parameterised bundle of ops with
// a placement PHASE. The phase gives coarse ordering so reservations land before
// the structures that must avoid them:
//
//   reserve  → claims space before buildings scatter (fountain/market discs)
//   build    → structural placement that competes for space (towers, walls, gates)
//   decorate → cosmetic placement after structure (the fountain basin, beaches)
//
// Within a phase, ops run in the order their features are listed. Biome-default
// features, zone-added features, and Implementor post-op features all resolve
// through this same pass (see resolveBiomeGenOps + the post_ops decorate path).

export type FeaturePhase = 'reserve' | 'build' | 'decorate';

/** A tunable numeric parameter on a feature operator (mirrors OpParam). */
export interface FeatureParam {
  field: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

/** Ops grouped by placement phase. An operator returning a bare GenOp[] has them
 *  assigned to its declared `phase` (default 'build'). */
export interface PhasedOps {
  reserve?: GenOp[];
  build?: GenOp[];
  decorate?: GenOp[];
}

export interface FeatureOperator {
  id: string;
  /** One or two sentences for an LLM selecting features for a zone. */
  note: string;
  /** Declared tunables. Resolved values (defaults overlaid with ref overrides)
   *  are passed to `blueprint`. Most operators declare none. */
  params?: FeatureParam[];
  /** Phase for ops returned as a bare array. Default 'build'. */
  phase?: FeaturePhase;
  /** Produces the operator's ops from resolved params. Coordinate-free; every
   *  placement is resolved by the engine against the live grid. */
  blueprint: (params: Record<string, number>) => GenOp[] | PhasedOps;
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
import { beachN, beachS, beachE, beachW, beachNE, beachNW, beachSE, beachSW } from './ocean_border.ts';

export const FEATURE_REGISTRY: Record<string, FeatureOperator> = {
  fountain,
  well,
  market_square:  marketSquare,
  campfire_pit:   campfirePit,
  ruined_shrine:  ruinedShrine,
  guard_tower:    guardTower,
  city_walls:     cityWalls,
  wall_gates:     wallGates,
  beach_N:  beachN,
  beach_S:  beachS,
  beach_E:  beachE,
  beach_W:  beachW,
  beach_NE: beachNE,
  beach_NW: beachNW,
  beach_SE: beachSE,
  beach_SW: beachSW,
};

// ─── Resolution ───────────────────────────────────────────────────────────────

/** A reference to a feature operator: its id plus optional param overrides. */
export interface FeatureRef {
  id: string;
  params?: Record<string, number>;
}

/** Resolved ops bucketed by phase, ready to splice into the zone op list. */
export interface ResolvedFeatures {
  reserve: GenOp[];
  build: GenOp[];
  decorate: GenOp[];
}

/** Merge an operator's param defaults with a ref's overrides. */
function resolveParams(
  declared: FeatureParam[] | undefined,
  overrides: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of declared ?? []) out[p.field] = p.default;
  if (overrides) for (const [k, v] of Object.entries(overrides)) out[k] = v;
  return out;
}

/** True for an op whose primary painted tile is water — deferred to the end of
 *  the decorate phase so adjacent beaches don't clobber each other's water at
 *  corners (preserves the old resolveFeatureOps ordering). */
function isWaterOp(op: GenOp): boolean {
  return (op as { tile?: string }).tile === 'water';
}

/**
 * Resolves a list of feature refs to phase-bucketed ops. Unknown ids are warned
 * and skipped. Within the decorate phase, water-tile ops are deferred after all
 * non-water ops (beach-corner safety).
 */
export function resolveFeatureOperators(refs: FeatureRef[]): ResolvedFeatures {
  const out: ResolvedFeatures = { reserve: [], build: [], decorate: [] };
  for (const ref of refs) {
    const op = FEATURE_REGISTRY[ref.id];
    if (!op) { console.warn(`[features] Unknown feature '${ref.id}' — skipped.`); continue; }
    const params = resolveParams(op.params, ref.params);
    const result = op.blueprint(params);
    const phased: PhasedOps = Array.isArray(result) ? { [op.phase ?? 'build']: result } : result;
    if (phased.reserve)  out.reserve.push(...phased.reserve);
    if (phased.build)    out.build.push(...phased.build);
    if (phased.decorate) out.decorate.push(...phased.decorate);
  }
  out.decorate.sort((a, b) => (isWaterOp(a) ? 1 : 0) - (isWaterOp(b) ? 1 : 0));
  return out;
}
