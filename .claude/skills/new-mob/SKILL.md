---
name: new-mob
description: Define a new mob/NPC template (the YAML in world/entities/mobs/), register its sprite, and wire it into the world via a zone spawn. Use when asked to add/create a mob, enemy, NPC, villager, merchant, guard, fixture, sign, or any spawnable creature/character.
---

# Define a new mob

A **mob template** is one YAML file in `world/entities/mobs/<id>.yaml`. "Mob" covers
everything the world spawns as an entity: hostile creatures, friendly NPCs,
merchants, signs, and inert fixtures (torches, boards, wreckage). The loader walks
the directory and keys each file by its `id` — no registry, no index to update.
Adding the file is the registration.

Two things to know up front:

1. **A template is inert until a zone spawns it.** Creating the YAML adds it to the
   catalog but nothing appears in-game until a zone's `spawns` array references its
   `id`. See "Wire it into the world" below.
2. **Default world is `world/`.** The server loads `world/` unless `WORLD_DIR` is set
   (`server/index.ts:41`). The procedural growth pipeline writes a parallel world at
   `world-grown/`. Put your file in `world/entities/mobs/` for the hand-authored
   world; mirror into `world-grown/entities/mobs/` only if targeting a grow run.

Reference templates to copy from (all in `world/entities/mobs/`):
- `villager.yaml` — wandering flavor NPC with dialogue (the canonical simple NPC)
- `merchant.yaml` — `unique` NPC with a `shop`
- `wolf.yaml` — hostile creature with a `loot_table`
- `goblin_shaman.yaml` / `frenzied_husk.yaml` — combatant with `abilities`
- `torch.yaml` / `village_board.yaml` — `fixture` (and `light_radius` / board)

## Schema (`MobTemplate`, `shared/types.ts`)

Required: `id`, `name`, `sprite`, `level`, `role`, `behavior`. (`speed` and
`aggro_range` are effectively required too — combat/movement read them; set them.)

```yaml
id: villager            # kebab/snake, unique; the filename should match
name: Villager          # display name shown in-game
sprite: villager_01     # this mob's OWN sprite key — never another mob's (see "Sprite")
level: 1                # 1–50; with role, derives HP/damage/XP/stats
role: npc               # see roles table — drives combat scaling
speed: 0.5              # tiles/tick movement cadence; 0 = never moves
behavior: wander        # idle | wander | patrol | passive
aggro_range: 0          # tiles; 0 = never initiates combat (correct for NPCs)
xp: 0                   # XP granted on kill; omit to use role/level default
dialogue:               # lines shown on click / chattered while idle
  - "Morning to you."
  - "Cold wind off the water today."
```

Optional fields:
- `loot_table: [{ item: <item_id>, chance: 0..1 }]` — per-item drop rolls. `item` must be a real item base id (`world/entities/items/`).
- `shop: [{ item: <item_id>, price: <gold> }]` — makes the mob a merchant (client shows a buy/sell UI).
- `unique: true` — singleton NPC. The content pipeline refuses to spawn more than one per zone. Use for named characters and the merchant.
- `fixture: true` — indestructible, non-combat world object that only talks when clicked (torches, boards, wreckage). Pair with `behavior: idle`, `speed: 0`, `aggro_range: 0`.
- `sign: true` — clicking opens a read modal showing all `dialogue` lines instead of broadcasting to zone chat.
- `board_id: <stable_key>` — player-writable message board (persists in DB).
- `light_radius: <tiles>` — emits a glow in the night overlay (torches, bonfires).
- `draw_scale: 0..1` — render size as fraction of a tile (default ~0.75; torches use 0.35).
- `respawn_seconds: <n>` — override respawn delay (also settable per-spawn in the zone).
- `stats: { strength?, dexterity?, intelligence?, constitution? }` — override individual derived stats.
- `armor: <n>` — flat armor; otherwise defense is derived from constitution.
- `loot_affinity: [<base_type>]` / `loot_brand: [<element>]` — soft bias for the universal procedural drop (e.g. `light_armor`, `fire_damage`). Currently unused by existing mobs — optional.
- `abilities: [{ ability: <id>, weight?, hp_below? }]` — special attacks. **Every `ability` id must exist in `world/abilities/` or the world fails to load.** `hp_below` (0..1) gates an ability to low health; higher `weight` is preferred.
- `friendly: true` — clicking this mob defaults to dialogue instead of combat, regardless of `role`. **Required for any non-hostile mob that has a combat role** (e.g. `role: soldier` guards, militia, town watchmen). Mobs with `role: npc` are already non-hostile by default and do not need this flag. Fixtures are also excluded from combat targeting without it.

