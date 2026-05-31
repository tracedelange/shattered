# The Gardener & Implementer — Design Document

## Overview

Two independent LLM pipelines responsible for world evolution. Neither is a
free-running agent. Both are invoked on a schedule or manually, produce
inspectable artifacts, and are fully auditable.

```
World State
    │
    ▼
┌─────────────┐     opportunities.yaml     ┌─────────────────┐     new/modified YAML
│  Gardener   │ ─────────────────────────▶ │  Implementer    │ ──────────────────────▶ world/
│  (analyze)  │                            │  (execute)      │
└─────────────┘                            └─────────────────┘
```

The Gardener never touches world files. The Implementer never decides what to
build. The handoff artifact between them is human-readable and human-editable.

---

## The Gardener

### Role

Reads the current world and produces a prioritized list of opportunities. Acts
as analyst, critic, and gardener — it enriches and prunes as readily as it
expands. It is the system's coherence conscience.

### Inputs

```
world/
  zones/          — all zone YAML files (the zone graph)
  entities/       — mob and item definitions (what exists to populate zones)
  quests/         — quest definitions (narrative threads)
  lore/
    bible.yaml    — canonical world facts, tone, factions, geography
pipeline/
  opportunities.yaml   — previous opportunity list (for continuity)
  history.yaml         — log of implemented changes (what was built and when)
```

The lore bible is the Gardener's primary coherence constraint. Every proposal
is evaluated against it before scoring.

### Opportunity Types

The Gardener produces a mix of these — not just expansion:

| Type | Description |
|---|---|
| `new_zone` | Net new zone connected to an existing one |
| `deepen_zone` | Add regions, ops, or spawns to a sparse zone |
| `add_connection` | Link two zones that should logically connect |
| `faction_presence` | Extend a faction into an adjacent zone coherently |
| `refactor_zone` | Restructure a zone's ops for coherence or quality |
| `add_entity` | New mob or item definition motivated by world needs |
| `add_quest` | Quest that fits an existing narrative gap |

### Output — `world/pipeline/opportunities.yaml`

```yaml
generated_at: 2024-01-15T03:00:00Z
world_summary: "7 zones, 3 factions, sparse northeast quadrant. Dark forest
  underutilized relative to player traffic. No water-adjacent content despite
  river established in lore."

opportunities:
  - id: opp_007
    type: new_zone
    priority: 0.91
    status: pending
    connection: { zone: river_crossing, direction: east }
    suggested_id: abandoned_mill
    suggested_name: "The Abandoned Mill"
    theme: "Ruined industrial waterfront, pre-collapse era"
    rationale: "River established in lore bible but no zone reflects it.
      High player traffic at river_crossing with no eastward content.
      Warden's Guild presence in river_crossing makes a contested mill
      narratively motivated."
    lore_hooks:
      - "Mill predates Warden's Guild by at least a generation"
      - "Something drove out the last miller — unknown"
    complexity: medium
    suggested_entities: [river_rat, rusted_gear_item]

  - id: opp_008
    type: deepen_zone
    priority: 0.74
    status: pending
    target_zone: dark_forest
    rationale: "Only two region types (clearing, lair). High spawn count but
      low environmental variety. No sub-narrative despite being a major zone."
    suggested_additions:
      - "Add a third region: ancient_shrine (circle, north of hollow)"
      - "Road from hollow to ancient_shrine"
      - "Noise patch: mushroom_patch overlay on hollow floor"
    lore_hooks:
      - "Shrine predates goblin occupation"

  - id: opp_009
    type: refactor_zone
    priority: 0.41
    status: pending
    target_zone: starting_village
    rationale: "Regions feel disconnected — no road between market and inn.
      Low coherence score relative to zone complexity."
    suggested_changes:
      - "Add road: market → town_square → inn"
      - "Tighten region spacing — current gaps are navigability dead zones"

  - id: opp_010
    type: add_connection
    priority: 0.38
    status: pending
    from_zone: dark_forest
    to_zone: ruins
    rationale: "Ruins are currently only accessible from starting_village.
      A back-path through dark_forest would create a meaningful risk/reward
      loop for higher-level players and fits the geography."
```

### Coherence Rules (Gardener's standing instructions)

These are baked into the Gardener's system prompt, not enforced by code:

- **Lore bible is immutable during analysis.** Propose nothing that
  contradicts established facts. Flag contradictions as separate
  `refactor_lore` opportunities instead.
- **Depth before breadth.** Score `new_zone` lower if the connecting zone
  has fewer than 3 regions or no lore hooks. A shallow zone should be
  deepened before it spawns children.
- **Max branching factor: 3.** A zone with 3+ connections cannot receive a
  `new_zone` opportunity without a corresponding `add_connection` refactor
  to justify the topology.
- **Faction coherence.** Every zone proposal must identify which faction(s)
  are plausibly present and why. Factionless zones are flagged as incomplete.
