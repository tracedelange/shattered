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
| `fill` | flat ground | ✅ | rect/bounds fill; `only_over: [tile,…]` to skip non-matching cells |
| `region` | named rect/circle/ellipse/polygon area | ✅ | registers a region feature; `walls` rect-only; `only_over: [tile,…]` preserves already-placed terrain inside the footprint (e.g. `only_over: [grass]` keeps trees from an earlier noise_patch) |
| `noise_patch` | organic coverage (forest, marsh, rubble) | ✅ | the Technique-4 feature-noise mechanism; `over: [tile,…]` already built-in |
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
| `bsp` | recursive room/block partition (built interiors, dense towns) | ✅ | splits bounds, carves a room per leaf, joins siblings with L-shaped (4-connected) corridors; registers each room (`<prefix>_N`) + the largest as `<prefix>_main`; optional `wall` fill for non-wall zones. **Rooms are rectangular** — for round/irregular rooms use a hand-authored `stamp` vault or the wall-outline primitive (see Shape support). **Future:** door tiles where corridors meet room walls. |
| `chambers` | organic/non-rect walled rooms | ☐ | a built-interior generator whose rooms are circles/ellipses/blobs instead of rects — round towers, oval halls, cavern-chambers with walls. Needs the wall-outline primitive (below) to enclose non-rect shapes with a door. |
| `cluster` | organic settlement growth | ☐ | optional; grow buildings outward from a seed along roads |

### Network (connect sites — coherent paths)