### Roles (`shared/constants.ts` → `MOB_ROLES`)

Role + `level` derive HP, damage, XP, and the stat block. Don't hand-tune stats to
hit a feel — pick the role and let scaling work; tune with `tools/combat-sim.ts`.

| role | use for | hp× | dmg× | notes |
|------|---------|-----|------|-------|
| `skirmisher` | baseline fair fight | 1.0 | 1.0 | the tuning anchor |
| `brute` | heavy hitters | 1.3 | 1.2 | |
| `tank` | damage sponges | 2.2 | 0.5 | |
| `pest` | swarmers (rats) | 1.1 | 1.1 | |
| `soldier` | elites / guards | 1.2 | 1.0 | grants 0 XP; add `friendly: true` for town guards/militia that should not be combat-targetable on click |
| `npc` | friendly/neutral | 2.0 | 0.8 | **deals no damage unless attacked**; high HP so players can't easily grief them; non-hostile click behavior built-in (no `friendly` flag needed) |
| `passive` | critters (deer, squirrel) | 0.7 | 0.0 | flees; small XP |

### Behaviors (`server/game/systems/ai.ts`)

- `idle` — never moves (fixtures, shopkeepers standing at a counter).
- `wander` — drifts randomly within the spawn region (ambient NPCs).
- `patrol` — moves and, if `aggro_range > 0`, pursues players (most hostiles).
- `passive` — stationary until provoked; aggro forced to 0.

For a non-hostile NPC always set `aggro_range: 0` (and `role: npc` or `passive`).

### Sprite

The `sprite` field is **this mob's own visual id**. It does double duty in the
renderer (`client/src/game.ts`):

- The client first tries to load a PNG at `client/public/sprites/<sprite>.png`. If
  that file exists, the mob renders as that image.
- If there is no PNG, the mob renders as a **colored box** using the `color` of the
  matching entry in the active tileset's `sprites` map
  (`world/tilesets/overworld.json`, and `world-grown/tilesets/overworld.json`). An
  unregistered key renders white (`#ffffff`).

**Default to a box, and give every mob its OWN sprite key. Never point `sprite` at
another mob's key.** A `sprite` key is also a PNG filename — so sharing a key means
sharing that mob's art the moment a PNG exists for it. That is exactly how a rat ends
up wearing the cave spider's sprite. The colored box is the correct, safe default
until real art for *this specific* mob is drawn.

So, when creating a mob, do one of these — and **only** these:

1. **Default (a box):** invent a key unique to this mob — `<id>_01` — and add it to
   the `sprites` map in **both** tilesets with a distinct color and **no PNG**:
   `{ "<id>_01": { "color": "#rrggbb" } }`. It renders as a colored square that is
   unambiguously this mob's, and can never be hijacked by someone else's art.
2. **Only if this mob has its own art:** put the PNG at
   `client/public/sprites/<id>_01.png`. The basename **must** equal this mob's
   `sprite` key and the image must depict *this* mob. Dropping the PNG in is the only
   step that turns the box into a picture — no code or tileset change.

Do **not** reuse `cave_spider_01`, `merchant_01`, `bear_01`, etc. for a different
creature because the color or art is "close enough." One key = one mob. (Several
existing NPCs share `merchant_01` as a legacy box; do not extend that pattern — it
means they would all inherit a single PNG at once.)