- **Name the absence.** If a lore bible element (faction, geography, era) has
  no zone representation, the Gardener should surface it as an opportunity.

### Scoring Guidance

Priority is a float 0–1. Rough weighting:

- **Player motivation** (does content exist to bring players here?) — high weight
- **Lore coherence** (does it fit the bible?) — high weight
- **Narrative gap** (does it close an open thread?) — medium weight
- **Zone graph balance** (does it avoid sprawl?) — medium weight
- **Implementation complexity** — inverse weight (simpler scores higher, all else equal)

---

## The Implementer

### Role

Picks the top-scored `pending` opportunity from `opportunities.yaml`, builds
it, marks it done, and updates the lore bible. One thing per run. Does not
decide what to build.

### Inputs

```
world/pipeline/opportunities.yaml   — picks highest priority where status: pending
world/lore/bible.yaml               — reads for context, appends after build
world/zones/                        — reads connected zones for spatial/tonal context
world/entities/                     — reads available mobs/items to reference in spawns
```

### What It Produces

Depending on opportunity type:

- **`new_zone`** — writes a new file to `world/zones/<id>.yaml`
- **`deepen_zone` / `refactor_zone`** — modifies an existing zone YAML
- **`add_connection`** — modifies two existing zone YAMLs (adds portal/connection)
- **`add_entity`** — writes to `world/entities/mobs/` or `world/entities/items/`
- **`add_quest`** — writes to `world/quests/`

### Zone Construction Guidelines (for Implementer system prompt)

When building a zone, the ops list should follow this layered order:

1. **Base fill** — establish the default ground tile
2. **Noise patches** — organic overlays (forest, marsh, rubble)
3. **Regions** — named areas in logical order (largest/central first, then relative)
4. **Roads** — connections between regions
5. **Spawns** — after geometry is established
6. **Portals/connections** — last

Regions should be placed relatively (`relative_to`) wherever possible rather
than at absolute coordinates — this keeps zones refactorable without
coordinate surgery.

Every new zone must include:
- At least one named region that serves as `spawn_point`
- At least one `connection` back to an existing zone
- At least one `lore_hook` comment in the YAML
- Spawns motivated by the zone theme (no generic filler)

### Post-Build Steps

After writing files, the Implementer:

1. Sets `status: implemented` and `implemented_at` on the opportunity
2. Appends a summary to `world/lore/bible.yaml`:

```yaml
# Appended by Implementer after opp_007
zones:
  - id: abandoned_mill
    summary: "Ruined waterfront mill east of river_crossing. Pre-Warden era.
      Contested by river rats. Mystery of the last miller unresolved."
    factions: [wardens_guild_adjacent]
    connections: [river_crossing]
    implemented: 2024-01-15
```

3. Appends to `world/pipeline/history.yaml`:

```yaml
- opportunity_id: opp_007
  implemented_at: 2024-01-15T04:12:00Z
  files_written: [world/zones/abandoned_mill.yaml]
  files_modified: [world/zones/river_crossing.yaml, world/lore/bible.yaml]
  notes: "Added river_rat mob def. Extended river_crossing east portal."
```

---

## Pipeline Files

```
world/
  lore/
    bible.yaml              — canonical world facts; append-only by convention
  pipeline/
    opportunities.yaml      — Gardener output; Implementer input
    history.yaml            — append-only log of all implemented changes
```

These files are the shared state between the two pipelines. Both are
human-readable and human-editable — you can manually add opportunities,
adjust priorities, or block an implementation by setting `status: blocked`.

---

## Opportunity Status Lifecycle

```
pending → implemented
pending → blocked      (human override)
pending → superseded   (Gardener marks stale on next run)
```

The Gardener does not delete old opportunities — it marks superseded ones and
appends new ones. The file is a running record, not a fresh list each run.

---

## Implementation Notes

Both pipelines are TypeScript, consistent with the rest of the server codebase.
Pipeline scripts live under `pipeline/` at the project root and share types
from `shared/types.ts` (GenOp, ZoneDef, etc.) directly.

---

## Invocation

Neither pipeline runs autonomously. Both are invoked explicitly:

```bash
# Analyze world, produce/update opportunities
npx tsx pipeline/gardener.ts

# Implement top opportunity
npx tsx pipeline/implementer.ts

# Implement a specific opportunity by id
npx tsx pipeline/implementer.ts --opportunity opp_008

# Dry run — show what implementer would do without writing files
npx tsx pipeline/implementer.ts --dry-run
```

The hot-reloader (`server/world/watcher.ts`) picks up any file changes the
Implementer writes. No server restart needed.

---

## Human Approval Gate (Optional)

If you want to review before the Implementer runs, set opportunities to
`status: approved` manually (or via a lightweight script) and configure the
Implementer to only consume `approved` items. Remove the gate once output
quality is trusted.

```yaml
# Manual approval in opportunities.yaml
- id: opp_007
  status: approved   # changed from pending by hand
```

```bash
# Implementer respects gate
node pipeline/implementer.js --require-approved
```