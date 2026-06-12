# Silicon Soup — Zone Generation Redesign
**Design Document v1.0**

---

## Problem Statement

The current Implementer pipeline produces zones that feel spatially inert: rectangular bounding boxes filled with procedurally assigned tiles, without coherent internal structure or meaningful relationships to neighboring zones. The content *within* zones (lore, dialogue, quest hooks) is strong, but the zones themselves feel like labeled containers rather than places. This document describes a generation philosophy and a set of concrete techniques to address that.

---

## Core Philosophy: Places Before Tiles

The central shift is from **tile-first** to **place-first** generation. A zone should begin as an idea — a structural intent, a narrative function, a set of spatial relationships — and resolve into tiles only at the final step. The YAML definitions should describe *what a place is and how it came to be*, not a grid of what tiles go where.

This philosophy has two practical consequences:

1. **The Gardener's job expands slightly.** In addition to identifying content opportunities, the Gardener should reason about spatial relationships between existing zones — proximity, adjacency, elevation, sight lines — and flag when the map's geography doesn't serve its narrative.

2. **The Implementer gets a richer intermediate representation.** Instead of going directly from opportunity → tiles, the Implementer should produce a zone definition that passes through a structural layer (shape, landmarks, internal flow) before being resolved to a tile grid.

---

## Technique 1: Voronoi Region Decomposition

### Intent

Rather than assigning zones to rectangular bounding boxes, the map is divided into regions using a Voronoi decomposition seeded by landmark points. Each landmark represents the "heart" of a zone — the ruin, the wellspring, the collapsed gate — and the zone's territory is defined as everything closer to that landmark than to any other.

### What This Achieves

- Zone boundaries become naturally irregular without requiring hand-authoring
- Adjacent zones share borders at geographically meaningful locations (ridgelines, river edges, open ground)
- Adding a new zone is just adding a new landmark point; existing zones reshape themselves automatically
- The landmark itself becomes a narratively significant location, not just a spawn origin

### YAML Representation

Zone definitions should store a landmark coordinate and optional boundary influence weights (to bias the region toward certain directions — useful for zones that should "hug" a cliff face or a road). The tile grid is computed, not stored.

---

## Technique 2: Structural Archetypes

### Intent

Each zone has a **structural archetype** that describes its internal spatial grammar. An archetype is not a tile layout — it's a set of rules about how the zone organizes itself: where flow enters and exits, where the focal point sits, what kind of internal variety exists.

### Archetype Library (Initial Set)

**Approach** — A zone designed to be traversed. Has a clear entry and exit, a progression of openings and choke points, and a payoff at the far end. Typical for corridors, passes, ravines.

**Crucible** — A zone designed to be fought in. Has a defensible perimeter, multiple internal cover positions, sightlines that reward positioning. Typical for arenas, courtyards, siege grounds.

**Sanctuary** — A zone that invites exploration over a contained area. Has a dense interior with branching paths, pockets of interest scattered throughout, no dominant axis of movement. Typical for forests, ruins, caverns.

**Threshold** — A transitional zone between two meaningfully different areas. Has one "face" that echoes the zone it connects from, and one that anticipates the zone it connects to. Thin, but not featureless. Typical for gates, fords, border posts.

**Hearth** — A zone designed for habitation or rest. Has a center of gravity (fire, altar, well), secondary activity areas arranged around it, and a clear perimeter. Typical for camps, shrines, settlements.

### How the Implementer Uses This

When an opportunity resolves to a new zone, the Implementer selects an archetype that fits the zone's narrative purpose. The archetype drives tile placement decisions: entry points, focal point placement, internal path density, cover distribution. The zone's lore content then populates the structurally meaningful positions (the altar, the choke point, the far end payoff) rather than being scattered uniformly.

---

## Technique 3: Constraint-Based Placement

### Intent

Zones should be placed relative to each other using declared spatial constraints, not absolute coordinates. The Gardener reasons about what relationships *should* exist; the Implementer satisfies those constraints.

### Constraint Types

**Adjacency** — "The abandoned mine should share a border with the collapsed city." Ensures narrative connections are also geographic ones.

**Elevation** — "The watchtower zone should be uphill from the road zone." Elevation constraints inform both visual framing and gameplay (ranged advantage, drainage, visibility).

**Visibility** — "The cursed altar should be visible from the crossroads but not approachable directly." Line-of-sight constraints can create zones that feel foreboding or significant before the player enters them.

**Distance** — "The two rival encampments should be separated by at least one neutral zone." Prevents thematic whiplash from abrupt adjacency.

### How This Integrates with the Pipeline

The Gardener, when generating opportunities, may include a `spatial_relationships` field alongside the usual content fields. This is not required for every opportunity — lore updates, dialogue additions, and quest expansions don't need it — but any opportunity that introduces a new zone should declare its intended relationships with existing zones.

The Implementer uses these constraints to determine landmark placement before running the Voronoi step.

---

## Technique 4: Noise-Based Feature Placement

### Intent

Within a zone, the distribution of features (trees, rubble, water, open ground) should feel natural rather than uniform. Simplex noise fields, sampled at each tile position, determine feature density. Different feature types use different noise frequencies and thresholds, producing layered organic variation.

### What This Achieves

- Dense clusters of trees rather than even tree coverage
- Rubble that pools in corners and thins toward open areas
- Water features that carve irregular paths rather than filling rectangular pools

### YAML Representation

A zone definition stores noise seeds and per-feature-type parameters (frequency, threshold, blend mode). The actual tile values are computed at load time or build time, not stored in YAML. This keeps the source files small and human-readable while producing varied output.

