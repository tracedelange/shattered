# Zone Generators — Layer Catalog & Roadmap

Living document. The generation model is **stacked passes (atoms) over a shared
Blackboard**: each atom reads and writes the same four layers, so later passes
see earlier ones' output and the result coheres. A zone is a *recipe* — an
ordered list of ops — not a monolithic generator.

The LLM's job is to **pick the recipe + parameters and author set-pieces**, never
to hand-place geometry by coordinate. Geometry is the algorithm's job; meaning is
the LLM's.

---

## The Blackboard (the substrate everything shares)

`server/game/mapgen/blackboard.ts`. Four co-registered layers + determinism:

| Layer | Type | Purpose | Written by | Read by |
|-------|------|---------|-----------|---------|
| `grid` | `string[][]` | visible tiles | every paint atom | renderer, runtime |
| `cost` | `Float32Array` | routing weight; `Infinity` = impassable | `paint()`, `syncCostFromGrid()` | network atoms |
| `keepout` | `Uint8Array` | claim bitmask (`CLAIM.*`) | placement atoms | placement/network atoms |
| `features` | `FeatureStore` | named sites/anchors/regions/edges + metadata | most atoms | later atoms by id/tag |

- Masks are flat, indexed `y*width + x`.
- `cost` is derived from tiles on demand (`syncCostFromGrid()`); `keepout` is written explicitly (not derivable from tiles).
- Determinism: `bb.subRng(label)` gives an independent seeded stream per label.
- `features.regionMap()` derives the legacy `bounds` map (region id → AABB) for spawns/spawn_point.
- `PointRef` supports `{ feature: <id> }`, so any atom can target a generated feature by name instead of a coordinate.

**Claim categories** (`CLAIM`): `RESERVED`, `BUILDING`, `ROAD`, `WATER`, `SITE`. Bitmask — a cell can carry several at once.

---

## Atom catalog

Status: ✅ built · ◐ partial · ☐ planned. "Family" is what the atom produces.

### Substrate (lay the base layer)

| Atom | Family | Status | Notes / what's needed |
|------|--------|--------|-----------------------|
| `fill` | flat ground | ✅ | rect/bounds fill |
| `region` | named rect/circle/ellipse/polygon area | ✅ | registers a region feature; `walls` rect-only |
| `noise_patch` | organic coverage (forest, marsh, rubble) | ✅ | the Technique-4 feature-noise mechanism |
| `voronoi` | irregular territory partition | ✅ | weighted seeds, optional seams; registers each cell as a region |
| `cave` | organic enclosed cavern | ✅ | CA + connectivity guarantee + auto open-anchor; tune via `fill` (~0.56) |
| `field` | biome blobs from a noise threshold | ◐ | generalize `noise_patch` into a first-class multi-tile terrain pass (sand/scree/marsh by elevation/noise) |
| `flow` | rivers / ravines / faults | ◐ | `path` covers basic rivers; a cost-following carve (downhill) needs an elevation field |
| `terrace` / elevation field | hills, coastlines, drainage | ☐ | needs an **elevation `Float32Array`** added to the Blackboard; unlocks beaches, ranged-advantage framing, realistic rivers |

### Placement (drop discrete sites/structures)

| Atom | Family | Status | Notes / what's needed |
|------|--------|--------|-----------------------|
| `scatter_sites` | blue-noise points (village/camp/ruin backbone) | ✅ | Poisson-disk; respects keepout & `over` tiles; reserves discs; optional `clear` plaza |
| `stamp` | place a hand-authored prefab/vault at a site | ✅ | inline prefab (ASCII `data` + `legend` + `anchors`); centered placement at `at`/`at_tag`; seeded rotation; claims footprint BUILDING; registers `door` anchors (left walkable) + optional interior region. **Future:** a prefab *library* (`world/prefabs/*.yaml`) referenced by id, and mirroring — needs prefab defs plumbed into `generateZoneGrid`. |
| `bsp` | recursive room/block partition (built interiors, dense towns) | ☐ | the inverse of `cave`; rooms + doors + a corridor graph. Needs: BSP split, room carving, door placement, register rooms as regions. |
| `cluster` | organic settlement growth | ☐ | optional; grow buildings outward from a seed along roads |

### Network (connect sites — coherent paths)

