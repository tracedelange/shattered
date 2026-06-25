---
name: new-zone
description: Create a new zone JSON file, wire its connections, and optionally stamp a portal entrance into a parent zone. Use when asked to add/create a zone, area, cave, dungeon, cellar, hollow, sewer, grotto, or any new map region.
---

# Create a new zone

A **zone** is a JSON file in `world/zones/<id>.json` (hand-authored world) or `world-grown/zones/<id>.json` (grow world). The engine auto-discovers all JSON files in those directories — no registry to update.

Two things to know up front:

1. **Sub-zones (caves, dungeons) need two files.** The cave itself (`zone_X_Y_<slug>.json`) plus a portal entry in its parent zone (`zone_X_Y.json`). A cave with no entrance portal is unreachable.
2. **Default world is `world/`.** The server loads `world/` unless `WORLD_DIR` is set. Mirror into `world-grown/` only if targeting a grow run.

---

## Zone ID conventions

| Zone type | ID pattern | Example |
|---|---|---|
| Overworld grid zone | `zone_<col>_<row>` | `zone_12_7` |
| Named sub-zone (cave, dungeon) | `zone_<col>_<row>_<slug>` | `zone_40_39_crypt` |
| Village | `village_<col>_<row>` | `village_41_41` |
| Named city | `city_<col>_<row>` | `city_13_19` |

The filename should match the `id` field exactly (`zone_40_39_crypt.json` → `"id": "zone_40_39_crypt"`).

---

## Schema (`ZoneDef`, `shared/types.ts`)

Required: `id`. Everything else has defaults or is biome-driven.

```jsonc
{
  "id": "zone_12_7",             // unique; matches filename
  "name": "The Amber Flats",     // display name (optional; client falls back to biome)
  "biome": "grassland",          // see Biomes table — drives ops; omit for hand-authored ops
  "seed": "133e18d0_12_7",       // string; any stable unique value; drives biome variance
  "level_band": {
    "tier": 1,                   // 1 (easiest) – 5 (hardest)
    "minLevel": 1,
    "maxLevel": 5
  },
  "width": 150,                  // default 150; sub-zones often use 80–120
  "height": 150,
  "tileset": "overworld",        // overworld | dungeon; omit to inherit from biome
  "default_tile": "grass",       // fallback tile; biome sets this automatically
  "connections": {               // zone links; see Connections section
    "north": "zone_12_6",
    "south": "zone_12_8",
    "east": "zone_13_7",
    "west": "zone_11_7"
  },
  "spawn_point": { "focal": true }, // always set for sub-zones (caves/dungeons)
  "features": [                  // feature operators or prefab stamps
    "wilderness_border",
    { "id": "fountain", "at": { "x": 60, "y": 60 } }
  ],
  "spawns": [                    // entity spawns (template must exist in world/entities/mobs/)
    { "entity": "wolf", "count": 4, "respawn_seconds": 180 },
    { "entity": "npc_elder", "at": { "x": 70, "y": 70 }, "respawn_seconds": 86400 }
  ],
  "post_ops": []                 // post-generation ops (portals, stamps); see below
}
```

---

## Biomes

`biome` drives tile generation automatically. Pick the closest fit; don't author ops by hand when a biome works.

| biome | typical tiles | tileset |
|---|---|---|
| `grassland` | grass, scattered trees | overworld |
| `plains` | grass, open | overworld |
| `forest` | dense trees | overworld |
| `swamp` | water patches, trees | overworld |
| `village` | building plots, market | overworld |
| `mountain` | rock | overworld |
| `tundra` | sparse trees | overworld |
| `cave` | stone walls, stone floor | dungeon (auto) |

For sub-zones (caves, dungeons) always use `biome: "cave"` — it auto-selects the dungeon tileset.

---

## Connections

`connections` is a `Record<string, zone_id>`.

- **Cardinal keys** (`north`, `south`, `east`, `west`): edge-transition portals. Both sides must declare the other.
- **Non-cardinal keys** (any other string, e.g. `crypt`, `sea_cave`, `sewer_grate`): interior return portal back to a parent zone. The engine auto-synthesizes the return exit tile in the sub-zone.

```jsonc
// Overworld zone — cardinal links
"connections": {
  "north": "zone_12_6",
  "south": "zone_12_8"
}

// Sub-zone — non-cardinal back-link to parent
"connections": {
  "crypt": "zone_40_39"     // any key except the four cardinals
}
```

---

## Entrance portals (sub-zones only)

A sub-zone is unreachable until its parent zone stamps an entrance and wires a portal `post_op`.

**Step 1 — create the entrance prefab (you almost always must).**

⚠️ **There is no library of pre-built entrance prefabs.** `world/prefabs/` ships with
essentially nothing reusable as an entrance (only `village_notice_board.json`).
**List the directory first** (`ls world/prefabs/`) and use a prefab id *only* if you
see its file there with an `anchors.descend` entry. **Do not name a prefab from
memory** — a stamp of a non-existent prefab is silently skipped, the portal then
fails to resolve, and the sub-zone is unreachable (the world still loads, so this
passes a naive check). Default assumption: **you will create the prefab.**

Create one in `world/prefabs/<id>.json`. Verified working format:
```json
{
  "id": "bear_cave_entrance",
  "description": "A cave mouth set into a back wall of boulders, open apron in front.",
  "data": "ooo\n.D.\n...",
  "legend": { "o": "cairn_stone", "D": "portal", ".": "dirt" },
  "anchors": { "D": "descend" }
}
```
Rules that make it actually work:
- `data` is an ASCII grid, rows joined by `\n`; every char must appear in `legend`.
- `legend` maps each char to a **real tile id** (see the Biomes/tileset tiles, e.g.
  `cairn_stone`, `wall`, `stone_floor`, `dirt`, `grass`). An unknown tile renders wrong.
