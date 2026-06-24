---
name: new-zone-feature
description: Scaffold a new zone-feature operator for the mapgen feature registry — the FeatureOperator file, its registry wiring, numeric params, and a smoke test. Use when asked to add/create a new zone feature, mapgen feature, or feature operator (e.g. a border, a landmark, a terrain decoration placed via a zone's `features` array).
---

# Scaffold a new zone-feature operator

A **feature operator** is the unified unit of named zone content (a fountain, a
beach, a wilderness border). It is a coordinate-free, optionally-parameterised
bundle of `GenOp`s with a placement **phase**. Authors drop it into a zone's
`features` array; the engine resolves and places it. One registry, read
dynamically everywhere (game loader, zone-editor picker, forge catalog), so the
**only** wiring needed is the registry entry — no other list to update.

Reference implementation to copy from: `server/game/mapgen/features/wilderness_border.ts`.

## Before writing code — pin these down

Ask the user (or infer from the request) and state them back as assumptions:

1. **Id** — kebab-case, unique (e.g. `wilderness_border`). Becomes the registry key and the `features` array entry.
2. **What it paints** — which tiles, where. Tiles must exist in the active tileset (`world-grown/tilesets/overworld.json`). Blocking/impermeable tiles are exactly `wall`, `water`, `void`, `tree` (`shared/constants.ts` → `BLOCKING_TILES`).
3. **Phase** — coarse ordering against the biome pipeline. Full order is `reserve → base → build → decorate`:
   - `reserve` — claims space *before* the biome scatters buildings. NOTE: the biome's base pass usually fills the ground afterward and will stomp painted tiles. Use only for keepout/region claims, not terrain paint.
   - `build` — after base terrain + buildings exist; competes for space (walls, towers, borders). Default choice for terrain that should sit over the base.
   - `decorate` — last. Cosmetic. Water-tile (`tile: 'water'`) ops are deferred to the very end here (beach-corner safety) — avoid `decorate` if you paint water *and* need a later op to overwrite it.
4. **Params** — **numeric only** (`Record<string, number>`). No strings. To vary a tile/material, index into a small table from a numeric param (see `MATERIALS` in `wilderness_border.ts`). Each param needs `{ field, label, min, max, step, default }`.
5. **Biome gating** — universal by default. Restrict only if it reads as broken elsewhere (e.g. `city_walls` is village-only).

## Useful building blocks (from `shared/types.ts` `GenOp` / `BoundsRef`)

- `{ type:'fill', tile, bounds, only_over?, placement? }` — solid paint. `bounds: { edge_strip: Direction, depth }`, `{ corner_patch: 'NE'|…, depth }`, `{ inset: n }`, `{ rect }`, `{ all: true }`, `{ region }`.
- `{ type:'noise_patch', tile, bounds, threshold, scale, seed, over? }` — organic fuzz; paints a cell when `valueNoise >= threshold`, so **higher threshold = sparser**. `over` restricts to listed existing tiles (e.g. only creep over `grass`).
- `{ type:'path', points, tile, width?, jitter?, seed? }` — polyline corridor. `points` use `PointRef`: `{ edge: Direction, t?: 0..1, inset?: n }` resolves a parametric edge point inset inward — ideal for carving gaps/gates at edge midpoints (`t: 0.5`).
- `{ type:'scatter' | 'scatter_sites' | 'stamp' | 'region' | 'route' | … }` — see the `GenOp` union for the full set.
- The blueprint **never sees zone width/height**. Express everything relative to edges/insets/regions, not absolute coordinates.

## The FeatureOperator shape

```ts
import type { FeatureOperator } from './index.ts';
import type { GenOp } from '../../../../shared/types.ts';

export const myFeature: FeatureOperator = {
  id: 'my_feature',
  note: 'One or two sentences for an LLM selecting/tuning this feature. Document each param.',
  phase: 'build',                       // reserve | build | decorate
  params: [                              // omit if no tunables
    { field: 'depth', label: 'Depth', min: 1, max: 8, step: 1, default: 3 },
  ],
  blueprint: (p) => {                    // p: resolved numeric params (defaults ⊕ overrides)
    const ops: GenOp[] = [];
    // ... build ops from p; clamp/round indices used for table lookups ...
    return ops;                          // bare array → assigned to `phase`
    // or return { reserve:[…], build:[…], decorate:[…] } for a PhasedOps spread
  },
};
```

## Steps

1. **Create** `server/game/mapgen/features/<id>.ts` exporting the `FeatureOperator`. Match the file style of `wilderness_border.ts` (aligned literals, a comment block explaining the passes). Clamp/round any numeric param used as a table index or a count.
2. **Register** in `server/game/mapgen/features/index.ts`: add the `import`, then a key in `FEATURE_REGISTRY` (`my_feature: myFeature`). This alone exposes it to the game loader, the zone-editor "add feature" picker, and the forge feature catalog.
3. **Gate (optional)** — if biome-restricted, add `my_feature: ['village', …]` to `FEATURE_BIOMES` in the same file. Skip for universal features. Do **not** add to `TERRAIN_FEATURE_IDS` unless it is graph-owned terrain (beaches/rivers/bridges).
4. **Typecheck**: `npx tsc --noEmit -p .` — expect a clean exit.
5. **Smoke-test** the blueprint and a render (substitute your id/params):
   ```bash
   node --input-type=module -e "
   import { resolveFeatureOperators } from './server/game/mapgen/features/index.ts';
   import { generateZoneGrid } from './server/game/mapgen/index.ts';
   const r = resolveFeatureOperators([{ id: 'my_feature' }]);
   const ops = [{ type:'fill', tile:'grass', bounds:{ all:true } }, ...r.reserve, ...r.build, ...r.decorate];
   const g = generateZoneGrid({ id:'t', width:36, height:18, default_tile:'grass', ops });
   const sym = { grass:'.', tree:'T', dirt:'+', water:'~', wall:'#' };
   for (const row of g.grid) console.log(row.map(t=>sym[t]??'?').join(''));
   "
   ```
   The grid is on `g.grid` (rows of tile-name strings). Confirm the paint looks right and ops don't throw.
6. **Report** the new id, its params (with defaults), the phase, and a one-line ASCII excerpt of the render.

## Pitfalls

- Params are numeric — never reach for a string param; index a table instead.
- Don't invent tile names; verify against the tileset. "Impermeable" requires a `BLOCKING_TILES` tile in the solid core.
- Within a phase, ops run in array order. Carve openings (paths/gaps) **after** the fills they cut through, or they'll be re-covered.
- The registry is the single source of truth — there is no separate allowlist in forge/zone-editor to update.