## Footguns (verified against existing files)

- It's `dialogue:`, **not** `dialog:`. `guard.yaml` uses `dialog:` — it is silently never read, so that guard is mute. Don't copy it.
- `faction:` appears in a few files (`citizen.yaml`, `guard.yaml`) but is **not** in the schema and is ignored. Omit it unless you've added real faction support.
- `xp: 0` for NPCs/fixtures so players gain nothing from killing them. `npc` and `soldier` roles already default to 0, but set it explicitly for clarity.
- **`friendly: true` is not automatic for `role: soldier`.** A town guard or militia uses `soldier` stats but must have `friendly: true` set explicitly — without it, clicking the mob arms combat targeting. Only `role: npc` mobs get non-hostile click behavior built-in.
- Filename should equal `id` (the loader keys by the file's `id` field, but matching avoids confusion).
- **Never borrow another mob's `sprite` key.** It silently shares that mob's PNG art (and box color). Default to a box with this mob's own `<id>_01` key; only add a PNG when it's drawn for this mob.

## Wire it into the world (a template alone does nothing)

Add an entry to the target zone's `spawns` array (`world/zones/<zone>.json`, or
`world-grown/zones/`). `entity` is your mob's `id`.

```jsonc
"spawns": [
  // Exact placement (one entity) — best for unique NPCs, signs, fixtures:
  { "entity": "villager", "at": { "x": 67, "y": 70 }, "respawn_seconds": 86400 },

  // Scattered across a region or rect (groups of creatures):
  { "entity": "wolf", "region": "forest_clearing", "count": 4, "respawn_seconds": 120 },
  { "entity": "wolf", "area": { "x": 10, "y": 10, "w": 8, "h": 6 }, "count": 3 }
]
```

`ZoneSpawn` options (`shared/types.ts`): `at` (exact, count=1, can sit on a wall for
sconces) | `region` (named) | `area` (inline rect); plus `count`, `respawn_seconds`,
`level` (per-spawn level override so one template appears at different levels in
different zones), `spawn_id` (stable id a quest giver can target), `if_region`
(silently skip if the region is absent).

## Steps

1. **Pin down**: id, name, role, level, behavior, and whether it's hostile/NPC/fixture/merchant/sign. The mob's `sprite` is its own key `<id>_01` (a box) — never another mob's. If `role` is `soldier` (or any combat role) but the mob is a friendly faction member (guard, militia, town watchman), add `friendly: true`. State these back as assumptions.
2. **Create** `world/entities/mobs/<id>.yaml` matching a reference file's style; set `sprite: <id>_01`.
3. **Sprite (default: box)**: add a new `{ "<id>_01": { "color": "#…" } }` to the `sprites` map in `world/tilesets/overworld.json` (and `world-grown/tilesets/overworld.json` if the grow world needs it). Pick a distinct color. Do **not** reuse another mob's key. Only add `client/public/sprites/<id>_01.png` if you have art drawn for *this* mob.
4. **Abilities** (if any): confirm each id exists in `world/abilities/`.
5. **Wire** a spawn into the relevant zone's `spawns` array (or tell the user it's catalog-only and ready to spawn).
6. **Validate** — typecheck and load the world:
   ```bash
   npx tsc --noEmit -p .
   node --input-type=module -e "
   import { loadWorld } from './server/world/loader.ts';
   const w = loadWorld('world');
   const m = w.mobs['<id>'];
   if (!m) throw new Error('mob not loaded');
   console.log('loaded', m.id, m.role, 'level', m.level, 'sprite', m.sprite);
   "
   ```
   A bad `role` or unknown `ability` throws here; a missing mob means the file
   wasn't picked up (wrong dir or extension). For `world-grown`, pass `'world-grown'`.
7. **Report** the id, role/level, sprite (and whether you registered a new color), and where it spawns.
