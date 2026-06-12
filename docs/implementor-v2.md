# Implementor v2 — Design Document

## Overview

The Gardener / Implementor pipeline produces incremental world changes on top of a
frozen procedurally-generated base. The world-gen pipeline has already done its job —
every zone has a seeded, deterministic grid. The Implementor's role is
**individualization**: enriching specific zones with content that makes them distinct,
connected, and inhabited.

```
World-gen pipeline (frozen)          Gardener / Implementor loop (mutable)
─────────────────────────────        ────────────────────────────────────────
biomes/ + world/biome-params.json    world/zones/*.json  (post_ops, features)
  │                                  world/prefabs/*.json
  ▼                                  world/entities/mobs/*.yaml
generateWorld() + resolveBiomeOps()  world/quests/*.yaml
  │                                  world/lore/*.yaml
  ▼
zone files (biome, seed, connections)
  ← implementor never touches these fields
```

The Implementor appends to zone files and creates new supporting files. It never
re-runs generation, never modifies `biome` / `seed` / `ops`, and never emits
coordinates.

---

## Core Principles

### The Coordinate Boundary

The model must never emit, receive, or reason about X/Y tile coordinates. Every
spatial reference in Implementor output uses one of the semantic placement
descriptors defined below. The generation engine is responsible for resolving all
descriptors to actual grid positions at load time.

### The Two Layers

| Layer | Owned by | Mutable by Implementor? |
|---|---|---|
| Biome pipeline (`ops`) | `biomes/*.ts` + `biome-params.json` | No |
| Zone instance (`post_ops`, `features`, `spawns`) | `world/zones/*.json` | Yes — append only |
| Prefabs | `world/prefabs/*.json` | Yes — create new |
| Entities, quests, lore | `world/entities/`, `world/quests/`, `world/lore/` | Yes — create/modify |

"Append only" on zone files means the Implementor only adds entries to `post_ops`,
`features[]`, and weight maps. It never rewrites or removes existing pipeline ops.

### What the Model Knows About a Zone

Before executing an opportunity, the Implementor receives a **zone context** object:

```ts
interface ZoneContext {
  id: string;
  biome: string;
  display_name: string;
  level_band: { tier: number; minLevel: number; maxLevel: number };
  connections: Record<string, string>;   // cardinal directions → zone ids
  features: string[];                    // active feature ids
  named_regions: string[];               // region ids produced by the biome pipeline
                                         // e.g. ["building_0", "building_1", "market", "fountain"]
  tile_types_present: string[];          // tile ids that appear in the grid
                                         // e.g. ["grass", "wall", "dirt", "wood_floor", "water"]
  feature_weights: Record<string, number>;
  existing_post_ops: number;             // count only — model does not see existing post_ops
}
```

`named_regions` and `tile_types_present` are derived from the live grid at context-build
time and give the model semantic handles for placement — without exposing coordinates.

---

## The Post-Ops Layer

`post_ops` is a `GenOp[]` array in a zone file that executes after the biome pipeline
resolves. It operates on the already-generated grid. Ops use the same types as the
biome pipeline (`stamp`, `scatter`, `noise_patch`, `route`, `fill`, `portal`) plus
new placement descriptor variants (see below).

```json
{
  "id": "village_36_33",
  "biome": "village",
  "seed": "abc123",
  "post_ops": [
    {
      "type": "stamp",
      "at": { "near_tile": "grass", "near_region": "building", "margin": 2 },
      "prefab": "sewer_entrance",
      "seed": "sewer_entrance_village_36_33"
    },
    {
      "type": "portal",
      "at": { "anchor_of": "sewer_entrance", "anchor": "descend" },
      "target_zone": "sewer_village_36_33"
    }
  ]
}
```

**Execution order:** biome pipeline ops → constraint/feature ops → `post_ops` in array
order. Post-ops run last and can overwrite tiles produced by the biome pipeline.