---

## Technique 5: Landmark-Anchored Narrative Placement

### Intent

Each zone has a defined **focal point** — the structurally most significant tile or small cluster of tiles. This is derived from the archetype (the far-end payoff for an Approach, the center of gravity for a Hearth, etc.). All narrative content with spatial significance is placed relative to the focal point, not at arbitrary coordinates.

### What This Achieves

- Quest objectives, interactable objects, and significant NPCs cluster at locations the player is naturally drawn toward
- Zone feel is reinforced: a Crucible's focal point might be a raised platform; a Sanctuary's might be a hidden interior clearing
- New content added to an existing zone knows where to anchor itself

---

## Integration with the Existing Pipeline

### Gardener Changes

- Spatial relationship reasoning becomes a first-class part of opportunity scoring. Opportunities that would improve geographic coherence (connecting two narratively linked zones that are currently far apart, adding a Threshold zone between two abruptly adjacent areas) are surfaced explicitly.
- Zone-type opportunities include a suggested archetype and constraint declarations.

### Implementer Changes

- Zone creation follows a defined resolution order: (1) declare constraints, (2) place landmark via constraint satisfaction, (3) assign archetype, (4) compute Voronoi region, (5) apply noise fields for feature distribution, (6) anchor narrative content to focal point.
- Non-zone opportunities (lore, dialogue, quests) are unaffected.

### YAML Schema Additions

Zone definition files gain the following new fields:

- `landmark`: coordinate of the zone's heart point (used as Voronoi seed)
- `archetype`: one of the structural archetype names
- `focal_point`: offset from landmark to the narrative anchor (can be computed from archetype default)
- `spatial_constraints`: list of relationship declarations (type, target zone, parameters)
- `noise_seeds`: per-feature seeds and parameters for tile distribution
- `boundary_weights`: optional directional biases on the Voronoi region

Existing fields (name, lore, encounters, connections, etc.) are unchanged.

---

## What This Does Not Change

- Quest logic, dialogue trees, and faction relationships are entirely unaffected
- The Gardener/Implementer split and the opportunity scoring system remain as-is
- Existing zone YAML files remain valid; the new fields are additive and optional, allowing incremental adoption
- The tone, density, and quality of narrative content generation is unchanged

---

## Suggested Implementation Order

1. Add archetype selection to the Implementer prompt and zone schema — lowest lift, immediate improvement to internal zone structure
2. Add landmark + Voronoi decomposition — replaces bounding box logic, produces irregular borders
3. Add constraint declarations to the Gardener's opportunity output format
4. Add noise-based feature placement as a generation pass after Voronoi
5. Retrofit existing zones with landmark and archetype fields as a Gardener pass

Each step is independently valuable and can be shipped without the others.

---

## Implementation Status (v1.0 — shipped)

All five techniques are implemented and wired through the engine, render
feedback loop, schemas, lints, and both pipeline agents. The new YAML fields
are additive and optional, so every pre-existing zone remained valid; the ten
existing zones were then retrofitted with `archetype` + `landmark` +
`focal_point`.

| Technique | Realization | Key files |
|-----------|-------------|-----------|
| 1. Voronoi decomposition | `voronoi` GenOp: partitions a zone (or a bounds region) among weighted landmark seeds, paints each cell's floor, draws optional seams, and registers each cell as a named region. Delivers irregular borders that reshape when a seed is added. | `server/game/mapgen/index.ts` |
| 2. Structural archetypes | `archetype` field + library (5 archetypes with guidance + focal defaults). Drives the Implementer plan/execute prompts and the focal-point default. | `server/game/mapgen/archetypes.ts`, `shared/types.ts`, `pipeline/lib/prompts.ts` |
| 3. Constraint-based placement | `spatial_constraints` on zones + `spatial_relationships` on Gardener opportunities (adjacency / elevation / visibility / distance). Adjacency is lint-enforced to imply a real connection. | `shared/types.ts`, `pipeline/lib/schemas.ts`, `pipeline/lib/planLint.ts`, `pipeline/lib/prompts.ts` |
| 4. Noise-based features | Already present as the `noise_patch` op; the `noise_seeds` field documents per-feature intent. Prompts now steer feature scatter toward noise rather than uniform fills. | `server/game/mapgen/index.ts`, `pipeline/lib/prompts.ts` |
| 5. Landmark-anchored narrative | `landmark` + `focal_point` ({ region } \| { x, y } \| { landmark_offset }) resolved by `resolveFocalPoint`; surfaced in the renderer (purple diamond = landmark, gold ring = focal) and usable via `spawn_point: { focal: true }`. | `server/game/mapgen/index.ts`, `server/game/world.ts`, `pipeline/lib/renderZone.ts` |

### One honest limitation

Technique 1 is described as a **map-level** decomposition: the whole map split
into per-zone territories by inter-zone landmark seeds. The engine has **no
world-coordinate system** — zones are independent grids joined by a connection
graph (see the pipeline audit, §5 G4). A faithful inter-zone Voronoi would
require rebuilding that coordinate model, which is out of scope here.

The technique is therefore realized at the **intra-zone** level, where it
delivers the same value the doc asks for (irregular borders, seed-driven
territories that reshape on edit, landmark as the cell heart) without the
rewrite. The `landmark` and `boundary_weights` zone fields are stored as
forward-compatible metadata for a future world-coordinate model; today
`landmark` actively serves as the focal anchor and render overlay, and
per-cell `weight` in the `voronoi` op provides the directional biasing that
`boundary_weights` describes.