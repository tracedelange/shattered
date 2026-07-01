# Silicon Soup — World Structure Requirements

**Scope:** Core world-structure infrastructure only. This document specifies *how the world exists, generates, persists, and streams*. It deliberately does **not** specify combat, loot tables, abilities, vendor economy, quest content, dungeon internals, or mob-library contents — those are named only as integration points so the structure leaves the right holes for them.

**Audience:** Implementing coding agent. Requirements are written to be built against directly. Rationale is included inline so intent survives.

**Stack assumptions:** Node.js server, Socket.IO transport, SQLite persistence, vanilla-canvas client, shared TypeScript generation module imported by both server and client.

---

## 1. The paradigm shift

The world moves **from** hand-authored, zone-bucketed areas (the old Toril-MUD model: discrete explorable zones each assigned a biome) **to** a continuous, field-sampled procedural **wilderness** with **intermittent enclosed safe zones**.

Two kinds of space exist, and the distinction is foundational:

- **Open wilderness** — one continuous, effectively infinite field. No authored zone boundaries. No per-zone biome assignment. The player should feel it is *open*.
- **Enclosed zones** — settlements and dungeons. Bounded, separate coordinate spaces entered through portals. The player should feel *enclosed* inside them.

This split solves the **biome-limit problem** for free: the open world is a single continuous biome *field* (biome is a reading, §5.3), not a finite set of zone-assigned biomes, so there is no cap on biome variety and no seam management.

---

## 2. World topology

**DECISION: Center-safe, unbounded outward progression.**

- A single central starting village sits at world origin `(0,0)`.
- Danger rises with distance from origin (§5.4). Distance from origin **is** the primary difficulty/progression scalar.
- The world is unbounded in practice (§4.1): no reachable edge.

**Rationale:** Unbounded center-safe is the clean fit for the function-not-artifact model — every direction answers the same way (harder, forever), with no "what lies outside the ring" problem. Boundedness and a "hell core" endgame can be layered on later (clamp danger past a radius, or designate a high-danger central-of-a-region zone) without restructuring; the reverse retrofit is not cheap. Build unbounded; treat hell-in-the-middle as a deferred optional endgame skin, not a foundation.

---

## 3. Spatial model — three nested scales

| Scale | Unit | Resolution | Authority | Storage | Computed by |
|---|---|---|---|---|---|
| **Tile** | 1 sprite | base | — | — | derived |
| **Chunk** | N×N tiles | fine, dense | deterministic | never stored | client **and** server, live |
| **Region cell** | M×M tiles | coarse, sparse | server-authoritative | prebaked atlas | server, once at world creation |

The region grid carries **structure and semantics** (danger, rivers, settlement sites, which combat axes may spawn). The chunk grid carries **dense terrain detail**, derived live and never persisted. This mirrors the project's governing pattern: structural authority lives at the sparse upper layer where it is bounded; the dense lower layer is pure derivation nobody authors or stores.

### 3.1 Requirements
- `R3.1` One region cell SHALL contain an integer number of chunks (`M` is a multiple of `N`).
- `R3.2` Chunk terrain SHALL be fully determined by `(chunkX, chunkY, worldSeed)` plus a bilinear sample of the region atlas. No chunk requires knowledge of any other chunk's live state.
- `R3.3` The region atlas SHALL be generated once, server-side, at world creation, and SHALL be immutable for the life of the world seed (dynamism lives in the delta layer, §7, not in terrain).

---

## 4. Coordinate system

### 4.1 Requirements
- `R4.1` Tile coordinates SHALL be signed integers. Recommended space: signed 32-bit (`±2,147,483,647` tiles per axis). At any sane danger ramp the edge is unreachable; treat the world as practically infinite.
- `R4.2` Danger SHALL plateau (not overflow or wrap) beyond a configured radius so coordinate limits never produce undefined behavior at the practical frontier.
- `R4.3` `chunkX = floor(tileX / N)`, `regionX = floor(tileX / M)` (and similarly Y). All three coordinate spaces SHALL share origin `(0,0)`.
- `R4.4` Chunk size `N` and region cell size `M` SHALL be compile-time constants exposed in shared config (values flagged as open decisions, §12).

---

## 5. World generation

Generation is split by a single test: **can this value be computed pointwise from `(x,y,seed)` and a small local neighborhood, or does it require iterating over a global structure?** Pointwise values are computed **live** and never stored. Globally-iterative values are computed **once** into the prebaked atlas.

