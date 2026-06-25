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

**Step 1 — choose or create an entrance prefab.**

Available entrance prefabs in `world/prefabs/` (all have an `anchors.descend` portal tile):

| prefab | best for |
|---|---|
| `crypt_entrance` | stone ruins, ancient structures |
| `goblin_den_entrance` | earthen cave mouths |
| `grotto_entrance` | mossy natural openings |
| `sea_cave_entrance` | coastal cave mouths |
| `cellar_entrance` | outdoor cellar hatches |
| `cellar_hatch` | floor hatches inside buildings |
| `sewer_entrance` | underground sewers |
| `wolf_den_entrance` | animal dens |
| `sinkhole_entrance` | collapsed sinkholes |
| `root_cellar_hatch` | farmstead storage |
| `well_entrance` | well shafts |
| `bandit_cellar` | hidden cellar under camp |

If none fit, create a new one in `world/prefabs/<id>.json`:
```json
{
  "id": "my_entrance",
  "description": "...",
  "data": "###\n#P#\n###",
  "legend": { "#": "cairn_stone", "P": "portal" },
  "anchors": { "P": "descend" }
}
```
(`P` is the walkable portal tile; tiles around it are cosmetic.)

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

The `region` name in the stamp op is arbitrary but must match the sub-zone's `connections` key if you use `in_region` for the portal — they're independent strings. The portal's `anchor_of` must match the prefab `id`, and `anchor` must match a key in that prefab's `anchors` map.

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
   a. Pick or create an entrance prefab.
   b. Add `post_ops` (stamp + portal) to the parent zone JSON, pointing `target_zone` at the new sub-zone id.
4. **Verify** — typecheck and load the world:
   ```bash
   npx tsc --noEmit -p .
   node --input-type=module -e "
   import { loadWorld } from './server/world/loader.ts';
   const w = loadWorld('world');
   const z = w.zones['<id>'];
   if (!z) throw new Error('zone not loaded');
   console.log('loaded zone', z.id, 'connections:', JSON.stringify(z.connections));
   "
   ```
   A missing zone means the file wasn't picked up (wrong dir or extension). An unknown `target_zone` in a portal op logs a warning at load time — check the console.
5. **Report** the id, biome, level band, connections, spawns, and (for sub-zones) which parent zone was modified and which entrance prefab was used.
