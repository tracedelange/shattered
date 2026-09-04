# Rotating wilds

The open world re-rolls on a clock. Terrain, spawns, and dungeon placement and
layout all change together on an interval; the starting village does not. This
doc is the "why" behind that, and the invariants it rests on.

## The one-seed lever

Everything about the wilderness already derived from a single seed:

```
WORLD_SEED → resolveSeed() → atlas.numericSeed → deriveSeeds() → the field
                                               → per-chunk spawn RNG
```

So rotation is not a new subsystem. It is a time bucket folded into that seed:

```ts
epoch = floor(now / WILD_EPOCH_MS)          // one UTC day
seed  = `${WORLD_SEED}#${epoch}`
```

`shared/worldgen/epoch.ts` owns those two lines and nothing else. Keeping the
operator-facing base seed in the string means `WORLD_SEED` still selects the
whole *sequence* of worlds — same base, same run of days — which is what makes a
rotating world reproducible at all.

`WILD_ROTATE=0` pins epoch 0. Generator tooling and fixtures want a world that
does not move under them.

## What must not rotate

**Danger.** `dangerAt(x, y)` is radial and seed-independent: distance from the
origin *is* the progression scalar (`docs/rework.md` §5.5). A rotation re-rolls
the wobble stream, but the radial trend dominates and the mean danger at a given
radius is unchanged — `shared/worldgen/epoch.test.ts` asserts this on a ring.

This is the property that makes rotating the entire world safe rather than
hostile. Yesterday's safe ring is today's safe ring. A player's sense of "how far
out I can go" survives every rotation even though nothing they can see does.

**The village.** Enclosed zones carry their own seeds and the atlas gates are
hardcoded at the origin, so town is byte-identical across epochs. It is the fixed
point players return to, and the only place guaranteed walkable in every world —
which is why it is where stale wilderness saves land (below).

## Rotation is a lifecycle event

Three things break at an epoch boundary, and each is handled explicitly:

1. **Characters saved in the wilds.** A save records signed world tiles; next
   epoch that tile could be open water or inside a tree blob. Characters carry a
   `wild_epoch` column, and a join with a stale one restores at the village gate
   (`wildRestorePoint`). Enclosed-zone saves are untouched.

2. **Client caches.** The client caches the atlas once and derives chunk terrain
   locally. Rotation currently happens **at boot only** — a scheduled restart —
   so every client reconnects and refetches. Live mid-session rotation would need
   an eviction protocol (flush `tileCache`, refetch `/api/atlas`, relocate anyone
   standing in the wilds) and is deliberately not built yet.

3. **Atlas caches on disk.** Keyed by the full epoch seed, so a rotation is a
   cache *miss*, not an invalidation — yesterday's atlas stays readable. The
   current and immediately-previous epoch are kept; older ones are pruned.

## Dungeons: roster vs. instance

A dungeon is split the same way the forge splits vocabulary from instance, only
along a time axis instead of a generation run.

| | Persistent | Re-rolled per epoch |
|---|---|---|
| identity | id, name, level band, biome affinity | — |
| position | — | entrance tile in the wild |
| interior | the zone *program* (biome, features, spawns) | the zone *seed* → the actual grid |

`world/dungeons/*.json` is the roster: a `DungeonDef` carrying `placement`
metadata plus a zone template that must **not** set `id` or `seed`. The loader
supplies both — `seed = "<dungeon id>:<epoch>"` — so the same named dungeon has a
different layout every day while every reference to it (portals, discoveries,
quests) stays stable. Regions the template names must be ones the biome always
produces (`cave_main`, `room_main`); anything else needs `if_region: true`.

**Placement.** Since danger is radial, a level band *is* a radius annulus from the
origin. That is the whole constraint: a rotation moves a dungeon around its ring,
never across bands, so a level-8 dungeon is a level-8 dungeon every epoch. Within
the ring, placement rejection-samples for an entrance on genuinely open ground,
in a themed biome, whose local wilderness band overlaps the dungeon's own — the
mobs outside the door should be roughly the mobs behind it. Theming constraints
relax in the last third of the attempts because **every roster entry must be
placed every epoch**: a discovered dungeon that vanished for a day would make the
map lie.

**Entrance and exit.** The entrance is a walkable `portal` tile, exactly like a
settlement gate, with a small rock-outcrop stamp around it so it reads as a place
from a distance. The tile check runs before the stamp so the footprint can never
seal its own door. The dungeon's exit portal is resolved from the live atlas at
load time, not written into the template, and lands on the entrance tile — the
mirror of how a village exit works.

## Discovery is the thing that persists

In a world that re-rolls daily, exploration cannot be the thing you keep. So
discovery keys on **identity, not location**: `discoveries(character_id, site_id)`
stores no coordinates. Find a dungeon once and it is marked on your map forever,
at whatever position the current epoch gave it.

A sighting is recorded when a player comes within `DISCOVERY_RADIUS` tiles of an
entrance, or enters the dungeon by any route.

## The world map

The old wilderness map was a session-scoped fog-of-war reveal over visited
chunks. That was already lossy (it reset on reload) and under rotation it becomes
meaningless — the reveal would be wiped daily.

It is gone. The client holds the atlas *and* the same field module the server
generates from, so it can draw the entire world coarsely without the player
having visited any of it. The map is now three layers:

- **terrain**, sampled straight from the field (bypassing the per-chunk tile
  cache — a coarse sweep of the world would otherwise materialize thousands of
  32×32 chunk arrays for one modal),
- **danger rings**, the one thing that means the same in every epoch,
- **discovered sites**, labeled. Undiscovered sites are absent, and do not widen
  the map window either — that would leak their position.

## Open threads

- Live rotation without a restart (see #2 above).
- Multi-floor dungeons: synthesized portals between synthesized zones.
- Roster subsetting — only place N of M dungeons per epoch — needs the map to
  handle "discovered but not present today" before it is safe.
