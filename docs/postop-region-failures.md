# Investigating post-op region & placement failures

**Status:** root-caused 2026-06-11 — see [Findings](#findings-2026-06-11). The
original framing below (that Class A is pervasive in *post_ops*) turned out to be
wrong; the loud `fountain`/`market` spam is a feature-operator bug, not a post_op
or model problem. The framing is kept for context; read Findings first.

All failures below are **non-fatal** — mapgen logs a `console.warn` and **skips
the op**, so intended content silently disappears (named landmarks never stamped,
routes never drawn, plots never scattered).

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

## Findings (2026-06-11)

Method: generated all 1190 zones via the same path the implementer context uses
(`buildZoneContext` → `generateZoneGrid`), collected every region *reference* in
each zone's `post_ops` (`in_region`, `center_of_region`, `near_region`,
`relative_to`, `if_region`, and point/bounds `region` refs), and diffed against
the live `named_regions`. Script: `tools/analyze-region-refs.ts`.

### Class A in post_ops is rare, not pervasive

| metric | count |
|---|---|
| zones total | 1190 |
| zones with any `post_ops` | 39 |
| zones with region refs in post_ops | 33 |
| zones with a **missing** post_op region ref | **4** |
| total missing refs | 7 |

The 7 missing refs: `beach_N` (zone_41_39, zone_42_40), `beach_NE` (zone_41_40),
and `tower_nw/ne/sw/se` (village_41_41). The four `tower_*` refs are an
`if_region` guard — they self-suppress (`if_region` silently skips when the guard
region is absent, `index.ts:568`), so they emit no warning and stamp nothing by
design. The `beach_*` ones are the only genuine post_op Class-A misses, and even
those are arguably Class B in disguise (see below).

**So the repair-round validation idea (validate region refs in `collectBodyErrors`)
has almost no existing backlog to fix** — it's a guard for *future* model output,
not a cleanup of current content. Still worth doing, but reframe its value.

### The loud `fountain`/`market` spam is a feature-operator naming bug

The flood of `route: 'from' ... region 'market'/'fountain' not defined` does
**not** come from post_ops or from the village `basePipeline`. It comes from the
`fountain` and `market_square` **feature operators** themselves:

- `features/fountain.ts` decorate phase stamps with `at_tag: 'fountain_site'` and
  `region: 'fountain'`, then routes `from: { region: 'fountain' }`.
- But stamp's region-naming prefixes the site id when `at_tag` is set
  (`index.ts:1287` → `${id}_${op.region}`), so the region is actually registered
  as **`fountain_site_1_fountain`**, never the bare `fountain`.
- The very next `route from { region: 'fountain' }` therefore *always* fails the
  lookup. `market_square.ts` has the identical bug with `market`.

Confirmed: village_41_41's live regions include `fountain_site_1_fountain` and
`market_site_1_market` — the stamp succeeded, the route's bare-name ref missed.
This fires in **every village that places a fountain/market**, which is why it
dominates the log. It is a hard-coded engine bug, not model error or pipeline
drift.

**Fix:** make the route reference the region the stamp actually creates. Options,
in rough order of cleanliness:
- route `from` a tag/feature instead of the bare region (the `fountain_site_1`
  site feature exists; point refs already support `{ feature: id }`,
  `index.ts:242`) — but the `_1` index is dynamic, so a tag-based `from` is safer
  if route supports it;
- or have the stamp register an additional un-prefixed alias when `count == 1`;
- or drop the `at_tag` prefix for single-site stamps.
  Pick one and apply to both `fountain.ts` and `market_square.ts`.

### The `beach_*` misses are a feature-id-vs-region-id confusion

The `beach_*` post_op misses are a third, distinct class: **feature-operator ids
are not region ids.** The beach operators (`features/ocean_border.ts`) only
`fill`/`noise_patch` sand and water — they register **no region**. So `beach_N`
is a valid entry in the zone's `features` list but is *never* a `named_region`,
and a post_op with `in_region: beach_N` / `if_region: beach_N` can never resolve.

zone_42_40 is the canonical example: it lists `beach_N`/`beach_SE` as features,
and its post_op stamps `ruined_watchtower` `in_region: beach_N` guarded by
`if_region: beach_N`. Because no `beach_N` region exists, the `if_region` guard
silently suppresses the stamp (`index.ts:568`) — it emits nothing now. (The
original symptom log's "does not fit any free space" line for this prefab
predates the current post_op, which has since been edited — note its
`*_repair_v1` seeds.) The trap: an author sees `beach_N` in `features` and
assumes it doubles as a region handle. It doesn't.

**Fixed 2026-06-11.** `fill` now takes an optional `region` field
(`index.ts` fill handler + `shared/types.ts`), and each beach operator registers
its depth-8 sand base as a region matching its id (`features/ocean_border.ts`).
`beach_N`/`beach_NE`/etc. are now real `named_regions`, so the coastal post_ops
resolve and place: zone_41_40's `driftwood_pile`/`shore_campfire` now stamp
(`driftwood_shore`/`shore_camp` regions appear), zone_41_39's `fishing_shack` and
zone_42_40's `ruined_watchtower` place with no warnings. After this + the
fountain/market fix, the only remaining Class A ref in the whole world is
village_41_41's four `tower_*` `if_region` guards — and those are *intended*
no-ops (the `guard_tower` feature is commented out in `village.ts`).

