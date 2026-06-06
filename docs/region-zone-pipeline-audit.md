# Region / Zone Generation Pipeline — Audit

*2026-06-05 — Focus: generation architecture & output quality*

---

## Table of Contents

1. [Pipeline Architecture](#1-pipeline-architecture)
2. [Generation Data Model](#2-generation-data-model)
3. [Generation Engine](#3-generation-engine)
4. [LLM Mechanics](#4-llm-mechanics)
5. [Issues Limiting Output Quality](#5-issues-limiting-output-quality)
6. [Prioritized Actions](#6-prioritized-actions)

---

## 1. Pipeline Architecture

The generation pipeline has two LLM agents with distinct roles, separated by a human-editable handoff artifact (`opportunities.yaml`).

### Agents

**Gardener** — reads the entire world state, identifies what is missing or weak, and produces a ranked list of opportunities. It does not write world content. Its output is a structured analysis document.

**Implementer** — picks the highest-priority pending opportunity, reads the same world state, and produces the actual content: zone YAML files, entity YAML files, quest YAML files, lore updates, and tileset additions. One invocation = one opportunity executed.

**Loop** — orchestration driver that drains the Implementer until no pending opportunities remain, then calls the Gardener to produce new ones, and repeats up to a configurable cycle limit.

### Flow

```
Gardener
  reads: all zone/entity/quest YAMLs, tilesets, lore bible, opp history
  writes: opportunities.yaml (ranked, structured list)

Implementer (×N until queue empty)
  reads: same world bundle + selected opportunity
  writes: world YAML files, lore update, tileset update
  side-effects: renders zone PNGs, appends history, git commit

Loop
  cycle: drain Implementer → run Gardener → repeat
  stops: queue empty after Gardener, max cycles reached, LLM session limit
```

### Modes

```
npm run gardener          # analysis only → writes opportunities.yaml
npm run implementer       # implement one opportunity
npm run loop              # continuous: drain → analyze → repeat
npm run render-zone       # render to PNG, no world changes
```

All pipeline runs are human-initiated. There is no automated trigger.

### What the Implementer Can Write

The Implementer's output is constrained to:
- **Zone YAML files** (`world/zones/`)
- **Entity YAML files** (`world/entities/mobs/`, items)
- **Quest YAML files** (`world/quests/`)
- **Lore bible updates** (append or replace named fields only)
- **Tileset additions** (new tile/sprite color entries; never overwrites existing keys)

It cannot write server code, modify constants, change game systems, or alter the mapgen engine. This is the central constraint shaping what kinds of world features are expressible through the pipeline.

---

## 2. Generation Data Model

This is the vocabulary available to the LLM when describing a zone.

### Zone Definition (`ZoneDef`)

```typescript
interface ZoneDef {
  id: string
  name?: string
  tileset?: string                // which tileset to render with (unsafe cast in code — see §5)
  width?: number                  // default: 40
  height?: number                 // default: 30
  default_tile?: string           // background fill before any ops run; default: 'grass'
  ops?: GenOp[]                   // ordered list of painting operations
  spawn_point?: { region: string } | { x: number; y: number }
  spawns?: ZoneSpawn[]
  portals?: ZonePortal[]
  connections?: Partial<Record<'north' | 'south' | 'east' | 'west', string>>
}
```

`ops[]` is the primary creative surface. Each op is a painting instruction applied in order — later ops overwrite earlier ones. The LLM expresses all spatial intent through this list.

### Generation Operations (`GenOp`)

Nine op types form the full expressive vocabulary:

| Op | What it does | Key parameters |
|----|-------------|----------------|
| `fill` | Paints a rectangular area with one tile | `bounds`, `tile` |
| `region` | Defines a named area, paints its floor and optionally its walls | `id`, `shape`, `at`, `tile`, `walls?` |
| `shape` | Paints a shape without naming it | `shape`, `at`, `tile` |
| `road` | Bresenham line between two points | `from`, `to`, `tile`, `width?` |
| `path` | Interpolated curve with optional jitter (rivers, trails) | `points`, `tile`, `width?`, `jitter?`, `seed?` |
| `arc` | Quadratic Bézier arc | `from`, `to`, `bulge`, `tile`, `width?` |
| `scatter` | Randomly place a tile N times within bounds | `bounds`, `tile`, `count`, `seed?`, `over?` |
| `noise_patch` | Overwrite tiles where a noise function exceeds a threshold | `bounds`, `tile`, `threshold`, `scale?`, `seed?`, `over?` |
| `sketch` | ASCII grid mapped to tiles, scaled up | `data`, `legend`, `at`, `scale?` |

### Shape Types (`ShapeSpec`)

Available for `region` and `shape` ops:

```
rect    { w, h }
circle  { r }
ellipse { rx, ry }
polygon { points: [x, y][] }   // absolute coordinates only; at: is ignored
```

### Positioning System (`PositionSpec`)

How ops describe where to place things:

```
{ center: true }                         // center of zone
{ x: N, y: N }                          // absolute tile coordinate
{ relative_to: regionId, side: dir, gap?: N }  // adjacency to a named region
```

### Bounds Reference (`BoundsRef`)

How ops describe a rectangular search area:

```
{ region: id }          // AABB of a named region
{ rect: {x,y,w,h} }    // explicit rectangle
{ all: true }           // entire zone
```

### Point Reference (`PointRef`)

How `path` and `road` describe endpoints:

```
{ x, y }                        // absolute
{ region: id, anchor?: side }   // named region center or edge
{ edge: dir, t?: 0–1 }          // zone edge at fractional position
```

### Spawns and Portals

```typescript
interface ZoneSpawn {
  entity: string          // mob template ID
  region?: string         // place within named region (random within AABB)
  at?: { x: number; y: number }  // exact tile placement
  count?: number
  respawn_seconds?: number
  spawn_id?: string       // used for quest-giver targeting
}

interface ZonePortal {
  at: { x: number; y: number }
  to: { zone: string; x: number; y: number }
  tile?: string | null    // null suppresses portal tile painting
}
```

Connections (`north/south/east/west`) are edge-to-edge transitions; portals are point-to-point teleports. Both are one-way in the data model — bidirectionality is convention only.

### Opportunity Schema

```typescript
interface Opportunity {
  id: string              // opp_NNN, monotonically assigned
  type: OpportunityType   // new_zone | add_entity | add_quest | refactor_zone | add_tile | ...
  priority: number
  status: 'pending' | 'approved' | 'implemented' | 'superseded'
  rationale: string
  // ...type-specific fields passed through to Implementer
}
```

The Gardener proposes; the Implementer executes. There is no feedback channel from Implementer back to Gardener within a single cycle — the Gardener only learns what was done via the append-only history log on its next invocation.

---

## 3. Generation Engine

The server's `generateZoneGrid(zoneDef)` function interprets the `ops[]` array and produces a 2D tile grid. It is fully deterministic given the same `ZoneDef`. This is the runtime that makes the LLM's descriptions concrete.

### Execution Model

```
1. Initialize grid[height][width] with default_tile
2. For each op in ops[] (in order):
   - resolve position/bounds references to absolute coordinates
   - call the appropriate paint primitive
   - write tile names into grid cells (later ops overwrite earlier)
3. Paint portal tiles last (always on top)
4. Return { grid[][], bounds{regionId → AABB}, width, height }
```

The returned `bounds` map is used at runtime for mob spawn placement and leash logic. It contains only axis-aligned bounding boxes (AABBs), regardless of the original shape.

### Paint Primitives

| Primitive | Algorithm |
|-----------|-----------|
| `paintRect` | Direct array fill |
| `paintCircle` / `paintEllipse` | Per-pixel inclusion test |
| `paintPolygon` | Scanline fill |
| `paintLine` | Bresenham |
| `paintPath` | Linear interpolation between points + 1D value noise jitter |
| `paintArc` | Quadratic Bézier, step count from chord length + bulge |
| `paintScatter` | Seeded mulberry32 random within AABB |
| `paintWalls` | Border fill on rect regions only; places optional door tile on one side |
| `noise_patch` | Per-tile value noise threshold test |

### Blocking Tile System

Movement collision is determined by a hardcoded constant:

```typescript
const BLOCKING_TILES = new Set(['wall', 'water', 'void', 'tree'])
```

This set is evaluated at every movement tick. A tile name is either in this set or it is not. There is no per-tileset configuration and no way to declare a new blocking tile through the pipeline's `tileset_update` mechanism — that path only adds color metadata for rendering.

### Tileset Structure

Tilesets are JSON files that map tile/sprite names to hex colors for the renderer. They do not carry any gameplay semantics. The mapping from tile name to behavior (blocking, passable, etc.) exists only in `BLOCKING_TILES` and in client-side sprite rendering.

---

## 4. LLM Mechanics

### Context Construction

Each LLM call receives the entire world state as a single text block:
- Lore bible
- Every zone YAML (verbatim)
- Every mob template YAML (verbatim)
- Every quest YAML (verbatim)
- Every tileset JSON (verbatim)
- Current opportunities list
- Full implementation history

There is no chunking, summarization, or selective loading. Context size grows linearly with world content. No mechanism exists to prune stale or irrelevant content from the context.

### Validation Loop

```
call LLM
  → extract YAML from fenced block
  → validate against Zod schema
  → if invalid: send error + prior output → retry once
  → if still invalid: throw (pipeline halts)
```

One repair attempt is allowed per call. There is no retry-with-backoff, no partial-result recovery, and no circuit breaker for repeated failures.

### Implementer Constraints (Enforced at Runtime)

Paths written by the Implementer are validated before hitting disk:
- No absolute paths or `..` traversal
- Must be within `world/zones/`, `world/entities/`, or `world/quests/`
- Must end in `.yaml`
- Tileset changes must use the `tileset_update` field, not `files[]`

Anything outside these paths — including code changes needed to make a new blocking tile work — is outside the pipeline's write boundary.

### Opportunity Selection

The Implementer always picks the highest-priority `status: pending` opportunity unless overridden with `--opportunity <id>`. Priority is a number assigned by the Gardener; no automatic decay or age-weighting exists. The Gardener has no access to any intermediate state produced by the Implementer in the same cycle — it only sees the committed history from prior cycles.

---

## 5. Issues Limiting Output Quality

Issues are grouped by the layer they affect.

### Generation Vocabulary Gaps

**G1: New blocking tiles require a code change**
The `BLOCKING_TILES` constant is outside the pipeline's write boundary. The LLM can propose a new tile (e.g., a decorative barrier type), add it to the tileset for rendering, and place it in zone layouts — but it will not block movement unless a developer adds its name to the constant. This is not documented in the LLM system prompts. The Gardener and Implementer have no way to know whether a tile they introduce will behave as blocking.

**G2: `paintWalls` is exclusive to rectangular regions**
The `walls` spec on a `region` op is silently discarded for `circle`, `ellipse`, and `polygon` shapes. The engine only calls `paintWalls` when `shape.kind === 'rect'`. The Implementer system prompt does not document this restriction. A circular clearing described with a wall border in the YAML will generate without one, with no error or warning.

**G3: Polygon positioning is absolute-only**
Polygon point coordinates are always in absolute zone-space. The `at` PositionSpec field that all other shapes use for relative/center positioning is silently ignored for polygons. An author writing a polygon with `at: { relative_to: ... }` receives no error — the polygon is simply placed at origin-relative absolute coordinates. This makes polygons significantly harder to position predictably within a zone layout.

**G4: No multi-zone spatial coherence**
Zones are a named graph. There is no world-coordinate system. Zone transitions clamp the player's entering coordinate to the destination zone's bounds, but there is no validation that connected zones have matching edge lengths. Zones can be declared as connected regardless of size mismatch. The LLM has no mechanism to reason about how a zone's edge aligns with its neighbor — it can only ensure connections are declared in both directions.

**G5: Tileset is purely a color lookup — no semantic metadata**
The tileset JSON describes how tiles look, not what they mean. There is no field for declaring a tile's passability, interaction type, or surface properties. All tile semantics live in code (`BLOCKING_TILES`) or in LLM-prompt convention. This means the pipeline cannot carry semantic intent through a tileset addition alone.

---

### Generation Engine Limitations

**E1: Region bounds are AABB-only**
The `bounds` map returned by `generateZoneGrid` stores only the axis-aligned bounding box for every region, regardless of its shape. Mob spawn placement reads this AABB and picks random positions within it. For circular or elliptical regions surrounded by walls, the AABB corners fall outside the painted floor. The spawn placement logic rejects blocked tiles but has a fixed attempt limit — circular regions with dense surrounding walls will silently produce fewer mobs than declared.

**E2: `paintPath` jitter uses 1D noise**
The `path` op applies a value noise function for organic meander, but the Y argument to `valueNoise` is hardcoded to `0`. This samples only a single row of the 2D noise field. All paths share the same underlying meander shape, differentiated only by seed and step count. Adding a second dimension of variation would produce significantly more varied river and trail layouts.

**E3: `paintArc` step count approximation**
The arc length used to determine paint step count is approximated as `chord_length + |bulge| * 2`. For high-curvature arcs this underestimates actual arc length, producing gaps between painted tiles. High-bulge arcs are a natural choice for curved walls or embankments.

**E4: Mob spawn placement is non-deterministic**
`_findFreeTileInRegion` uses `Math.random()`, not the seeded RNG used by the mapgen engine. Mob positions change on every server restart. The PNG zone renderer uses a seeded placement algorithm for its mob visualization — renders and actual runtime state diverge. This makes the render feedback loop misleading and prevents reproducible zone testing.

---

### Pipeline Mechanics Issues

**P1: No inter-agent feedback within a cycle**
The Gardener produces opportunities based on the world state at the time it runs. The Implementer executes them. If the Implementer's work makes a pending opportunity redundant or contradictory (e.g., it incidentally writes a file that a later pending opportunity was also going to write), the Gardener has no way to know until its next invocation. Intermediate state drift is not surfaced during a cycle — it only becomes visible as no-op or conflicting runs.

**P2: Context is the full world, always**
Both agents receive the full world bundle on every invocation. There is no selective context based on which zone or entity type is being worked on. As the world grows, this increases latency, cost, and the chance of the LLM attending to irrelevant content. There is no mechanism to give an agent a narrower view.

**P3: One-shot repair on schema validation failure**
If the LLM produces output that fails Zod schema validation, one repair attempt is made. If that also fails, the pipeline halts. There is no fallback to a simpler output, no degraded mode, and no backoff. As context size grows, the probability of parse errors increases.

**P4: Opportunity scoring has no decay or diversity pressure**
The Gardener assigns priority scores. These are not age-weighted or penalized for repeated type. A Gardener run could produce many opportunities of the same type (e.g., several `add_entity` entries) and the Implementer will drain them in priority order without any diversity balancing.

**P5: No isolated zone testing path**
There is no way to validate a zone YAML without starting the full server. A zone with an invalid op fails silently at grid generation time (the op is skipped or causes an exception with a generic message). The render pipeline (`renderZoneToFile`) provides a visual check but no structural validation. The zone editor exists but has no schema validation on op input.

---

## 6. Prioritized Actions

These are ordered by impact on generation output quality, which is the focus of this document.

### High — blocks or degrades generation expressiveness

| # | Issue | Fix |
|---|-------|-----|
| H1 | New blocking tiles require a code change | Add a `blocking: true` field to tileset tile entries; read it in the world loader to extend the blocking set at load time |
| H2 | `paintWalls` silently discarded for non-rect regions | Either enforce in mapgen (warn + skip cleanly) or document the restriction explicitly in the Implementer system prompt |
| H3 | Polygon `at` silently ignored | Document restriction in Implementer prompt; add a warning in mapgen when `at` is non-trivial for a polygon |
| H4 | Region bounds are AABB-only for non-rect shapes | Store the original `ShapeSpec` alongside the AABB; use it in spawn placement to reject out-of-shape positions |
| H5 | Non-deterministic mob placement | Replace `Math.random()` in `_findFreeTileInRegion` with seeded RNG derived from zone ID + spawn index |

### Medium — reduces output variety or reliability

| # | Issue | Fix |
|---|-------|-----|
| M1 | `paintPath` jitter is 1D | Pass step index as the Y argument to `valueNoise` to sample across both dimensions |
| M2 | Context is full world on every call | Explore selective context: focused zone neighborhood for Implementer, summary + relevant excerpts for Gardener |
| M3 | No inter-agent feedback within a cycle | Surface Implementer side-effects (files written) back to the pending queue before the next Implementer pick; at minimum, re-check file existence before executing a pending opportunity |
| M4 | No isolated zone testing | Build a standalone `validate-zone <path>` command that runs `generateZoneGrid`, reports inaccessible regions, missing referenced entities, and declared-but-unresolvable PointRefs |
| M5 | `paintArc` gap at high bulge | Use subdivided Bézier arc length or increase step count multiplicatively with bulge |

### Low — polish and robustness

| # | Issue | Fix |
|---|-------|-----|
| L1 | Silent spawn failure with no logging | Add `console.warn` in `_findFreeTileInRegion` and `_findFreeNear` on null/fallback return |
| L2 | One-shot LLM repair | Add configurable retry count with exponential backoff in `validate.ts` |
| L3 | No zone YAML schema validation at load time | Add Zod validation in `loadWorld` with file path + field in error messages |
| L4 | `ZoneDef.tileset` missing from TypeScript type | Add `tileset?: string` to `ZoneDef`; remove unsafe casts across the codebase |
| L5 | Opportunity scoring has no diversity pressure | Consider type-based weighting or cooldown in Gardener scoring guidance |
| L6 | No world edge-length validation on connections | Warn at load time when connected zones have mismatched edge dimensions |
