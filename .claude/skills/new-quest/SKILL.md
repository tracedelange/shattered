---
name: new-quest
description: Create a new multi-stage questline (one or more YAML files in world/quests/) and wire givers, objectives, and zone requirements. Use when asked to add/create a quest, questline, quest chain, or any NPC-given task with objectives and rewards.
---

# Create a new questline

A **quest** is one YAML file per quest in `world/quests/<id>.yaml`. The loader
auto-discovers all YAML files in that directory — no registry to update. Adding
the file is the registration.

A **questline** is two or more quests chained via `unlock_after`. The second quest
becomes available only after the player completes the first. There is no limit to
chain length; each quest is its own file.

Two things to know up front:

1. **A quest needs a giver to appear in-game.** `giver` is a mob template id or
   spawn_id. The mob must exist in `world/entities/mobs/` and be spawned in a zone.
   If the giver is a new NPC, use the `/new-mob` skill first.
2. **Cross-zone questlines are just two quests with matching `unlock_after`.** No
   extra wiring needed — each quest points to its own zone and giver independently.

---

## Schema (`QuestDef`, `shared/types.ts` + `server/world/quest_schema.ts`)

```yaml
id: rat_problem          # kebab/snake; unique; the filename should match
name: Rat Problem        # display name shown in-game
giver: village_board     # mob template id OR spawn_id from a zone's spawns array
zone: village_41_41      # zone where the giver lives (informational; not enforced)
description: |           # flavour text shown in the quest log
  A notice pinned to the board reads: "Rats in the drains..."
unlock_after: prior_quest_id   # or a list: [quest_a, quest_b] — all must complete
repeatable: true         # omit for one-time quests (default)
stages:
  - id: start
    text: "You read the notice."    # shown in the quest log for this stage
    on_complete: kill_rats          # id of the next stage, or "done"
  - id: kill_rats
    text: "Kill six rats in the sewers."
    objective:
      kind: kill_count
      target: 6
      template_id: rat             # optional — filters to this mob type only
      zone: zone_41_41_sewer       # optional — filters to this zone only
    on_complete: report_renn
  - id: report_renn
    text: "Report to Captain Renn."
    objective:
      kind: talk
      target_template: guard_captain
    on_complete: done
rewards:
  - gold: 20
  - xp: 60
  - item: leather_cap              # optional — item base id
```

---

## Stages

Every stage has `id`, `text`, and optionally `on_complete` and `objective`.

- **No `objective`** — stage is auto-completed by clicking the giver (a "talk to
  return" step). The server drives this; no extra field needed.
- **`on_complete: done`** — quest ends; rewards are granted. Must be present on
  the last stage (or the quest hangs).
- `on_complete` must reference a valid stage id or `"done"` — the loader validates
  the graph and throws on a dangling reference.

---

## Objective kinds (`QuestObjective`, `shared/types.ts`)

### `kill_count`
```yaml
objective:
  kind: kill_count
  target: 6            # how many kills required
  template_id: rat     # optional — only kills of this mob type count
  zone: zone_41_41_sewer  # optional — only kills in this zone count
```

### `kill_specific`
```yaml
objective:
  kind: kill_specific
  target_id: rat_king  # spawn_id of the specific entity (not template_id)
```
Requires the boss/elite mob to have `spawn_id` set in its zone spawn entry.

### `collect_count`
```yaml
objective:
  kind: collect_count
  item_base: gold_coin   # item base id (world/entities/items/bases/)
  target: 3              # number to collect
```

### `talk`
```yaml
objective:
  kind: talk
  target_template: guard_captain  # mob template id to talk to
```

### `reach`
```yaml
# Reach within radius of a mob:
objective:
  kind: reach
  template_id: shore_camp_marker
  zone: zone_41_40
  radius: 3

# Reach a fixed coordinate:
objective:
  kind: reach
  zone: the_old_stones
  x: 27
  y: 6
  radius: 4

# Reach a zone (zone-entry trigger):
objective:
  kind: reach
  zone: zone_40_39_crypt
  radius: 0
```
At least one of `template_id`, `x+y` pair, or `zone` is required.

---

## Chaining quests (questlines)

```yaml
# Quest 2 — only available after quest 1 is done
id: the_ash_shore
unlock_after: coastal_search   # single prerequisite

# OR multiple prerequisites (ALL must complete):
unlock_after: [scout_missing, coastal_search]
```

Each chained quest is a separate file. The giver can be in any zone — chains
naturally span zones. Keep ids consistent (`the_ash_shore` in one file,
`coastal_search` in another).

---

## Giver: template id vs. spawn_id

| `giver` value | which mob answers the quest |
|---|---|
| `merchant` | **any** mob with template `merchant` in any zone |
| `market_merchant` | only the mob whose `spawn_id: "market_merchant"` in a zone's spawns array |

Use spawn_id when the questline belongs to a **specific named NPC** so that a
second copy of the same template in another zone can't incorrectly offer it.

To assign a spawn_id, add it to the mob's spawn entry in the zone:
```jsonc
// world/zones/village_41_41.json
"spawns": [
  { "entity": "merchant", "at": { "x": 67, "y": 70 }, "spawn_id": "market_merchant" }
]
```

---

## Rewards

```yaml
rewards:
  - gold: 40          # gold coins
  - xp: 80            # experience points
  - item: leather_cap # item base id; one copy is added to inventory
```

Any combination or subset is valid. The loader accepts zero rewards (omit the key
entirely for truly unrewarded tasks).

---

## Cross-zone questlines: what to check

For a questline spanning multiple zones, verify each zone and giver before writing:

1. **Does the giver mob exist?** Check `world/entities/mobs/<id>.yaml`. If not,
   create it with `/new-mob` first.
2. **Is the giver spawned in the right zone?** Check the zone's `spawns` array.
   If not, add a spawn entry.
3. **Does the target zone exist?** For objectives referencing a zone (kill in zone,
   reach zone, reach coordinate in zone) check `world/zones/<zone_id>.json` exists.
   If not, create it with `/new-zone` first.
4. **Does the item base exist (for collect_count)?** Check
   `world/entities/items/bases/`. If not, the objective silently never completes.
5. **Does the target template exist (for kill_count/talk)?** Check mob template id.

---

## Steps

1. **Pin down** the questline shape: number of quests in the chain, giver(s), zone(s)
   involved, objectives per stage, and rewards. State these as assumptions.

2. **Check prerequisites** — for each giver mob and zone referenced, verify they
   exist in `world/entities/mobs/` and `world/zones/`. If missing, use `/new-mob`
   or `/new-zone` to create them first, then return here.

3. **Write each quest YAML** in `world/quests/<id>.yaml`. For a chain, write them
   in order (Q1, Q2, …) and add `unlock_after` to every quest after the first.

4. **Validate** — typecheck and load the world:
   ```bash
   npx tsc --noEmit -p .
   node --input-type=module -e "
   import { loadWorld } from './server/world/loader.ts';
   const w = loadWorld('world');
   const q = w.quests['<quest_id>'];
   if (!q) throw new Error('quest not loaded');
   console.log('loaded quest', q.id, 'stages:', q.stages?.length, 'giver:', q.giver);
   "
   ```
   A bad `on_complete` reference, invalid objective, or duplicate stage id throws
   here. A missing quest means the file wasn't picked up (wrong dir or extension).

5. **Report** each quest id, its giver, zone, stage count, objective kinds used,
   and how the chain links (`unlock_after`). Note any new mobs or zones that were
   created as part of this questline.