### 5.1 Pointwise fields — live, never stored
- `R5.1` Elevation (fine), temperature, and moisture SHALL be computed live per tile via seeded multi-octave noise, layered on the macro values sampled from the atlas.
- `R5.2` These fields SHALL be identical when computed by client and server from the same seed + atlas (§8.4 determinism contract).

### 5.2 Global pass — prebaked into the atlas at world creation
The prebake pipeline runs server-side, once, producing the region atlas as a static cacheable asset:

1. Generate **macro elevation** (low-frequency noise) across the atlas.
2. *(Optional, see §12)* **Erosion** pass for realistic drainage.
3. *(DEFERRED from v1 — see §5.6.)* **Flow accumulation / connected rivers**: trace water downhill across the macro heightmap. This is the canonical globally-iterative feature and the only piece that needs the §8.3 coarse→fine handoff. Cut from v1; re-slots here as a discrete pass when multi-settlement navigation ships.
4. **Water (pointwise) — standing + cosmetic rivers, IN v1**: water MAY be derived **live** and pointwise. Two forms: (a) **standing water** (lakes/seas) from an elevation threshold (below sea level = water); (b) **cosmetic rivers** as winding water ribbons from a *continuous* noise field (e.g. water where a ridged/banded noise value falls in a narrow range). Because the noise field is continuous, ribbons line up across chunk boundaries **automatically** — visual continuity comes free with no handoff. These rivers are NOT hydrologically coherent (they may wander, dead-end, or loop, and do not form drainage networks); that is acceptable and explicitly out of scope. All water is **soft terrain**: a movement-cost / swim tile, bypassable by abilities (e.g. blink), NEVER a collision barrier or navigation gate.
5. **Danger inputs**: store the radial band per cell; local wobble may be stored or derived live (§5.4).
6. **Settlement placement** (§9.1): query the completed atlas for viable sites.
7. **Reserve feature slots**: dungeon entrances, landmarks (post-MVP, but addressable now).
8. **Serialize** the atlas → ship to clients as a static asset; retain the authoritative copy server-side.

- `R5.2a` The atlas SHALL be the single in-game **map** object as well as the engine's structural query surface — these are one artifact (cartography the player reads = structure the engine queries).
- `R5.2b` The atlas is justified **independently of rivers**: it stores placed/structural data that is *not* derivable pointwise — danger bands, the allowed-axis mask (§10), the settlement registry, safe flags, and the map summary. Do not "optimize away" the atlas in v1 on the grounds that no globally-iterative terrain feature remains; its job is semantic structure, not just rivers.

### 5.3 Biome as field reading — presentation, not container
- `R5.3` Biome SHALL be a **classification of temp+moisture (+elevation) at a point** (Whittaker-style), computed continuously — a colormap over the fields, never a stored container.
- `R5.4` Biome transitions SHALL emerge from smooth field variation (ecotones), with no discrete seam handling.

### 5.4 Danger field — the difficulty scalar
- `R5.5` Danger SHALL be `radial_trend(distance_from_origin) + terrain_wobble`, where the wobble is derived from the prebaked terrain (e.g. sheltered/low-lying reads safer; exposed/high reads harder).
- `R5.6` The wobble SHALL produce **local minima** — survivable pockets embedded in dangerous bands — because settlement viability (§9.1) and emergent safe corridors depend on them.
- `R5.7` The amplitude of the wobble *relative to* the radial trend SHALL be a single tunable config value. (Too low → world is radially symmetric and destinationless; too high → safe corridors trivialize distance. Tuned by playtest, not derived.)

> **Integration hook:** danger band is the key that correlates a region's *threat-set* with its *answer-drop-set* (loot that answers a threat drops in the band where that threat appears). Not specified here.

### 5.6 Deferred: rivers & inter-settlement navigation
- `R5.8` **Hydrologically coherent rivers** (consistent downhill flow, source-to-sea drainage networks, the §8.3 coarse→fine handoff) are **deferred from v1**. *Cosmetic rivers* (§5.2 step 4) are IN v1 — only coherent *drainage* is deferred. Roads and any dedicated wilderness wayfinding affordance are likewise deferred; the single-village MVP has no settlement-to-settlement travel for them to serve. These return together when multi-settlement ships.
- `R5.9` When navigation does return, the **default** discovery path SHALL be rumor-pin + dead-reckoning (a known location, no auto-arrow; terrain decides the route). A directional aid toward *unknown* settlements is permitted ONLY as an **earned/consumable** item, NEVER as an always-on HUD element (an always-on arrow to undiscovered content collapses the exploration loop — see §9.3, retreat-only compass).

