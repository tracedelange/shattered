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
epoch = floor((now + pacificOffset(now)) / WILD_EPOCH_MS)   // one day, 00:00 PT
seed  = `${WORLD_SEED}#${epoch}`
```

The world rolls at **midnight Pacific** (`WILD_EPOCH_TZ`), not midnight UTC —
counting straight from the Unix epoch would put the boundary in the middle of the
afternoon. The offset comes from a named zone rather than a hardcoded number, so
DST is handled: the roll stays at local midnight across both transitions, which
makes a DST day genuinely 23 or 25 hours long. Falling back repeats an hour of
local time and so can repeat a bucket number; rotation only ever moves forward,
so that resolves as one longer day rather than a world rolling backwards.

`shared/worldgen/epoch.ts` owns the clock and nothing else. Keeping the
operator-facing base seed in the string means `WORLD_SEED` still selects the
whole *sequence* of worlds — same base, same run of days — which is what makes a
rotating world reproducible at all.

`WILD_ROTATE=0` pins epoch 0. Generator tooling and fixtures want a world that
does not move under them.

`WILD_EPOCH_MS` overrides the interval, so the whole rotation path can be
exercised without waiting for midnight — `WILD_EPOCH_MS=180000` rolls every three
minutes. Only the **server** reads the clock (the client takes the live epoch off
the atlas), so shortening it needs no client rebuild. A boundary lands wherever
the interval divides the local timeline, so a 3-minute epoch rolls on every third
minute of the hour, *not* three minutes after boot. The rotation poll and the
player warning lead times scale off this interval, so a short test epoch does not
end up polled every 30s or warned about before it starts.

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
   locally, so all of it is wrong the instant the seed changes. A `wild_reset`
   event drops `tileCache`, the streamed entities, and the atlas itself, then
   refetches `/api/atlas`. Discoveries are explicitly kept — they are keyed by
   site id, not position, and surviving is the point of them.

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

## Rotating live

Rotation happens **in place, with no restart**. A full rebuild measures ~35-80ms
against a 100ms tick, so the whole swap fits inside a single tick; the difficulty
was never the cost, it was evicting every piece of state derived from the
outgoing seed.

`rotateWilds()` in `server/index.ts` is the imperative half, and its **order is
the design**:

1. Build the next world *first* (`loadWorld` + `buildAtlas`). Nothing live has
   been touched, so a bad roster or a disk error leaves the current epoch running
   instead of a half-swapped world.
2. `planRotation()` (`server/game/rotation.ts`) decides what moves and what dies,
   against the outgoing world. It is pure, so the rule is unit-tested without a
   running server.
3. **Evacuate** — players in the wilds *and* players inside a dungeon. The
   dungeon case is the subtle one: the zone id survives the rotation, so nothing
   else in the system would notice that its rooms are about to be regenerated.
4. **Cull** the wilderness. `World._rebuildZone` clears and respawns each grid
   zone it rebuilds, but it iterates `defs.zones` and `WILD` is not one of them —
   so the open world's mobs, corpses, dropped loot, and ground hazards are
   nobody else's job.
5. Clear every stored autopath: a path is a list of tiles in a world that no
   longer exists.
6. Swap the seed. The atlas must be on the world **before** `setDefinitions`,
   because portal synthesis resolves village gates and dungeon entrances out of
   it — the same ordering constraint boot has.
7. `wild_reset` to every client, fresh zone snapshots, re-stream the wilderness.
8. Persist immediately, so a crash seconds later cannot strand anyone at a
   position stamped with the wrong epoch.

**Scheduling** is a poll (`ROTATION_POLL_MS`), not a timer to the epoch boundary:
a `setTimeout` hours out does not survive a laptop sleeping or the clock stepping,
and fails silently. Rotation only ever moves *forward*, so a backwards clock
correction cannot drag players into a world that has already been retired.

**Players are warned** at 5 minutes and 1 minute. Without that, a player fighting
in the wilds is teleported to town with no explanation, which reads as a bug.

**`kill -USR2 <pid>`** forces the next epoch immediately. It is the ops lever for
rolling the world early, and the only way to exercise the rotation path without
waiting for midnight. It advances one epoch ahead of the wall clock; the
scheduled rotation resumes once the clock catches up.

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

- Multi-floor dungeons: synthesized portals between synthesized zones.
- Evacuation is verified by unit tests over `planRotation` plus two live forced
  rotations on an empty server. An end-to-end run with a player actually standing
  in the wilds needs Firebase credentials, so it has not been exercised.
- A player deep in a dungeon loses their run when the epoch turns. The
  alternative — keeping the previous epoch's zone defs alive until the last
  occupant leaves — turns a single-epoch world into a two-epoch one and touches
  every atlas lookup. Evacuating is the deliberate choice, not an oversight.
- Roster subsetting — only place N of M dungeons per epoch — needs the map to
  handle "discovered but not present today" before it is safe.
