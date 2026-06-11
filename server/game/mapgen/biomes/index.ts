// Biome system — deterministic, composable zone generation envelopes.
//
// Architecture:
//   BiomeDef + seed → resolveBiomeGenOps (basePipeline + phased features) → GenOp[]
//   GenOp[] → generateZoneGrid (index.ts) → ZoneGrid

import type { GenOp, ZoneSpawn } from '../../../../shared/types.ts';
import { mulberry32, resolveSeed } from '../rng.ts';
import {
  resolveFeatureOperators,
  type FeatureRef,
} from '../features/index.ts';

import { village }   from './village.ts';
import { dungeon }   from './dungeon.ts';
import { sewer }     from './sewer.ts';
import { forest }    from './forest.ts';
import { cave }      from './cave.ts';
import { plains }    from './plains.ts';
import { grassland } from './grassland.ts';
import { tundra }    from './tundra.ts';
import { desert }    from './desert.ts';
import { swamp }     from './swamp.ts';
import { mountain }  from './mountain.ts';

// ─── Tags ─────────────────────────────────────────────────────────────────────

export type BiomeTag = 'indoor' | 'outdoor' | 'underground' | 'aquatic' | 'vertical';

// ─── Palette ──────────────────────────────────────────────────────────────────

export interface BiomePalette {
  floor: string;
  wall: string;
  accent: string;
}

// ─── Feature priority ──────────────────────────────────────────────────────────

/** Intent strength for a biome's default feature. Surfaced to the LLM; does not
 *  gate placement (every listed feature is on unless a zone turns it off). */
export type ConstraintPriority = 'required' | 'preferred' | 'optional';

// ─── Params ───────────────────────────────────────────────────────────────────