**Failure behaviour:** if a placement descriptor cannot be resolved (e.g., no free grass
tile near any building exists), the op is skipped and logged. Post-ops never crash zone
load.

---

## Semantic Placement Descriptors

These are the valid shapes for `at` in any op inside `post_ops`. The model picks the
descriptor that matches the *intent*; the engine finds the actual tile.

### Tile-relative

```jsonc
{ "near_tile": "grass", "margin": 2 }
// Free tile of type "grass", at least `margin` tiles from any wall/blocking tile.

{ "near_tile": "grass", "near_region": "building" }
// Free grass tile adjacent (within 3 tiles) to any bounding box named "building*".

{ "on_tile": "dirt" }
// Any tile of exactly this type. Useful for placing things on existing roads/paths.

{ "random_free": true }
// Any unclaimed passable tile. Last resort.
```

### Region-relative

```jsonc
{ "in_region": "market" }
// Free tile inside the named region's bounding box.

{ "near_region": "fountain", "distance": 4 }
// Free tile within `distance` tiles of the named region centroid.

{ "center_of_region": "market" }
// The centroid tile of the named region. Best-effort free tile nearby if centroid is blocked.
```

### Structural

```jsonc
{ "free_edge": "south", "inset": 2 }
// Free tile on the south perimeter, `inset` tiles from the boundary.

{ "anchor_of": "sewer_entrance", "anchor": "descend" }
// Resolves to the tile tagged with anchor key "descend" from the most recently
// stamped prefab named "sewer_entrance" in this post_ops sequence.
```

### Explicit override (authored zones only)

```jsonc
{ "x": 12, "y": 8 }
// Absolute position. Valid only in hand-authored zone files, never emitted by the
// Implementor. Linter rejects this in any Implementor-produced file.
```

---

## The Prefab System

A prefab is an ASCII tile grid with a legend and optional anchor map. Prefabs can be
defined inline in a `post_op` or as named entries in `world/prefabs/`.

### Inline prefab

```json
{
  "type": "stamp",
  "at": { "near_region": "building", "near_tile": "grass" },
  "prefab": {
    "data": "WWWWW\nWFFFW\nWFDFW\nWFFFW\nWWWWW",
    "legend": { "W": "wall", "F": "wood_floor", "D": "door" },
    "anchors": { "D": "entrance" }
  }
}
```

### Named prefab (`world/prefabs/sewer_entrance.json`)

```json
{
  "id": "sewer_entrance",
  "description": "3x3 stone descent with a portal tile at center.",
  "data": "SSS\nSDS\nSSS",
  "legend": { "S": "stone_floor", "D": "descend_portal" },
  "anchors": { "D": "descend" }
}
```

Referenced in a `post_op` by id string: `"prefab": "sewer_entrance"`.

### Prefab authoring rules for the model

- Grid must be rectangular (all rows same length).
- Every character in `data` must appear in `legend`.
- Anchors map a legend character to a semantic label. Multiple tiles of the same
  character all get the anchor tag; placement ops targeting that anchor use the first
  free one.
- No tile dimensions, no coordinates. The prefab describes *shape and content only*.

---

## Portal / Zone Connection

A `portal` op placed in `post_ops` creates a traversable tile that moves the player
to a target zone's spawn point on contact. The reverse connection (returning to the
surface) is declared in the target zone's `connections` map.

```jsonc
// In village_36_33.json post_ops:
{
  "type": "portal",
  "at": { "anchor_of": "sewer_entrance", "anchor": "descend" },
  "target_zone": "sewer_village_36_33",
  "transition": "descend"    // optional — drives client animation ("descend" | "ascend" | "teleport")
}

// In sewer_village_36_33.json:
{
  "id": "sewer_village_36_33",
  "biome": "sewer",
  "seed": "sewer_village_36_33",
  "connections": { "surface": "village_36_33" }
}
```