| Atom | Family | Status | Notes / what's needed |
|------|--------|--------|-----------------------|
| `route` | cost-aware path between endpoints | ✅ | A* over `cost`; bends around water/walls; routes *around* BUILDING footprints; `through: [tile]` lets roads cut through clearable obstacles (e.g. forest) at a penalty; `from_tag` fans out (star); reuses earlier roads; never paves over anchor (door) cells |
| `network` | smart edge selection (MST / Gabriel graph) | ☐ | **next priority with `stamp`.** Pick *which* sites connect (minimal/aesthetic) instead of a star, emit `edge` features, then hand edges to `route`. Needs: MST/Gabriel over site features, then a `route`-each-edge pass. |
| `maze` | labyrinths | ☐ | recursive-backtracker / growing-tree carve; for genuinely explorable dead-end structure |
| `walk` | meandering single corridor (drunkard's walk) | ☐ | seeded random walk carve; winding tunnels |

### Detail (dress the result)

| Atom | Family | Status | Notes / what's needed |
|------|--------|--------|-----------------------|
| `scatter` | sparse props (rocks, debris, lilypads) | ✅ | `over`-filtered |
| `noise_patch` | organic overlays | ✅ | (also a substrate atom) |
| `sketch` | literal ASCII stamp | ✅ | precursor to `stamp` |
| `border` | edge treatment (beach around water, wall around floor, tree-thin near roads) | ◐ | `voronoi` has a seam pass; generalize into a standalone "outline tile A where it meets tile B / claim X" atom |

### Repair (guarantee validity — runs last)

| Atom | Family | Status | Notes / what's needed |
|------|--------|--------|-----------------------|
| connectivity carve | reachability guarantee | ◐ | built **inside** `cave`; **extract to a standalone pass** any recipe can call (flood from spawn/portals, carve to orphaned regions). Kills the door-doesn't-meet-path bug as a class. |
| `ensure_reach` | assert key features reachable | ☐ | flood from spawn_point; warn/carve if any door/region/site is unreachable |
| clearance | keep doors/portals unblocked | ☐ | small pass: ensure the cell in front of each door anchor is walkable |

---

## Recipes (compositions of atoms)

A recipe is the per-zone op stack. The village proves the pattern:

**Village / camp / settlement** (verified in spike — forest + 7 rotated houses + road network):
1. `noise_patch` → sparse forest substrate
2. `region` → central well/plaza (the hearth focal point)
3. `scatter_sites tags:[plot]` → blue-noise building plots (on grass, spaced)
4. `stamp at_tag:plot rotate:random` → a house prefab per plot; registers `door` anchors, claims BUILDING
5. `route from_tag:door to:{region:well} through:[tree]` → road network from every door to the well, cutting forest, routing around buildings, doors preserved
6. *(future)* `network` → replace the door→well star with an MST for nicer topology
7. *(future)* `ensure_reach` → guarantee every door reachable (today a door fully boxed by true barriers logs a warning)

**Cavern** (verified in spike): `cave` (organic, connected) + `noise_patch` (rubble/damp) + spawn at the auto-anchor.

**Built dungeon** (planned): `bsp` (rooms+corridors) + `stamp` (a vault room) + `scatter` (debris) + `ensure_reach`.

**Ruined village** (planned): `field` + `cave` rubble + `scatter_sites` of broken `stamp` buildings + decayed `route` + `ensure_reach`.

---

## Recommended next-session order

1. ✅ ~~`stamp`~~ — done. Sites become real buildings with doors; the village recipe is end-to-end.
2. **`network`** (MST/Gabriel) — upgrades `route` from a door→hub star to real road topology (houses linked to each other, not just radially). Emit `edge` features, route each edge.
3. **Extract connectivity to a standalone `ensure_reach`** — make the reachability guarantee available to every recipe, not just `cave`; would auto-fix a boxed door instead of warning.
4. **`bsp`** — covers all built interiors (the organic/built complement to `cave`).
5. **Elevation field on the Blackboard** — the one substrate addition that unlocks coastlines, drainage-correct rivers (`flow`), and elevation framing.
6. **Prefab library** — move prefabs out of inline op YAML into `world/prefabs/*.yaml` referenced by id, so the LLM authors a reusable vault set.

## Cross-cutting infra still owed

- **Render overlays for the masks.** The renderer can now draw `cost` as a heatmap, `keepout` as hatching, and `features` as labeled dots (the Blackboard is returned on `ZoneGrid`). Huge for tuning — do this early next session.
- **Pipeline surfacing.** New ops (`scatter_sites`, `route`, `cave`, `voronoi`) are not yet documented in the Implementer prompt or lints. Once the atom set stabilizes, document the recipes (not just the ops) so the LLM composes them, and add lints (e.g. `route` with no reachable target, `scatter_sites` over-subscribed).
- **Seed bible + fresh zones.** Existing zones predate this model; on the fork they'll be regenerated. The archetype/landmark/focal fields already on `ZoneDef` carry forward.