### Spawn-side region refs (`[world]` warnings) — same Class A family

Region refs aren't only in post_ops: a zone `spawn` can carry `region:` and
scatter the entity inside it (`server/game/world.ts:175`). An unguarded spawn
naming a region that was never registered warns `[world] spawn '<e>' in '<z>'
names unknown region '<r>' — skipped` (`world.ts:179`) and spawns nothing. This
is the same Class A naming problem on a different path; the post_op analysis
missed it. Sweeping all 1190 zones' spawn region refs found **exactly one** miss:
zone_42_42's `goblin_totem → goblin_outpost`.

Root cause: the `goblin_marker.json` prefab declared `"region": "goblin_outpost"`,
but **the engine never reads a prefab's `region` field** (it isn't in the `Prefab`
type, and only the *stamp op's* `region` registers a region — `index.ts:1287`).
So the field was dead data and the region never existed. Fixed 2026-06-11: moved
the `region` onto the zone's `goblin_marker` stamp op (where every other zone
puts it) and removed the dead field from the prefab.

### Small regions silently under-fill spawns (Class B)

Proving the totem fix exposed a separate pre-existing Class B bug:
`_findFreeTileInRegion` (`world.ts:235`) insets 1 tile on every side, so a region
≤3 tiles wide collapses to a single usable tile — `Math.random() * (w-2)` floors
to 0. A `count: 3` spawn then places 1 and silently drops the rest (null return,
no warning). The `goblin_marker` was 3×3 → only 1/3 totems. Fixed for this zone
by enlarging the marker prefab to 5×5 (inset leaves a 3×3 core, all 3 totems
spawn). The underlying `_findFreeTileInRegion` inset is unchanged — a global fix
(skip the inset for tiny regions) is the broader option if this recurs.

### Class B is the remaining genuine noise

The `scatter_sites 'plot': placed N/M (spacing too tight)` and `does not fit any
free space` lines are Class B (capacity), genuinely common in villages where the
fixed plot spacing is too tight for the free area after reserves/fringe. These
stay as-is unless prioritized — see Q4.

## Open questions / investigation checklist

> **Updated 2026-06-11:** Q1 is answered — the pervasive `fountain`/`market`
> spam was *not* pipeline drift in post_ops; it's the feature-operator naming bug
> above. Q2's mismatch is quantified (4 zones / 7 refs). Q3 confirmed: `generateZoneGrid`
> runs post_ops, so `named_regions` includes regions created by *existing*
> post_ops — but not regions a model creates mid-response (as the doc already
> noted). The original checklist is kept below for reference.

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

## Fixes applied / deferred (2026-06-11)

- **[DONE] Fountain/market route naming bug** — routed `from_tag` instead of the
  bare stamped-region name. See the fountain/market section above.
- **[DONE] Beach operators register a region** — `fill` gained an optional
  `region` field; beaches register their sand strip. See the `beach_*` section.
  This is the "fix the operator to register the expected region" fix, scoped to
  the one place it was actually missing rather than a broad biome rewrite.
- **[DEFERRED] Validate region refs into the repair round.** Add region-ref
  checking to `checkPostOps` in `pipeline/lib/refValidate.ts` (where prefab/tile
  refs are already validated; `validateReferences` runs the wired repair loop —
  *not* `collectBodyErrors`, which only does structural/body checks). Deferred
  2026-06-11: after the two fixes above the existing backlog is clean, so this is
  purely preventive for future model output. Design notes when revisited:
  - Allow-list = the target zone's `named_regions` (thread in the already-built
    `zoneContexts`, or generate the zone). **Never** allow from the `features`
    list — feature ids ≠ region ids (the `beach_*` trap).
  - Reference fields to check: `in_region`, `center_of_region`, `near_region`,
    `relative_to`, `if_region`, and point/bounds `region` refs.
  - **False-positive trap:** post_ops can create regions later ops reference, and
    `at_tag` stamps register `<site_id>_<region>`, not the bare `region:` value
    (`index.ts:1287`). A naive "must be in named_regions" check rejects valid
    self-created regions and burns repair cycles. Either model the prefixing or
    err toward false-negatives (only flag refs that match neither named_regions
    nor any same-response `region:`/`id:` write, allowing substring matches).
- **[OPTIONAL] Tighten the prompt** to forbid region refs outside the listed
  `named_regions`. Cheap, helps capable models, unreliable for weak ones.

## Anchor references

- Emit sites: `server/game/mapgen/index.ts` (search `not found`, `does not fit`, `no path`, `too tight`)
- Region model: `server/game/mapgen/blackboard.ts:109,251`
- Context surfaced to the model: `pipeline/lib/context.ts:28,59,90,114`
- Repair-round hooks: `pipeline/lib/refValidate.ts` → `validateReferences`/`checkPostOps`
  (referential refs: prefab/tile/portal/region), and `pipeline/implementer.ts` →
  `collectBodyErrors` (structural: names, coordinate bans, prefab grids)
