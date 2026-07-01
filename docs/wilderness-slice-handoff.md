# Continuous Wilderness — Vertical Slice Handoff

**Status:** Implemented and running. First playable slice of the `docs/rework.md`
paradigm shift (zone-bucketed world → continuous field-sampled wilderness with
enclosed zones). This doc is the pickup point for a fresh context window.

**Branch:** `feature/center-out`. Original spec: `docs/rework.md`. Approved plan:
`~/.claude/plans/buzzing-hatching-noodle.md`.

---

## What this slice does

- The hand-authored starting village (`zone_0_0`) stays as the central **enclosed
  zone** (the existing zone engine is unchanged — it *is* the enclosed-zone model).
- A **portal tile at (52,63)** in the village drops the player into a continuous,
  effectively-infinite **wilderness** at world tile **(0,8)**.
- Wilderness terrain (elevation/temperature/moisture → biome → tile) and **danger**
  (rises radially from origin, plateaus at radius) are computed **pointwise** from
  `(x,y,seed)` by a **shared module imported by both client and server**, so the
  client renders exactly what the server validates (the determinism contract).
- Terrain is **never sent over the wire** — only entities, streamed **per chunk**
  (one Socket.IO room per 32×32 chunk). Mobs spawn deterministically per chunk,
  scaled by distance-from-origin danger band, materialized while observed.
- Walking back onto the wilderness gate **(0,8)** returns to the village.
- Movement (WASD + click-to-path), combat/selection, minimap, and a fog-of-war
  world map all work in the wilderness.

## How to run

```
WORLD_SEED=silicon-soup npm run dev      # open the Vite URL (5173), NOT :3000
```
or `npm run build && WORLD_SEED=silicon-soup npm start` (open :3000).
`WORLD_SEED` defaults to `silicon-soup`. Enter the wilds via the village gate at
**(52,63)**; return via **(0,8)**. The atlas caches to `data/atlas-<seed>.json`
(gitignored; delete to regen).

> **If you see the "default world":** you're on a stale `client/dist`. Use
> `npm run dev` (Vite recompiles) or rebuild before `npm start`.

---

## Architecture

### Shared generation (`shared/worldgen/`) — the determinism core
- `config.ts` — all tunables: `WILD='wild'`, `CHUNK_SIZE=32`, `REGION_CELL_SIZE=256`,
  `WILD_LOAD_RADIUS=2`, `DANGER_RADIUS=4000`, `WOBBLE_AMP=0.35`, sea/mountain
  levels, noise scales, `DEFAULT_WORLD_SEED='silicon-soup'`.
- `noise.ts` — pure PRNG + value/octave noise. **Moved out of
  `server/game/mapgen/rng.ts`**, which now re-exports it (so existing mapgen
  importers are unchanged). This move is what lets the client compute identical terrain.
- `field.ts` — pointwise `elevation/temperature/moisture`, Whittaker `classifyBiome`,
  `wildTileAt(x,y,seeds,atlas?)`, `dangerAt`, `getLevelBand`, `deriveSeeds`,
  `isWildBlocked` / `WILD_BLOCKING` (**only `tree` blocks**; water and rock are
  passable — see "gotchas").
- `atlas.ts` — `RegionAtlas` (seed, danger radius, **settlement registry**) +
  pure `buildAtlas(seed)`. Settlements carry `worldX/worldY` and a wilderness-side
  `portalX/portalY` gate. Central village → gate at (0,8).

### Server
- `server/game/wilderness.ts` — the streamer. `chunkOf`, room `wild:cx,cy`,
  `syncPlayer` (join/leave chunk rooms on move + initial payloads), `broadcast`
  (per-chunk entity full-replace when `wild` is dirty), `materializeChunk` /
  `despawnChunk` (deterministic mob spawns, kept if mid-fight), `removePlayer`,
  `returnTargetAt`.
- `server/game/world.ts` — `canMoveTo`/`teleportPlayer`/`_findFreeWild` wilderness
  branches; `wildReturnTargetAt`; `exitWilderness`; `wildSeeds`/`atlas` fields;
  extracted `entityToSnapshot` (shared by zone snapshots + chunk stream) which now
  also sets mob `disposition`.
- `server/game/loop.ts` — `_tryPortal` handles `to.zone==='wild'` (enter) and the
  wilderness return gate (exit).
- `server/game/systems/autopath.ts` — `planPath` generalized: switches on a
  walkability predicate (`canMoveTo` for wild vs grid `isBlocked`) and uses
  **string node keys** so signed coords don't collide. 4000-node cap.
- `server/index.ts` — atlas prebake/load **before** `setDefinitions` (so portal
  synthesis sees it), `GET /api/atlas`, `wild_enter/chunk/leave` wiring in
  join/move/zone-change/death/disconnect, `wild` room join for zone-wide
  combat/heal/chat broadcasts, per-chunk broadcast on `wild` dirty.

### Client
- `client/src/wilderness.ts` — atlas fetch + `deriveSeeds`, per-chunk tile cache
  (`wildTile`), chunk entity merge (`wildEntities`), `visitedChunks` (fog-of-war
  reveal set), `wildWalkable`, socket handlers (`onWildEnter/Chunk/Leave`, `exitWild`).