| Atom | Family | Status | Notes / what's needed |
|------|--------|--------|-----------------------|
| `route` | cost-aware path between endpoints | ✅ | A* over `cost`; bends around water/walls; routes *around* BUILDING footprints; `through: [tile]` lets roads cut through clearable obstacles (e.g. forest) at a penalty; modes: `from`/`from_tag` (star to `to`) or `edges: <tag>` (carve a network's edges); reuses earlier roads; never paves over anchor (door) cells |
| `network` | smart edge selection (MST + loops / star) | ✅ | gathers nodes by `nodes_tag` + explicit `nodes`; `method: mst` (Prim's) spans all nodes minimally, `extra_edges` (0..1) adds shortest non-tree links back as loops; `method: star` links all to `hub`; emits `edge` features for `route { edges }`. **Future:** Gabriel/Delaunay candidate set instead of complete-graph MST for very large node counts. |
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
| `ensure_reach` | reachability guarantee (repair pass) | ✅ | floods walkable tiles from entry seeds (`from`/`from_tag`); `ensure_tags` carves a corridor to any stranded feature (e.g. a door), `ensure_all` connects every walkable pocket; carves through `through` obstacles (wall/tree); report-only without `carve`. The connectivity guarantee, available to any recipe — not just `cave`. |
| connectivity carve (in `cave`) | reachability within a cavern | ✅ | `cave` still self-connects its open field; corridors are L-shaped (4-connected) so they are traversable by the 4-directional movement engine. |
| clearance | keep doors/portals unblocked | ☐ | small pass: ensure the cell in front of each door anchor is walkable |

---

## Recipes (compositions of atoms)

A recipe is the per-zone op stack. The village proves the pattern:

**Village / camp / settlement** (verified in spike — forest + 7 rotated houses + road network):
1. `noise_patch` → sparse forest substrate
2. `region` → central well/plaza (the hearth focal point)
3. `scatter_sites tags:[plot]` → blue-noise building plots (on grass, spaced)
4. `stamp at_tag:plot rotate:random` → a house prefab per plot; registers `door` anchors, claims BUILDING
5. `network nodes_tag:door nodes:[well] method:mst extra_edges:0.25` → MST + loop edges over houses and the well (houses linked to each other, not just radially)
6. `route edges:village_road through:[tree]` → carve each edge; A* cuts forest, routes around buildings, doors preserved
7. *(future)* `ensure_reach` → guarantee every door reachable (today a door fully boxed by true barriers logs a warning)

**Cavern** (verified in spike): `cave` (organic, connected) + `noise_patch` (rubble/damp) + spawn at the auto-anchor.

**Built dungeon** (planned): `bsp` (rooms+corridors) + `stamp` (a vault room) + `scatter` (debris) + `ensure_reach`.

**Ruined village** (planned): `field` + `cave` rubble + `scatter_sites` of broken `stamp` buildings + decayed `route` + `ensure_reach`.

---

## Recommended next-session order

1. ✅ ~~`stamp`~~ — done. Sites become real buildings with doors; the village recipe is end-to-end.
2. ✅ ~~`network`~~ — done. MST + loop edges; houses linked to each other, not just radially.
3. ✅ ~~`ensure_reach`~~ — done. Standalone reachability repair; auto-carves to stranded doors/pockets.
4. ✅ ~~`bsp`~~ — done. Built interiors: rooms + corridors, fully connected.
5. **Elevation field on the Blackboard** — the one substrate addition that unlocks coastlines, drainage-correct rivers (`flow`), and elevation framing. **Next.**
6. **Prefab library** — move prefabs out of inline op YAML into `world/prefabs/*.yaml` referenced by id, so the LLM authors a reusable vault set.
7. **`bsp` doors + `stamp` into rooms** — place door tiles at corridor/room boundaries; stamp vaults into chosen BSP rooms (a throne room, an armory).
8. **Wall-outline primitive + non-rect walled rooms** — make `region { walls }` work for circle/ellipse/polygon (retire the rect-only limitation), then the `chambers` atom for round towers / oval halls. (Arbitrary non-rect buildings are already possible today via hand-authored `stamp` vaults.)

## Testing

Persistent fixtures + assertion harness — `npm run test:gen` (or `npx tsx
tools/test-generators.ts`). Fixtures are plain ZoneDef **YAML** under
`tools/generator-fixtures/`, kept OUT of `world/zones/` so they never enter the
live world graph. The harness loads each, runs the engine, asserts invariants
(determinism + connectivity), and renders a PNG to `world/renders/` (gitignored)
for visual inspection. Current fixtures:

- `gen_cavern` — `cave`; asserts the open field is fully 4-connected.
- `gen_keep` — `bsp`; asserts multiple rooms carved and all rooms connected.
- `gen_village` — full settlement recipe; asserts every plot is stamped and
  every door is reachable from the well.
- `gen_two_rooms` — two disconnected rooms; asserts `ensure_reach` tunnels them
  into one component.

Renders land in `world/renders/gen_*.png` (gitignored) — open them to eyeball
each recipe after a run.

Add a fixture + a `CHECKS[id]` entry whenever a new atom or recipe lands. The
harness already caught one real bug (cave tunnels were Bresenham-diagonal, hence
not traversable by the 4-directional engine — now L-shaped/4-connected).

## Shape support (rooms & buildings)

Where non-rectangular geometry stands today, and the gap:

- **Open areas: arbitrary.** `cave`/`voronoi` are organic; `region`/`shape` take `circle`/`ellipse`/`polygon` floors.
- **Walled buildings, hand-authored: arbitrary.** A `stamp` prefab is an ASCII footprint — any shape with walls/doors you draw, rotated 4 ways. Grid-aligned and authored, not procedural.
- **Walled rooms, procedural: rectangles only.** `bsp` rooms are rects; `region`'s `walls` field only strokes a rect border (circle/ellipse/polygon walls are silently discarded — engine `paintWalls` is rect-only).

**The enabler (planned): a wall-outline primitive.** Stroke the perimeter of *any* shape (circle/ellipse/polygon, or a filled region's edge) with a wall tile and cut a door. This retires the long-standing rect-only-walls limitation, makes `region { walls }` work for every shape, and is the prerequisite for the `chambers` atom (round towers, oval halls). Needs: a perimeter/edge-trace over a shape mask + a door-cut at a chosen side, wired into the `region` op so `walls` stops being silently dropped for non-rect shapes.

## Cross-cutting infra still owed

- **Render overlays for the masks.** The renderer can now draw `cost` as a heatmap, `keepout` as hatching, and `features` as labeled dots (the Blackboard is returned on `ZoneGrid`). Huge for tuning — do this early next session.
- **Pipeline surfacing.** New ops (`scatter_sites`, `route`, `cave`, `voronoi`) are not yet documented in the Implementer prompt or lints. Once the atom set stabilizes, document the recipes (not just the ops) so the LLM composes them, and add lints (e.g. `route` with no reachable target, `scatter_sites` over-subscribed).
- **Seed bible + fresh zones.** Existing zones predate this model; on the fork they'll be regenerated. The archetype/landmark/focal fields already on `ZoneDef` carry forward.
