# Investigating post-op region & placement failures

**Status:** open investigation. Symptoms are pervasive across existing content,
not just weak-model output. All failures below are **non-fatal** — mapgen logs a
`console.warn` and **skips the op**, so intended content silently disappears
(named landmarks never stamped, routes never drawn, plots never scattered).

## Symptoms

Seen during world load / `computeWorldMetrics` and during implementer runs:

```
[mapgen] post_op region 'beach_N' not found.
[mapgen] post_op stamp skipped: prefab "ruined_watchtower" in zone 'zone_42_40' does not fit any free space in the requested area.
[mapgen] route: 'from' unresolvable — point ref: region 'fountain' not defined — skipping.
[mapgen] route: 'from' unresolvable — point ref: region 'market' not defined — skipping.
[mapgen] scatter_sites 'plot': placed 2/13 (spacing 39 too tight for the free area).
[mapgen] route: no path from (22,26) to (16,25).
```

## Two distinct failure classes

These look similar in the log but have different root causes — keep them separate.

### Class A — region name not defined
`region '<id>' not found` / `point ref: region '<id>' not defined`. A post-op
references a named region (`beach_N`, `fountain`, `market`) that was never
registered during this zone's generation. The lookup returns null, the op is
skipped.

### Class B — placement capacity
`does not fit any free space`, `scatter_sites ... too tight`, `route: no path`.
The region *exists*, but the requested placement can't be satisfied: the prefab
is larger than the free area, the scatter spacing is too tight for the region
size, or no walkable path connects two points. This is a geometry/budget
problem, not a naming problem.

## How regions work

- A region is a `'region'`-kind feature on the blackboard, registered by a
  `region` op during generation — `server/game/mapgen/blackboard.ts:251`
  (`addRegion`), op handler at `server/game/mapgen/index.ts:790` (`case 'region'`).
- Lookups resolve by id via `regionBounds` — `blackboard.ts:109`. A miss returns
  null and the consuming op warns + skips:
  - region/stamp targets — `server/game/mapgen/index.ts` (`bb.regionBounds(...)` → warn)
  - `relative_to` / bounds ref / point ref — `index.ts:147-148, 235-236, 262-263`
- So a region only exists if some op **earlier in the same pipeline** painted and
  named it. Cardinal/biome regions come from the biome's `basePipeline`; custom
  ones must be created by a preceding post-op.

## Key finding: the model is already told which regions exist

The implementer's **Zone Context already lists the live regions**:
`pipeline/lib/context.ts:59` computes `named_regions = Object.keys(bounds).sort()`
from the actual registered region set, and `context.ts:114` renders
`- named_regions: <list>`. So a model emitting `beach_N` when the context lists
(say) `beach`, `shore`, `interior` is going **off-list** — the valid vocabulary
was in front of it.

This makes Class A cheaply validatable: a post-op's region references must be a
subset of the zone's `named_regions` (or of regions created earlier in the same
response). That check could feed the implementer repair round
(`pipeline/implementer.ts` → `collectBodyErrors`) the same way the prefab-grid
check does.

## Open questions / investigation checklist

1. **Why is Class A pervasive in *existing* content?** `fountain`/`market`
   unresolved across many zones suggests pipeline drift: a biome stopped
   registering regions that older post-ops still reference. Diff a few affected
   zones against the biome their `biome` field names — does that biome's
   `basePipeline` still produce those regions? (`server/game/mapgen/biomes/`)
2. **Enumerate the region vocabulary per biome.** For each biome, list the
   region ids its pipeline registers. That's the allow-list models should draw
   from. Compare against region ids actually referenced in `world/zones/*.json`
   post_ops to quantify the mismatch.
3. **Is `named_regions` complete at the time the model sees it?** `context.ts`
   derives it from a generation pass — confirm it includes regions a post-op
   would create mid-pipeline, or only base-pipeline regions.
4. **Class B is separate.** Decide whether unplaceable prefabs / tight scatter /
   no-path should (a) stay silent skips, (b) surface as repair-round errors, or
   (c) trigger a fallback placement. Likely lower priority than Class A.

## Candidate fixes (not yet chosen)

- **Validate region refs into the repair round.** In `collectBodyErrors`, reject
  post_ops whose region refs aren't in `named_regions` (+ regions created in the
  same response). Forces the model to correct `beach_N` → a real region before
  write. Highest leverage for new content; does nothing for the existing backlog.
- **Fix biomes to register the expected regions**, if the mismatch is pipeline
  drift rather than model error. Fixes existing content; needs care not to break
  other zones.
- **Tighten the prompt** to forbid referencing regions outside the listed
  `named_regions`. Cheap, helps capable models, unreliable for weak ones.

## Anchor references

- Emit sites: `server/game/mapgen/index.ts` (search `not found`, `does not fit`, `no path`, `too tight`)
- Region model: `server/game/mapgen/blackboard.ts:109,251`
- Context surfaced to the model: `pipeline/lib/context.ts:28,59,90,114`
- Repair-round hook: `pipeline/implementer.ts` → `collectBodyErrors`