---

## 6. Zone model — open vs enclosed

### 6.1 Open wilderness
- `R6.1` The wilderness SHALL be the continuous field-sampled space of §5. It has no enclosing boundary and no scene transitions within itself.

### 6.2 Enclosed zones (settlements, dungeons)
- `R6.2` An enclosed zone SHALL be a **separate coordinate space** with its own tile grid, not part of the continuous wilderness field.
- `R6.3` Every enclosed zone SHALL have a **world-position**: a footprint on the region atlas (used for the compass, recall, placement, and rumor location).
- `R6.4` Settlements: spawn-suppressed, service-bearing (trainers, shops, inns, vendors). May be template-authored with light proc variation. **Single central village for MVP.**
- `R6.5` Dungeons (*post-MVP, but the model SHALL accommodate them now*): proc-gen within bounds, own internal danger, entrance placed in the wilderness.

### 6.3 Transitions / portals
- `R6.6` Transition between wilderness and an enclosed zone SHALL occur at an explicit **portal tile** (a gate/entrance feature rendered in the wilderness at the zone's world-position).
- `R6.7` Stepping onto a portal SHALL load the enclosed zone's separate space; exiting SHALL return the player to the portal's world-position in the wilderness.
- `R6.8` The safe/wilderness boundary SHALL be enforced at the zone/portal level, **never** as a discontinuity in the terrain field (keeps the field continuous and consistent with function-not-artifact).

---

## 7. Persistence — deterministic until touched

- `R7.1` Terrain, mob spawns, and loot SHALL all be **implied by the generation function** until disturbed. An unvisited, undisturbed chunk SHALL have **zero database rows**.
- `R7.2` SQLite SHALL store only **deltas from the deterministic baseline**: persisted (disturbed) entities, dropped/placed loot, player tile edits, per-player settlement discovery state, deity/region overrides, and player data.
- `R7.3` Database growth SHALL track the footprint of *player activity*, not world area.

### 7.4 Schema sketch (indicative, not binding)
```
players(id, ...)
entities(id, chunkX, chunkY, kind, state, ...)        -- only disturbed/persisted entities
tile_overrides(tileX, tileY, override, ...)           -- player edits, deity-placed tiles
player_world_state(playerId, settlementId, status)    -- unknown|rumored|visited
region_overrides(regionX, regionY, type, payload)     -- deity injections, modulation
settlements(id, worldX, worldY, band, services, ...)  -- placed at prebake or by deity
```

---

## 8. Streaming & netcode

### 8.1 Chunk lifecycle
- `R8.1` Each chunk SHALL map to one Socket.IO **room**. The player SHALL join rooms for chunks within a **load radius** R of their current chunk and leave rooms that fall out of range as they move.
- `R8.2` On joining a chunk room, the server SHALL send only that chunk's **delta set** (entities, overrides) — **never terrain**. The client computes terrain locally (§5.1).
- `R8.3` Entity state changes SHALL broadcast to the relevant chunk room (this provides interest management for free).

### 8.2 Client rendering
- `R8.4` The client SHALL render each chunk's terrain once to an offscreen bitmap (OffscreenCanvas/ImageBitmap) on load and blit it per frame; it SHALL re-render a chunk only when a delta affecting it lands.
- `R8.5` On eviction (chunk leaves load radius), the client SHALL discard render data; on return it SHALL recompute deterministically (cheap).

### 8.3 Coarse→fine handoff *(DEFERRED with rivers — §5.6)*
- `R8.6` *(DEFERRED from v1.)* When connected rivers/roads return, the live chunk generator SHALL produce a believable **tile-level riverbank** from a region-scale river by interpolating the flow path through the chunk, validated for coherence across chunk boundaries. This was the primary correctness risk in the pipeline; cutting rivers from v1 removes it. No globally-iterative terrain feature remains in v1, so there is no coarse→fine handoff to get wrong — standing water (§5.2 step 4) is pointwise.

### 8.4 Determinism contract
- `R8.7` Client and server SHALL produce **identical** terrain and spawn sets from the same `(seed, atlas, chunk coords)`. The generation module SHALL be shared (one TS module imported both sides).
- `R8.8` The atlas SHALL be **generated once server-side and shipped** to clients as a static asset. Clients SHALL **not** regenerate it. (Pointwise eval is float-deterministic across JS engines; *iterative* erosion is not reliably so — keep the iterative step on one machine.)
- `R8.9` The server SHALL be authoritative for all deltas (movement validation, collision, entity state). It validates against the same two layers (atlas + live chunk) the client renders.

---

## 9. Settlements & travel

### 9.1 Placement
- `R9.1` Settlement sites SHALL be selected at prebake by a one-shot spacing query over the completed atlas: **low local danger ∧ within a target band ∧ minimum spacing from other settlements** (blue-noise / Poisson-disk / grid-jitter). Water-adjacency is an OPTIONAL bias (cheap with pointwise water, §5.2 step 4), not a requirement, since v1 has no rivers to sit on.
- `R9.2` Placement is a *rule*; the specific site *emerges* from the fields. MVP places **one** central village; the same mechanism SHALL support N settlements at higher bands with no structural change (a far settlement = the same safe-zone flag + service attachment placed at a band).

> Far settlements function as **forward operating bases**: recall anchor + vendor + safe respawn that let a player operate in the band around them. Progression geography is hub-and-frontier, not radial-from-one-point. This is the humane-retreat structure required by no-permadeath.

### 9.2 Discovery states (per player)
- `R9.3` Each settlement SHALL have one of three states per player:
  - **unknown** — not on the player's map; no compass, no recall.
  - **rumored** — known location (e.g. surfaced via NPC dialogue), not yet unlocked; must be physically reached to advance.
  - **visited** — recall node + safe anchor.
- `R9.4` The mechanism by which a settlement becomes *rumored* is an open content decision (§12) and SHALL NOT block this layer.

### 9.3 Recall & compass
- `R9.5` The player SHALL be able to travel between **visited** settlements at a **cost** (cost model deferred to economy design — §12).
- `R9.6` A HUD compass SHALL indicate the direction to the **nearest visited** settlement. Its purpose is **retreat**, not discovery — it SHALL NOT point at unknown or rumored settlements.
- `R9.7` Recommended: **direction-only** (no distance) to preserve terrain-driven surprise; loosen to direction+distance only if retreat tests as punishing.

---

## 10. Integration hooks (named, not specified here)

These are the seams this layer must leave open. Do **not** implement their contents in this phase.

- **Combat axes (7):** a mob spawn carries an *axis-profile*; the region atlas's `allowed_axis_mask` gates which axes may spawn in a cell (the distance band governs not just intensity but *which axes appear at all*).
- **Loot:** drop tables keyed by danger band; band correlates threat-set with answer-drop-set.
- **Mob prebake library:** a deep offline-generated library, queried semantically at spawn time by axis-profile + band. Spawns are deterministic from chunk seed until disturbed (§7.1).
- **Deities:** operate exclusively on the **region/delta layer** — modulate danger, raise/wake an axis's intensity in a region, inject landmarks/settlements. They pick from a bounded effect table; they never invent or mutate terrain.

---

## 11. Non-goals for this layer
Combat resolution, the 7-axis mechanics, loot/itemization, ability/skill progression, vendor economy, quest/rumor *content*, dungeon internal generation, mob-library *contents*, account/auth. Multiplayer transport scaffolding is in scope (room-per-chunk); multiplayer *features* are not.

---

## 12. Open decisions (your call — tunable, non-blocking)

1. **Chunk size `N`** — e.g. 32×32 (1024 tiles). Bigger = fewer rooms/messages but heavier per-chunk compute and larger bitmaps.
2. **Region cell size `M`** — e.g. 256 (= 8×8 chunks at N=32). Sets how coarse rivers/coasts can be before the §8.3 handoff strains.
3. **World precision bound** — confirm signed-32-bit tile space + danger plateau, or choose another cap.
4. **Erosion / rivers** — *deferred from v1 (§5.6).* No decision needed now. Keep the prebake structured as discrete passes (§5.2) so flow-accumulation rivers and an optional erosion pass slot in later without a rewrite. Decide full-erosion vs flow-stub *then*, when wayfinding actually needs rivers.
5. **Recall cost model** — currency / time / cooldown / item. (Economy design; defer.)
6. **Compass** — direction-only (recommended) vs direction+distance.
7. **Launch settlement count** — single central village (recommended; architecture makes N nearly free) vs seed a few higher-band settlements at launch.
8. **Wobble:radial ratio (R5.7)** — initial value to start tuning from.