- `client/src/game.ts` — `isWild()`-gated branches in `render` (signed-coord tile
  loop from `wildTile`, entities from `wildEntities`, `state.zone.entities` kept
  synced so combat/targeting consumers work), `pickAt`, `isWalkable`, the HUD hover
  label, the **minimap** (`renderWildernessMinimap` — live local window, no baked
  bitmap), and the **world map** (`renderWildernessMap` — fog-of-war overview).
  `miniDotColor` colors mob dots by disposition.
- `client/src/socket.ts` — `wild_enter/chunk/leave` handlers; `zone`/`respawn`
  clear wild state; join tolerates a zoneless (wilderness) resume.

### Shared types (`shared/types.ts`)
- `ServerToClientEvents`: `wild_enter`, `wild_chunk`, `wild_leave` (+ `WildEnterEvent`,
  `WildChunkEvent`).
- `EntitySnapshot.disposition?: 'hostile'|'passive'|'friendly'`.

### Persistence
No schema change. A player logged out in the wilderness saves `zone='wild'` with
signed `x,y` and resumes into wilderness streaming. Unvisited wilderness writes
zero DB rows (deterministic).

---

## Gotchas discovered (already fixed — context for future work)
- **Rock was blocking** → the origin sits on a mountain, so the (0,8) gate was
  boxed in by rock; player couldn't move. Fix: only `tree` is a hard obstacle.
- **Atlas ordering**: must be set on `world` *before* `setDefinitions`, or portal
  synthesis falls back to gate (0,0).
- **Combat looked broken** for two reasons: (1) combat/targeting read
  `state.zone.entities`, empty in the wild — now synced to `wildEntities()` each
  frame; (2) combat/heal/chat broadcast to `io.to('wild')` but players were only in
  chunk rooms — they now also join a shared `wild` room.
- **Minimap crash**: baked a 0-size bitmap from the wild stub's `width/height`.
  Now a dedicated live wilderness minimap.

---

## Loose threads / next steps

**Worldgen tuning (expected iterative):**
- **Mob density feels low** — bump `count`/spawn probability in
  `Wilderness.materializeChunk` (currently `1 + danger*3` candidates, 0.7 spawn roll).
- Biome/tile palette is coarse (grass/forest/sand/snow/rock/swamp/water). Tune
  thresholds and add variety in `field.ts` `wildTileAt`.
- Danger wobble keeps survivable pockets even far out (intended, R5.6) — it does
  **not** pin to tier-5 past the radius. Revisit if the deep field should be uniformly lethal.

**Fog of war / map:**
- Reveal set (`visitedChunks`) is **session-only, client-side** — resets on relog.
  Persist per-player (ties into the deferred `player_world_state`/delta tables).
- World-map hover/pick is disabled in the wilderness (no cell tooltips). No pan/zoom
  for the wild map yet.

**Streaming / scale:**
- Combat/heal/chat broadcast to the **whole** `wild` room, not interest-managed per
  chunk. Fine for a few players; revisit for scale.
- Terrain is chunk-cached but **not** rendered to OffscreenCanvas bitmaps (R8.4 only
  partially honored). If scrolling stutters with a bigger viewport, do the bitmap cache.
- Wilderness autopath capped at 4000 nodes (~60-tile radius) — no long-haul travel.

**Deferred by design (per plan / `docs/rework.md`):**
- Delta persistence tables (`entities`, `tile_overrides`, `region_overrides`,
  `settlements`, `player_world_state`) — §7.4.
- Dungeons, multi-settlement placement, recall between settlements, retreat compass.
- Hydrologically-coherent rivers + the §8.3 coarse→fine handoff.
- Integration seams left open but unused: `allowed_axis_mask` on the atlas,
  loot-by-band, mob-library semantic query, deity region/delta ops.
- Wilderness mobs are picked uniformly from huntable templates by band — no
  axis-profile matching yet.
- Wilderness respawn is via chunk re-materialization on re-observe (no timer);
  mid-fight mobs are preserved on unsubscribe.

**Housekeeping:**
- Pre-existing typecheck error `client/src/game.ts` `new ImageData(...)` (TS lib
  `SharedArrayBuffer`/`ArrayBuffer` mismatch) — present on `HEAD`, unrelated to this
  work. Everything else typechecks clean (server/pipeline/tools).
- Determinism was verified via a throwaway script (5000 points, 0 mismatches), not a
  committed test — consider adding one under `tools/` or `scripts/`.
- Bounded-zone minimap still draws its viewport box; the wilderness minimap's was
  removed intentionally.

## Verification performed
- `npm run typecheck`: server/pipeline/tools clean; client only the pre-existing
  `ImageData` error.
- Determinism: 5000 sampled points, 0 client/server mismatches; gate reads as a
  walkable `portal`; biome/band spread healthy.
- Headless sims: village→gate→wilderness transition, movement in all directions,
  wilderness autopath (incl. negative coords).
- Server boot: atlas prebakes + serves at `/api/atlas`; village portal synthesizes
  to `wild (0,8)`; no warnings.
