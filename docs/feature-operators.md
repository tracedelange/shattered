# Feature Operators — unifying features, modules, and constraints

## Status

**Implemented.** Features, modules, and constraints are collapsed into one
`FeatureOperator` model with a phased (reserve → base → build → decorate)
placement pass. `BiomeDef` is now `basePipeline` + `features`; per-zone control
is the single `ZoneDef.features` field (array shorthand or override map). The
old `FeatureDef` / `BiomeConstraint` / `module` trio, `deriveModules`,
`resolveConstraintOps`, `activeModules`, and `featureWeights` are removed.

Deviations from the original plan below, made during implementation:
- **basePipeline keeps its own param mechanism.** `biome-params.json` overrides
  only ever targeted basePipeline entries (tree_fringe, village_plots, *_trees)
  and `zoneParams` (inset) — never features — so that seeding path is unchanged
  and the file was NOT re-keyed. Feature params flow through the operator
  `blueprint(params)` function instead (no operator declares params yet).
- **Pure-intent constraints dropped.** Blueprint-less markers (clearing,
  chamber, boss_chamber, entrance, drain, …) and the aspirational
  `featureWeights` produced no ops; they were removed rather than ported.
- **Array shorthand retained.** `ZoneDef.features: ['beach_S']` means "enable
  with biome defaults" — the loader normalizes it to the override map. The
  worldgen export still emits this form for beaches.

## The problem

A single piece of zone content (a fountain, a market, a guard tower) is currently
expressed in **three overlapping forms**:

1. **`FeatureDef`** (`server/game/mapgen/features/`, `FEATURE_REGISTRY`) —
   `{ id, note, blueprint: PipelineEntry[] }`. Selected per-zone via
   `ZoneDef.features: string[]`, resolved by `resolveFeatureOps` and appended
   **after** the biome pipeline.
2. **`BiomeConstraint`** (`BiomeDef.defaultConstraints`) —
   `{ feature, anchor, priority, blueprint? }`. Declares that a biome "should
   have" a feature; when it carries a `blueprint` the ops run in-pipeline.
3. **`module`** — a string tag on `PipelineEntry` (and on `scatter_sites.roles`),
   toggled per-zone via `ZoneDef.activeModules: string[]`. And `deriveModules`
   literally does `ids.add(c.feature)` — **a constraint's feature *is* a module.**

So `fountain` is simultaneously a registry feature, a village `defaultConstraint`,
and a derived module (the village pipeline entry is tagged `module: 'fountain'`).
Its tunables live in yet a fourth place: `OpParam`s on pipeline entries, overridden
per-zone via `ZoneDef.opParams[entryId][field]` and per-biome via
`world/biome-params.json`.

Selecting/toggling/parameterising the same concept therefore happens through
**three different mechanisms** (`features[]`, `activeModules[]`, `opParams[]`),
and placement happens through **two** (in-pipeline `scatter_sites`/`place` with
Blackboard claim arbitration, vs. post-pipeline `resolveFeatureOps` + the
post-ops semantic layer). The well-on-fountain collision was a direct symptom:
the post-op layer didn't participate in the same claim arbitration the pipeline
uses. (That specific gap is now fixed — post-op stamps are footprint-aware — but
the structural duplication remains.)

## The goal

One concept: a **feature operator**. A named, coordinate-free, parameterised
bundle of ops with a declared placement phase and claim behaviour. A biome lists
the feature operators it includes (with default params); a zone toggles them
on/off and overrides params. The engine resolves **every** feature — biome-default
or zone-added or implementor-added (post-op) — through **one** footprint-aware,
claim-respecting placement pass. Pick + params in; the engine handles placement.

## Proposed model

### The operator

```ts
type FeaturePhase = 'reserve' | 'build' | 'decorate';

interface FeatureParam {
  id: string; label: string; min: number; max: number; step: number; default: number;
}

interface FeatureOperator {
  id: string;
  note: string;                       // one-line, written for an LLM selecting it
  /**
   * reserve  → claims space before buildings scatter (fountain, market plaza)
   * build    → structural placement that competes for space (buildings, towers)
   * decorate → cosmetic fill after structure (rubble, banners, the collapsed well)
   */
  phase: FeaturePhase;
  params?: FeatureParam[];
  /** Coordinate-free ops, a pure function of resolved params + a seeded rng. */
  blueprint(params: Record<string, number>, rng: () => number): GenOp[];
}
```

This replaces **`FeatureDef`, `BiomeConstraint`, and `module`** with one registry
(`FEATURE_REGISTRY`). `deriveModules` is deleted. `OpParam`/`ZoneParam` on
pipeline entries are replaced by `FeatureParam` on the operator.

### Biome declaration

A biome is its **base terrain pipeline** plus a list of feature operators it
includes by default:

```ts
interface BiomeDef {
  id: string; tileset: string; tags: BiomeTag[]; palette: BiomePalette;
  defaultTile: string; width: number; height: number;
  /** Terrain only — ground fill, voronoi/cave, the road skeleton. No content. */
  basePipeline: PipelineEntry[];
  /** Content operators, with biome-default params + ordering priority. */
  features: Array<{
    id: string;
    params?: Record<string, number>;
    priority?: ConstraintPriority;   // required | preferred | optional
  }>;
}
```

The current village pipeline's module-gated entries (`fountain`, `market_square`),
its building `scatter_sites`, and its `defaultConstraints` (towers, walls, gates)
all become entries in `features`. `featureWeights` folds into per-feature
`priority`/params.

### Zone overrides

One map replaces `features[] + activeModules[] + opParams[]`:

```ts
interface ZoneDef {
  // ...
  features?: Record<string, FeatureOverride>;   // keyed by operator id
}
type FeatureOverride =
  | boolean                                   // true = on (biome defaults), false = off
  | { enabled?: boolean; params?: Record<string, number> };
```

`world/biome-params.json` becomes per-biome feature param overrides keyed by
`{ biome: { featureId: { paramId: { min?, max?, default? } } } }` — same seeding
machinery, one address scheme.

### The unified placement pass

All features resolve through a single pass, ordered by phase, then priority:

```
basePipeline → features[phase=reserve] → features[phase=build] → features[phase=decorate]
                                                                 ↑ post-op features join here
```

Every feature placement is **footprint-aware and claim-respecting** (the
machinery `place`/`scatter_sites` and the now-fixed post-op stamp already use):
the engine evaluates open space for the operator's footprint, claims it on
success so later features avoid it, and on no-fit either **skips with a warning**
or (opt-in) **forces with a warning**. This is the behaviour described by the
owner: *"evaluate open spaces for a place it can fit; if found, great; if not,
skip / force-with-warning / fall back."* `reserve`-phase features run before
`build` so "fountain claimed before buildings scatter" (today an implicit
ordering in `village.ts`) becomes an explicit phase guarantee.

Post-op features become `decorate`-phase
feature placements through the **same** pass — collapsing the second placement
system into the first. *(June 2026: completed — `append_post_ops` was removed
entirely; prefab feature entries compile into engine-managed placement via
`server/game/mapgen/zoneFeatures.ts`.)*

## What this touches

- `server/game/mapgen/features/` — operator registry (absorbs `FeatureDef`),
  per-operator `phase` + `params` + `blueprint(params, rng)`.
- `server/game/mapgen/biomes/index.ts` — `BiomeDef` (`basePipeline` + `features`),
  delete `BiomeConstraint`, `deriveModules`, module gating in
  `resolvePipelineWithMeta`/`filterModuleRoles`.
- `server/game/mapgen/biomes/*.ts` — rewrite each biome as base + feature list
  (village is the big one; wilderness biomes are mostly base + a spawn table).
- `shared/types.ts` — `ZoneDef.features` map; drop `activeModules`, `opParams`,
  `features: string[]`. `OpParam`/`ZoneParam` → `FeatureParam`.
- `server/world/loader.ts` — `resolveBiomeOps` seeds **feature** params (not op
  params); merges zone feature overrides; runs the phased placement pass.
- `world/biome-params.json` — re-keyed to `biome → feature → param`.
- `pipeline/` — `buildZoneContext` already surfaces `feature_weights`/`features`;
  update to list available feature operators + params for a zone. Gardener and
  Implementor prompts: one vocabulary ("features"), drop "modules"/"activeModules".
- `tools/biome-workbench` — sliders bind to feature params; module toggles become
  feature on/off toggles.
- Tests/fixtures referencing `activeModules`/`opParams`/`features: []`.

## Migration sequence

1. **Land the model types** (`FeatureOperator`, `BiomeDef.features`,
   `ZoneDef.features`) alongside the existing system; no behaviour change yet.
2. **Port the feature registry**: wrap existing `FeatureDef.blueprint` +
   constraint blueprints as operators with a `phase` and `params`. Mechanical.
3. **Rewrite `village`** (the only biome using modules + constraints heavily) as
   `basePipeline` + `features`. Validate against current renders (deterministic
   diff on a fixed seed set).
4. **Rewrite wilderness biomes** (base + spawn table + optional beach/landmark
   features) — mostly trivial.
5. **Switch `resolveBiomeOps`** to the phased placement pass; delete
   `deriveModules`, module gating, `opParams`/`activeModules` handling.
6. **Re-key `biome-params.json`** and migrate any zone files using the old fields
   (regenerate stubs; authored zones edited).
7. **Route post-op features through the same pass** (decorate phase) — retire the
   separate `applyPostOps` placement path, keep the SemanticAt descriptors as the
   per-feature placement hint.
8. **Update prompts + workbench + context builder**, then delete dead code.

## Risks / open questions

- **Ordering guarantees.** The `reserve → build → decorate` phasing must
  reproduce today's implicit "reserve fountain/market before building scatter"
  (`village.ts:15`). A naive merge that runs everything post-pipeline would let
  buildings land on fountains. The phase model is the fix; it needs a test that
  asserts reserved footprints survive the build phase.
- **Base vs feature boundary.** Some ops are genuinely terrain (voronoi ground,
  cave carving) vs content (fountain). The split is mostly clear, but roads/walls
  are borderline (structure that also reserves space). Decide per-op during the
  village rewrite.
- **Determinism.** Param seeding currently keys on `entryId:field`
  (`loader.ts:seedParam`). Re-key to `featureId:paramId` and confirm the seeded
  values are stable enough that we don't need to regenerate the whole world (or
  accept a one-time regen — stubs aren't committed anyway).
- **No-fit policy.** Default `skip + warn`; expose a per-feature
  `on_no_fit: 'skip' | 'force' | 'shrink'` later. `force` overwrites with a
  warning (today's pre-fix behaviour); `shrink`/rework is future.
- **`near_region` vs `center_of_region` for decorations.** The collision
  investigation showed a packed market leaves `center_of_region` no room.
  Decorations that should spill into surrounding streets want `near_region` with
  a distance. Encode this as guidance in the Implementor prompt and consider a
  per-feature default placement hint.

## Connection to the placement fix (Part A, done)

Part A made post-op stamps footprint-aware and claim-respecting — i.e. it made
the post-op path obey the same arbitration the biome pipeline uses. That is the
*local* version of this plan's central idea: **one claim-aware placement pass for
all features.** Part B generalises it so biome-default features and
implementor-added features are the same kind of thing, placed the same way.
