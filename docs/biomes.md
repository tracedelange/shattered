# Silicon Soup — Biome System Requirements Brief

## Overview

This document defines requirements for a **Biome system** in Silicon Soup's zone generation pipeline. It is intended as a handoff to a coding agent and should inform implementation without prescribing it. Architecture and implementation details are left to the agent's discretion unless explicitly constrained here.

---

## Motivation

The current zone generation pipeline delegates too much spatial and parametric decision-making to the LLM agent. This produces high token costs, spatial incoherence, and zones that are not visually recognizable or consistent. The Biome system is the foundational rework that addresses this by encoding procedural knowledge into deterministic, composable data structures — leaving the LLM responsible only for high-level semantic intent.

---

## System Context

The Biome system is one layer in a larger generation architecture. Understanding the full picture is important for implementation decisions.

### Generation Architecture (Target State)

```
1. WORLD GEN (fully procedural, no LLM)
   └── Biome + Modifiers → Operator Pipeline → Zone Geometry + Metadata

2. SLOT RESOLUTION (deterministic)
   └── Geometry → Semantic anchor/slot tagging (emergent from geometry post-gen)
   └── Constraint Manifest → Solver → Feature Placement

3. LLM PASS (lightweight, narrative only)
   └── High-level intent → Named constraints appended to manifest
   └── Flavor text, quest seeds, NPC motivation — never spatial decisions
```

The LLM's interface to the world is a **constraint manifest** — a list of named, prioritized desires (e.g. `{ feature: "fountain", anchor: "zone_center", priority: "required" }`). A solver resolves these against the geometry. The LLM never reasons about coordinates, tile positions, or operator parameters.

### Slot/Anchor System (Future, design for)

Zones will eventually expose **semantic slots** — tagged areas produced by the geometry pass (e.g. "this room is a valid boss chamber," "this corridor is a valid patrol route"). These slots are emergent from geometry, not declared in advance. The Biome system should not hard-code slot positions, but the implementation should be designed with awareness that slot tagging will be a downstream consumer of geometry output.

### Workbench (Parallel build)

A standalone **biome tuning workbench** will be built alongside this system. It will:
- Accept a biome name + modifiers and generate N variants across different seeds
- Render variants in a grid for rapid visual comparison
- Allow the developer to tag liked seeds (save seed + parameters)
- Build a corpus of "good" seeds per biome for regression and parameter narrowing

The workbench is a developer tool, not in-game. It will talk directly to the zone gen pipeline. The Biome interface should be cleanly callable in isolation (i.e. `generateZone({ biome, modifiers, seed })`) to support this.

---

## Biome Requirements

### Identity

- A biome is identified by a **single name** (e.g. `"castle_exterior"`, `"sewer"`, `"village"`)
- At generation time, a biome accepts **one or more modifiers** (e.g. `["dilapidated", "flooded"]`)
- The name + modifier(s) combination fully determines the generation envelope

### Classification

- A biome declares one or more **tags** describing its spatial character
- Examples: `indoor`, `outdoor`, `underground`, `aquatic`, `vertical`
- Tags are used downstream by the slot system and LLM constraint resolver

### Atmospheric Properties

- A biome defines continuous **climate properties** (e.g. moisture, temperature, structural density) on a normalized scale
- These properties influence operator behavior and feature/spawn weights
- They are the primary target of modifier diffs (e.g. "flooded" significantly raises moisture)

### Visual Identity

- A biome declares a **color scheme** — minimally floor, wall, and accent
- Color scheme should be applicable at the tile/render level
- Modifiers may override or shift color values

### Operator Pipeline

- A biome defines an **ordered set of operators** (e.g. CA, noise, BSP, rooms, flood fill)
- Operator order has **explicit, declared variance** — the pipeline is not always fixed but variance is deterministic given a seed. Shuffle groups or weighted orderings should be declared in the biome definition, not randomized implicitly.
- Operator parameters are defined in the biome, not supplied at call time
- When modifiers conflict on a parameter, resolution is by **weighted average** of the conflicting values

### Default Constraints

- A biome declares a set of **default layout constraints** — named features with anchor preferences and priorities
- These represent "this biome is recognizable as itself" guarantees (e.g. a village always wants a center anchor)
- Constraints use priority levels: `required`, `preferred`, `optional`
- Required constraint failures should surface as generation errors, not silent bad layouts

### Content Weights

- A biome declares **spawn weights** and **feature weights** as named numeric maps
- Modifiers apply **deltas** to these maps (additive for numerics, append for lists)

---

## Modifier Requirements

- A modifier is a **partial diff** against a base biome definition
- Modifiers may override or delta any property: climate values, color scheme, operator params, constraints, spawn/feature weights
- Multiple modifiers **compose** — conflicts resolved by weighted average for numeric values, append for lists, last-wins for discrete overrides (unless a better composition rule emerges during implementation)
- Modifiers should be defined as standalone reusable units, not embedded in biome definitions

---

## Interface Requirements

- `generateZone({ biome, modifiers?, seed? })` — primary entry point, must be callable in isolation for workbench use
- Output includes zone geometry **and** associated metadata (at minimum: entrance point, computed accessibility graph, rough centroid/landmark positions)
- Metadata richness should be treated as a first-class output, not an afterthought — downstream slot tagging and constraint solving depend on it
- The system should be designed so that slot/anchor tagging can be added as a post-gen pass without restructuring the core pipeline

---

## Open Questions (flag for implementation)

- Exact composition semantics when three or more modifiers conflict on the same numeric property
- Whether operator shuffle groups are declared as named groups within the pipeline or as a separate ordering manifest
- Slot tagging strategy — what heuristics derive "zone_center," "near_entrance," etc. from raw geometry

---

## Out of Scope for This Pass

- The constraint solver
- The slot tagging system
- The LLM constraint authoring pass
- The workbench UI (separate build)
- Inter-zone connectivity and zone registry
- Streaming/seamless world rendering