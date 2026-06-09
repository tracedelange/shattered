// Biome system — deterministic, composable zone generation envelopes.
//
// Architecture:
//   BiomeDef + seed → resolvePipeline → GenOp[]
//   GenOp[] → generateZoneGrid (index.ts) → ZoneGrid

import type { GenOp } from '../../../../shared/types.ts';
import { mulberry32, resolveSeed } from '../rng.ts';

import { village }  from './village.ts';
import { dungeon }  from './dungeon.ts';
import { sewer }    from './sewer.ts';
import { forest }   from './forest.ts';
import { cave }     from './cave.ts';

// ─── Tags ─────────────────────────────────────────────────────────────────────

export type BiomeTag = 'indoor' | 'outdoor' | 'underground' | 'aquatic' | 'vertical';

// ─── Palette ──────────────────────────────────────────────────────────────────

export interface BiomePalette {
  floor: string;
  wall: string;
  accent: string;
}

// ─── Constraints ──────────────────────────────────────────────────────────────

export type ConstraintPriority = 'required' | 'preferred' | 'optional';

export interface BiomeConstraint {
  feature: string;
  anchor: string;
  priority: ConstraintPriority;
  note?: string;
  /**
   * Optional placement blueprint. When present, these pipeline entries are
   * resolved and appended to the zone's op list after the main pipeline so
   * the feature is placed procedurally. Building-role features (tavern,
   * blacksmith, inn) are placed via scatter_sites.roles + stamp.role_prefabs
   * instead and have no blueprint here.
   */
  blueprint?: PipelineEntry[];
}

// ─── Params ───────────────────────────────────────────────────────────────────

/** A tunable numeric parameter on a pipeline entry, rendered as a slider in the workbench. */
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

export type PipelineEntry =
  | { kind: 'fixed';         op: GenOp;                                         module?: string; id?: string; params?: OpParam[] }
  | { kind: 'shuffle_group'; ops: GenOp[];                                       module?: string; id?: string; params?: OpParam[] }
  | { kind: 'weighted';      choices: Array<{ weight: number; op: GenOp }>;      module?: string; id?: string; params?: OpParam[] };

// ─── Biome definition ─────────────────────────────────────────────────────────

export interface BiomeDef {
  id: string;
  tileset: string;
  tags: BiomeTag[];
  palette: BiomePalette;
  pipeline: PipelineEntry[];
  defaultConstraints: BiomeConstraint[];
  zoneParams?: ZoneParam[];
  spawnWeights: Record<string, number>;
  featureWeights: Record<string, number>;
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
};

// ─── Module derivation ────────────────────────────────────────────────────────

export function deriveModules(pipeline: PipelineEntry[], constraints: BiomeConstraint[]): string[] {
  const ids = new Set<string>();
  for (const entry of pipeline) {
    if (entry.module) ids.add(entry.module);
    if (entry.kind === 'fixed' && entry.op.type === 'scatter_sites' && entry.op.roles) {
      for (const r of entry.op.roles) {
        if (r.module) ids.add(r.module);
      }
    }
  }
  for (const c of constraints) {
    if (c.blueprint?.length) ids.add(c.feature);
  }
  return [...ids];
}

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

/**
 * Strips inactive module roles from a scatter_sites or stamp op.
 */
function filterModuleRoles(op: GenOp, activeModules: Set<string>): GenOp {
  if (op.type === 'scatter_sites' && op.roles) {
    const roles = op.roles.filter(r => !r.module || activeModules.has(r.module));
    if (roles.length === op.roles.length) return op;
    return { ...op, roles };
  }
  if (op.type === 'stamp' && op.role_prefabs) {
    const filtered = Object.fromEntries(
      Object.entries(op.role_prefabs).filter(([role]) => activeModules.has(role)),
    );
    if (Object.keys(filtered).length === Object.keys(op.role_prefabs).length) return op;
    return { ...op, role_prefabs: filtered };
  }
  return op;
}

/** A resolved op paired with its source entry's id and param declarations. */
export interface ResolvedEntry {
  op: GenOp;
  entryId?: string;
  params?: OpParam[];
}

export function resolvePipelineWithMeta(pipeline: PipelineEntry[], seed: number, activeModules?: Set<string>): ResolvedEntry[] {
  const rng = mulberry32(seed);
  const out: ResolvedEntry[] = [];
  for (const entry of pipeline) {
    if (entry.module && activeModules && !activeModules.has(entry.module)) continue;
    const resolved = resolvePipelineEntry(entry, rng);
    const filtered = activeModules ? resolved.map(op => filterModuleRoles(op, activeModules)) : resolved;
    for (const op of filtered) {
      out.push({ op, entryId: entry.id, params: entry.params });
    }
  }
  return out;
}

export function resolvePipeline(pipeline: PipelineEntry[], seed: number, activeModules?: Set<string>): GenOp[] {
  return resolvePipelineWithMeta(pipeline, seed, activeModules).map(r => r.op);
}

export function deriveOpParams(
  pipeline: PipelineEntry[],
  constraints: BiomeConstraint[],
): Array<OpParam & { entryId: string }> {
  const out: Array<OpParam & { entryId: string }> = [];
  const collect = (entries: PipelineEntry[]) => {
    for (const e of entries) {
      if (e.id && e.params?.length) {
        for (const p of e.params) out.push({ ...p, entryId: e.id });
      }
    }
  };
  collect(pipeline);
  for (const c of constraints) {
    if (c.blueprint) collect(c.blueprint);
  }
  return out;
}

export function resolveConstraintOps(constraints: BiomeConstraint[], seed: number): GenOp[] {
  const rng = mulberry32(seed ^ 0xc0ffeeba);
  return constraints
    .filter(c => c.blueprint?.length)
    .flatMap(c => c.blueprint!.flatMap(entry => resolvePipelineEntry(entry, rng)));
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

/**
 * Single shared path: biome pipeline → filtered constraints → patched ops → mixed seeds.
 * Used by both the biome workbench server and the game world loader.
 */
export function resolveBiomeGenOps(
  biomeDef: BiomeDef,
  seed: number | string,
  options: {
    activeModules?: string[] | Set<string>;
    opParams?: Record<string, Record<string, number>>;
    featureOps?: GenOp[];
  } = {},
): ResolvedBiomeOps {
  const numericSeed = resolveSeed(seed);
  const activeSet = options.activeModules instanceof Set
    ? options.activeModules
    : options.activeModules ? new Set(options.activeModules) : undefined;
  const opParams = options.opParams ?? {};

  const pipelineMeta = resolvePipelineWithMeta(biomeDef.pipeline, numericSeed, activeSet);
  const patchedPipeline = applyOpParams(pipelineMeta, opParams);

  const filteredConstraints = activeSet
    ? biomeDef.defaultConstraints.filter(c => !c.blueprint?.length || activeSet.has(c.feature))
    : biomeDef.defaultConstraints;
  const constraintOps = resolveConstraintOps(filteredConstraints, numericSeed);

  const ops = mixZoneSeed(
    [...patchedPipeline, ...constraintOps, ...(options.featureOps ?? [])],
    numericSeed,
  );

  return { ops, numericSeed };
}