/** A tunable numeric parameter on a basePipeline entry, rendered as a slider in the workbench. */
export interface OpParam {
  field: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

/** A zone-level numeric parameter (e.g. inset), not tied to a single op. */
export interface ZoneParam {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

// ─── Pipeline entries ─────────────────────────────────────────────────────────
//
// basePipeline entries describe the biome's always-on terrain skeleton (ground
// fill, tree fringe, the building/road core). Content that can be toggled or
// parameterised per-zone is a feature operator (see ../features), not a pipeline
// entry. `id` + `params` expose a basePipeline op's numeric knobs to the
// workbench and to per-zone opParams overrides.

export type PipelineEntry =
  | { kind: 'fixed';         op: GenOp;                                         id?: string; params?: OpParam[] }
  | { kind: 'shuffle_group'; ops: GenOp[];                                       id?: string; params?: OpParam[] }
  | { kind: 'weighted';      choices: Array<{ weight: number; op: GenOp }>;      id?: string; params?: OpParam[] };

// ─── Biome definition ─────────────────────────────────────────────────────────

/** A biome's reference to a feature operator: its id, default param overrides,
 *  and an intent priority surfaced to the LLM. */
export interface BiomeFeatureRef {
  id: string;
  params?: Record<string, number>;
  priority?: ConstraintPriority;
  note?: string;
}

export interface BiomeDef {
  id: string;
  tileset: string;
  tags: BiomeTag[];
  palette: BiomePalette;
  /** Always-on terrain skeleton. */
  basePipeline: PipelineEntry[];
  /** Feature operators this biome includes by default (placed via the phased pass). */
  features: BiomeFeatureRef[];
  zoneParams?: ZoneParam[];
  spawnWeights: Record<string, number>;
  /** Post-ops appended to every zone of this biome (after zone-specific post_ops). */
  defaultPostOps?: GenOp[];
  /** Spawns appended to every zone of this biome (after zone-specific spawns). */
  defaultSpawns?: ZoneSpawn[];
  defaultTile: string;
  width: number;
  height: number;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const BIOME_REGISTRY: Record<string, BiomeDef> = {
  village,
  dungeon,
  sewer,
  forest,
  cave,
  plains,
  grassland,
  tundra,
  desert,
  swamp,
  mountain,
};

// ─── Pipeline resolution ──────────────────────────────────────────────────────

export function resolvePipelineEntry(entry: PipelineEntry, rng: () => number): GenOp[] {
  switch (entry.kind) {
    case 'fixed':
      return [entry.op];

    case 'shuffle_group': {
      const ops = [...entry.ops];
      for (let i = ops.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [ops[i], ops[j]] = [ops[j]!, ops[i]!];
      }
      return ops;
    }

    case 'weighted': {
      if (entry.choices.length === 0) return [];
      const total = entry.choices.reduce((s, c) => s + c.weight, 0);
      if (total <= 0) return [entry.choices[0]!.op];
      let pick = rng() * total;
      for (const { weight, op } of entry.choices) {
        pick -= weight;
        if (pick <= 0) return [op];
      }
      return [entry.choices[entry.choices.length - 1]!.op];
    }
  }
}

/** A resolved op paired with its source entry's id and param declarations. */
export interface ResolvedEntry {
  op: GenOp;
  entryId?: string;
  params?: OpParam[];
}

export function resolvePipelineWithMeta(pipeline: PipelineEntry[], seed: number): ResolvedEntry[] {
  const rng = mulberry32(seed);
  const out: ResolvedEntry[] = [];
  for (const entry of pipeline) {
    for (const op of resolvePipelineEntry(entry, rng)) {
      out.push({ op, entryId: entry.id, params: entry.params });
    }
  }
  return out;
}


/** Tunable params declared on a biome's basePipeline entries (workbench sliders). */
export function deriveOpParams(
  pipeline: PipelineEntry[],
): Array<OpParam & { entryId: string }> {
  const out: Array<OpParam & { entryId: string }> = [];
  for (const e of pipeline) {
    if (e.id && e.params?.length) {
      for (const p of e.params) out.push({ ...p, entryId: e.id });
    }
  }
  return out;
}

export function mixZoneSeed(ops: GenOp[], zoneSeed: number): GenOp[] {
  return ops.map(op => {
    if (
      (op.type === 'noise_patch' || op.type === 'scatter' ||
       op.type === 'cave'        || op.type === 'path') &&
      (op as { seed?: unknown }).seed !== undefined
    ) {
      const raw = (op as { seed: string | number }).seed;
      const mixed = resolveSeed(raw) ^ zoneSeed;
      return { ...op, seed: mixed };
    }
    return op;
  });
}

export function applyOpParams(
  resolved: ResolvedEntry[],
  opParams: Record<string, Record<string, number>>,
): GenOp[] {
  return resolved.map(({ op, entryId, params }) => {
    if (!entryId || !params?.length) return op;
    const overrides = opParams[entryId];
    if (!overrides) return op;
    let patched = op as Record<string, unknown>;
    let changed = false;
    for (const p of params) {
      if (overrides[p.field] !== undefined) {
        if (!changed) { patched = { ...patched }; changed = true; }
        patched[p.field] = overrides[p.field];
      }
    }
    return patched as GenOp;
  });
}

export interface ResolvedBiomeOps {
  ops: GenOp[];
  numericSeed: number;
}

/** Per-zone toggle/param override for a feature operator. `false` disables a
 *  biome-default feature; an object enables/tunes it; `true` enables with biome
 *  defaults. A key not present in the biome's defaults adds the feature. */
export type FeatureOverride =
  | boolean
  | { enabled?: boolean; params?: Record<string, number> };

/**
 * Merges a biome's default features with a zone's overrides into the final,
 * ordered list of feature refs to place. Biome-default order is preserved;
 * zone-added features (not in the defaults) are appended in key order.
 */
export function mergeFeatures(
  biomeFeatures: BiomeFeatureRef[],
  overrides?: Record<string, FeatureOverride>,
): FeatureRef[] {
  const out: FeatureRef[] = [];
  const seen = new Set<string>();
  const enabledOf = (ov: FeatureOverride | undefined, dflt: boolean): boolean =>
    ov === undefined ? dflt : ov === false ? false : ov === true ? true : ov.enabled !== false;

  for (const bf of biomeFeatures) {
    seen.add(bf.id);
    const ov = overrides?.[bf.id];
    if (!enabledOf(ov, true)) continue;
    const params = { ...bf.params, ...(typeof ov === 'object' ? ov.params : undefined) };
    out.push({ id: bf.id, params: Object.keys(params).length ? params : undefined });
  }
  if (overrides) {
    for (const [id, ov] of Object.entries(overrides)) {
      if (seen.has(id) || !enabledOf(ov, false)) continue;
      const params = typeof ov === 'object' ? ov.params : undefined;
      out.push({ id, params });
    }
  }
  return out;
}

/**
 * Single shared path: basePipeline (patched) + phased feature placement, mixed
 * with the zone seed. Phase order is reserve → base → build → decorate, so
 * reservations claim space before the structures that must avoid them. Used by
 * both the biome workbench server and the game world loader.
 */
export function resolveBiomeGenOps(
  biomeDef: BiomeDef,
  seed: number | string,
  options: {
    opParams?: Record<string, Record<string, number>>;
    features?: FeatureRef[];
  } = {},
): ResolvedBiomeOps {
  const numericSeed = resolveSeed(seed);
  const opParams = options.opParams ?? {};

  const baseMeta = resolvePipelineWithMeta(biomeDef.basePipeline, numericSeed);
  const base = applyOpParams(baseMeta, opParams);

  const feat = resolveFeatureOperators(options.features ?? mergeFeatures(biomeDef.features));

  const ops = mixZoneSeed(
    [...feat.reserve, ...base, ...feat.build, ...feat.decorate],
    numericSeed,
  );

  return { ops, numericSeed };
}