- `anchors` maps the portal char to the tag the parent's portal op targets — for a
  downward entrance that tag is `descend`. **Use exactly one anchor cell** so
  `anchor_of` resolves to a single tile.
- The portal post-op repaints the anchor cell with the `portal` tile, so the anchor
  char's `legend` tile is only the fallback look; surrounding tiles are cosmetic.
- **Do NOT box the portal in on all sides with blocking tiles.** Players land *on*
  the portal tile when they ascend back through it, so the anchor must have at least
  one walkable **orthogonal** neighbour (N/S/E/W) or they're trapped. Blocking tiles
  include `wall`, `cairn_stone`, `void`, `water`, `tree`, `pale_wall` — surround the
  portal with at least one open side of a walkable tile (`dirt`, `grass`, `stone_floor`).
  The `ooo / .D. / ...` layout above does this: boulders behind, open ground in front.

**Step 2 — add `post_ops` to the parent zone.**

Placement options for `at`:
- `{ "random_free": true }` — anywhere with open space
- `{ "near_tile": "grass", "margin": 4 }` — near a specific tile type
- `{ "in_region": "<region_name>" }` — inside a named region
- `{ "free_edge": "west", "inset": 3 }` — near a zone edge

```jsonc
// In the parent zone (world/zones/zone_40_39.json):
"post_ops": [
  {
    "type": "stamp",
    "at": { "random_free": true },
    "prefab": "goblin_den_entrance",
    "region": "den_entrance",
    "overwrite": true
  },
  {
    "type": "portal",
    "at": {
      "anchor_of": "goblin_den_entrance",
      "anchor": "descend"
    },
    "target_zone": "zone_42_41_goblin_den",
    "transition": "descend"
  }
]
```

The `region` name in the stamp op is arbitrary but must match the sub-zone's `connections` key if you use `in_region` for the portal — they're independent strings. The portal's `anchor_of` must equal the prefab `id`, and the portal's `anchor` must equal a **tag value** in that prefab's `anchors` map (the right-hand side, e.g. `descend`), not the char key (the left-hand side).

---

## Spawns

```jsonc
// Exact placement
{ "entity": "rat_king", "at": { "x": 60, "y": 40 }, "respawn_seconds": 600 }

// Count scattered anywhere
{ "entity": "rat", "count": 8, "respawn_seconds": 90 }

// Count in a named region (region must exist after post_ops resolve)
{ "entity": "giant_rat", "region": "cave_main", "count": 4, "respawn_seconds": 120 }

// Count in inline rect
{ "entity": "wolf", "area": { "x": 10, "y": 10, "w": 20, "h": 20 }, "count": 3 }
```

`entity` must be a mob `id` in `world/entities/mobs/` (or `world-grown/entities/mobs/`). The loader won't crash on an unknown entity but the spawn silently fails.

---

## Procedural generation params

Fine-tune biome output without hand-authoring ops:

```jsonc
"zoneParams": { "inset": 8 },           // zone-wide inset (tiles)
"opParams": {
  "village_plots": { "count": 10 },      // fewer buildings
  "forest_trees": { "threshold": 0.55 }  // denser forest
}
```

Valid param keys are in `world/biome-params.json`.

---

## Steps

1. **Pin down**: zone id (pick the grid coords + optional slug), zone type (overworld vs sub-zone), biome, level band, connections, and key spawns. State these as assumptions.
2. **Create** `world/zones/<id>.json`. For a sub-zone use `biome: "cave"`, `spawn_point: { focal: true }`, and a non-cardinal `connections` back to the parent.
3. **Entrance** (sub-zones only):
   a. Create an entrance prefab in `world/prefabs/<id>.json` (do not assume one
      exists — `ls world/prefabs/` first; there is no entrance library).
   b. Add `post_ops` (stamp + portal) to the parent zone JSON, pointing `target_zone` at the new sub-zone id.
4. **Verify** — typecheck, load, **and for any sub-zone with an entrance, actually
   run mapgen.** Loading alone does NOT execute `post_ops` (stamps/portals run at
   map-generation time), so a broken entrance passes a load-only check while leaving
   the cave unreachable. For an entrance you MUST generate the parent zone's grid and
   confirm a portal resolved:
   ```bash
   npx tsc --noEmit -p .
   node --input-type=module -e "
   import { loadWorld } from './server/world/loader.ts';
   import { generateZoneGrid } from './server/game/mapgen/index.ts';
   const w = loadWorld('world');
   const parent = '<parent_zone_id>';   // the zone whose post_ops stamp the entrance
   const z = w.zones[parent];
   if (!z) throw new Error('parent zone not loaded');
   const g = generateZoneGrid(z, w.blockingTiles, w.prefabs);
   if (!g.postOpPortals.length) throw new Error('NO PORTAL RESOLVED — entrance is broken (check prefab id + anchor)');
   console.log('portals from', parent, '->', JSON.stringify(g.postOpPortals));
   "
   ```
   Watch the console for `[mapgen]` warnings during that run — `prefab '<id>' not
   found`, `no '<tag>' anchor on prefab`, or `portal → '<zone>' skipped: unresolved
   'at'` all mean the entrance failed and `postOpPortals` will be empty. A missing
   zone means the file wasn't picked up (wrong dir or extension).
5. **Report** the id, biome, level band, connections, spawns, and (for sub-zones) which parent zone was modified and which entrance prefab was used.