The loader auto-synthesizes a return portal in the target zone pointing back to the
parent if `connections.surface` (or any non-cardinal direction key) is present and no
explicit return portal exists. This means the Implementor only writes the outbound
portal; the inbound is free.

---

## Opportunity Taxonomy

Each opportunity type defines what the Gardener may propose and what the Implementor
is permitted to produce. The Implementor's output is validated against the schema for
the opportunity's type before any files are written.

---

### `zone_enhance`

**Intent:** Add content to an existing generated zone without structural changes.

**Gardener provides:**
- Target zone id
- Narrative intent (e.g. "add a blacksmith's forge area near the market square")
- Suggested prefabs or features (optional)

**Implementor may produce:**
- Append to `post_ops` in the target zone (stamp, scatter, noise_patch, portal)
- Create new entries in `world/prefabs/`
- Adjust `feature_weights` on the target zone
- Append to `features[]` on the target zone

**Implementor may NOT:**
- Modify `biome`, `seed`, `ops`, `opParams`, `zoneParams`
- Write X/Y coordinates
- Remove existing `post_ops`

---

### `zone_connect`

**Intent:** Create a new zone and link it to an existing one via a portal.

**Gardener provides:**
- Parent zone id
- New zone narrative intent (e.g. "a rat-infested sewer beneath the village")
- Suggested biome for the new zone
- Suggested connection label (e.g. "sewer", "cellar", "cave")

**Implementor may produce:**
- New zone stub: `world/zones/<id>.json` with `biome`, `seed`, `display_name`,
  `level_band`, `connections`, optional `features[]`, optional `post_ops`
- Append portal `post_op` to the parent zone
- Create new prefabs (for the entrance/exit stamps)

**Auto-wired by the engine:**
- Return portal from new zone back to parent (derived from `connections.surface`)

---

### `mob_populate`

**Intent:** Adjust the creature composition of a zone.

**Gardener provides:**
- Target zone id
- Narrative intent (e.g. "bandit camp has taken over — replace generic guards with
  bandits and add a bandit captain")
- Suggested mob ids or types

**Implementor may produce:**
- Append `spawns` to the target zone (zone-wide or region-targeted)
- Append `scatter` post-ops for named/boss mobs with semantic placement
- Create new mob templates in `world/entities/mobs/` if suggested mobs don't exist

**Implementor may NOT:**
- Place mobs at X/Y coordinates

---

### `prefab_create`

**Intent:** Define a reusable spatial structure for use in future opportunities.

**Gardener provides:**
- Prefab narrative intent (e.g. "a well with a stone surround")
- Suggested tile types

**Implementor may produce:**
- New `world/prefabs/<id>.json` entry

This opportunity type exists so the library can grow independently of placement.
The Gardener may propose a prefab in the same batch as a `zone_enhance` that uses it.

---

### `feature_create`

**Intent:** Define a new named feature (a reusable blueprint of ops) for use in
biome `defaultConstraints` or zone `features[]`.

**Gardener provides:**
- Feature narrative intent
- Intended biome context (which biomes this feature makes sense for)

**Implementor may produce:**
- New entry in `server/game/mapgen/features/<id>.ts` (or a JSON equivalent loaded
  by the feature registry)
- The feature is a `BiomeConstraint`-shaped object: an ops array using standard
  placement primitives

**Note:** Features run inside the biome pipeline and use pipeline placement
primitives, not post-ops semantic descriptors. The Implementor must stay within
the existing feature op vocabulary.

---

### `quest_add`

**Intent:** Create a new quest tied to existing world content.

**Gardener provides:**
- Narrative intent and suggested zone(s) / mob(s) involved
- Quest tier/difficulty suggestion

**Implementor may produce:**
- New `world/quests/<id>.yaml`
- Quest objectives reference zone ids, mob template ids, and item ids by name only

---

### `lore_refactor`

**Intent:** Revise narrative text, names, or world-bible entries for consistency or
quality.

**Gardener provides:**
- Specific files or sections to revise
- Coherence notes (e.g. "faction name changed from Redcloak to Ember Guard everywhere")

**Implementor may produce:**
- Edits to `world/lore/*.yaml`, zone `display_name` fields, mob `name` fields, quest text

**Implementor may NOT:**
- Change any structural fields (biome, connections, ops)

---

### `tile_create`

**Intent:** Add a new tile type to a tileset.

**Gardener provides:**
- Tile narrative intent and suggested tileset
- Whether the tile should be blocking, passable, or a special (portal, door)

**Implementor may produce:**
- New entry in the appropriate `world/tilesets/<name>.json`
- New entry in `shared/constants.ts` blocking set if applicable

---

### `biome_modify`

**Intent:** Tune an existing biome's param bounds, spawn weights, or feature weights.
Does not change pipeline structure.

**Gardener provides:**
- Biome id
- What aspect to tune and why (e.g. "villages feel too sparse — raise building count
  minimum")

**Implementor may produce:**
- Edits to `world/biome-params.json` (min/max overrides for params)
- Edits to `featureWeights` in the `BiomeDef` source

**Implementor may NOT:**
- Add or remove pipeline ops
- Create a new biome (use `biome_create` for that)

---

### `biome_create`

**Intent:** Define an entirely new biome type.

**Status:** Gated. Only proposed by the Gardener when an existing biome cannot
plausibly cover the narrative need, and only executed after a human review step.
A newly created biome is flagged `draft: true` in the registry until validated by a
workbench preview pass.

**Implementor may produce:**
- New `server/game/mapgen/biomes/<id>.ts`
- Registration in `server/game/mapgen/biomes/index.ts`
- Seed entries in `world/biome-params.json`

---

## Opportunity File Format

The handoff artifact between Gardener and Implementor. Human-readable and
human-editable.

```yaml
# world/pipeline/opportunities.yaml

- id: opp_042
  type: zone_connect
  priority: high
  status: pending          # pending | in_progress | done | skipped
  target_zone: village_36_33
  intent: >
    A hidden sewer network runs beneath the village. Rats and worse have moved in.
    There should be a descend point near the blacksmith — thematically, the blacksmith
    knows about it but keeps quiet.
  suggested_biome: sewer
  suggested_connection_label: sewer
  suggested_prefabs:
    - id: sewer_entrance
      description: Stone-framed descent hatch, 3x3, portal tile at center.
  suggested_mobs:
    - giant_rat
    - sewer_troll
  level_band_hint: same_as_parent

- id: opp_043
  type: zone_enhance
  priority: medium
  status: pending
  target_zone: village_36_33
  intent: >
    Add a notice board near the market square where quests can be posted.
    Should feel like a natural gathering point.
  suggested_prefabs:
    - id: notice_board
      description: Single tile notice_board furniture item on stone floor surround.
```

---

## Implementor Execution Contract

For each opportunity the Implementor receives:

1. The opportunity record (above)
2. Zone context objects for all referenced zones (see `ZoneContext` above)
3. The list of existing prefab ids
4. The list of existing mob template ids
5. The list of existing tile type ids (from the relevant tileset)

The Implementor must return a list of **file operations**:

```ts
type FileOp =
  | { op: 'create'; path: string; content: string }
  | { op: 'append_post_ops'; zone_id: string; ops: GenOp[] }
  | { op: 'append_features'; zone_id: string; features: string[] }
  | { op: 'patch_zone_field'; zone_id: string; field: 'display_name' | 'level_band'; value: unknown };
```

`append_post_ops` is the primary mutation. The pipeline runner validates each op
against a schema that rejects any `at` descriptor containing `x`/`y` keys before
writing.

The Implementor never calls `writeFileSync` directly — all writes go through the
pipeline runner's validated write layer.

---

## End-to-End Example: Sewer Beneath the Village

**Opportunity:** `opp_042` (zone_connect, above)

**Step 1 — Implementor creates the prefab**

`world/prefabs/sewer_entrance.json`:
```json
{
  "id": "sewer_entrance",
  "description": "Stone-framed descent hatch. Portal tile at center.",
  "data": "SSS\nSDS\nSSS",
  "legend": { "S": "stone_floor", "D": "descend_portal" },
  "anchors": { "D": "descend" }
}
```

**Step 2 — Implementor appends to the village**

`append_post_ops` on `village_36_33`:
```json
[
  {
    "type": "stamp",
    "at": { "near_region": "building", "near_tile": "grass", "margin": 1 },
    "prefab": "sewer_entrance",
    "seed": "sewer_entrance_village_36_33"
  },
  {
    "type": "portal",
    "at": { "anchor_of": "sewer_entrance", "anchor": "descend" },
    "target_zone": "sewer_village_36_33",
    "transition": "descend"
  }
]
```

**Step 3 — Implementor creates the sewer zone**

`world/zones/sewer_village_36_33.json`:
```json
{
  "id": "sewer_village_36_33",
  "display_name": "Village Sewers",
  "biome": "sewer",
  "seed": "sewer_village_36_33",
  "level_band": { "tier": 2, "minLevel": 5, "maxLevel": 10 },
  "spawn_point": { "focal": true },
  "connections": { "surface": "village_36_33" }
}
```

**What the engine does automatically:**

- `resolveBiomeOps` runs the sewer pipeline on the new zone's seed → full sewer grid
- Loader detects `connections.surface` with no return portal → synthesizes a return
  `portal` op in the sewer zone pointing back to `village_36_33`
- `village_36_33` post_ops execute after biome pipeline: the stamp finds a free grass
  tile near any building region, places the entrance prefab, then the portal op
  resolves the `descend` anchor to the portal tile's position

**What was never emitted by the model:**
- Any X/Y coordinate
- Any modification to `village_36_33`'s `biome`, `seed`, or `ops`
- Any reference to the village's internal grid state beyond `named_regions` and
  `tile_types_present`

---

## Engine Changes Required

Scoped additions — nothing existing breaks.

### 1. Post-ops execution pass (`server/game/mapgen/index.ts`)

`generateZoneGrid` accepts an optional `post_ops: GenOp[]`. After the main pipeline
runs, post_ops execute against the live `Blackboard`. New `at` descriptor variants
(`near_tile`, `near_region`, `in_region`, `on_tile`, `anchor_of`) are resolved here.

### 2. Semantic placement resolver

New function `resolveSemanticAt(descriptor, bb): { x: number; y: number } | null`.
Scans the Blackboard for tiles/regions matching the descriptor. Returns `null` if no
match → op is skipped with a warning.

### 3. Portal tile + op type

New tile `descend_portal` / `ascend_portal` (or generic `portal` with a `direction`
field) in tilesets. New op type `portal` in the GenOp union: places a portal tile at
the resolved position and registers the `target_zone` in zone metadata.

### 4. Named prefab registry

`world/prefabs/` directory loaded at server startup. Prefabs available by id in the
stamp op resolver. Currently stamp only accepts inline prefab objects; add id-string
lookup.

### 5. Return portal auto-synthesis (`server/world/loader.ts`)

After `resolveBiomeOps`, check `zone.connections` for non-cardinal keys (anything not
`north`/`south`/`east`/`west`). For each, if the referenced zone exists and has no
existing portal back, append a return portal op to that zone's post_ops at load time.

### 6. Implementor write layer (`pipeline/implementer.ts`)

Replace direct file writes with the validated `FileOp` model. Reject any op whose
`at` descriptor contains `x`/`y` keys. Validate prefab grids are rectangular and
fully covered by legend.

### 7. Zone context builder (`pipeline/lib/context.ts`)

New function `buildZoneContext(zoneId): ZoneContext`. Runs the generator, extracts
`named_regions` from `bounds`, `tile_types_present` from the grid, and merges with
the zone definition fields.
