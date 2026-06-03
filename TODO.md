# TODO

Areas for future expansion. Not a backlog — directional notes for where the
codebase wants to grow next.

## World / mapgen

- **Real sprites.** Tiles + entities still render as flat colors. Swap in a
  proper tile sheet; the tileset JSON already maps names to draw data, so this
  is a renderer change without touching world data.
- **Trees.** Currently using `wall` as a tree placeholder in dark_forest. Add
  a dedicated `tree` tile (impassable, distinct color/sprite).
- **More shape primitives.** `arc` / `curve` for non-rectilinear paths, and
  `donut` / `ring` for things like walled gardens.
- **Smarter roads.** A* routing that avoids walls + water + existing buildings,
  instead of straight Bresenham. Optional `width` falloff so roads taper.
- **More noise types.** Currently only seeded value noise. Adding Perlin /
  Voronoi unlocks rivers, biome boundaries, cave systems.
- **Zone-level default seed.** Single `seed:` field at zone root that all
  noise ops fall back to, so a single integer reroll changes the whole zone.
- **Day/night + weather.** A global clock tick that shifts ambient lighting
  and gates certain spawns. Cheap to add server-side; renderer can tint.

## Interaction modes

The world currently supports: walk, attack, pick up, equip, allocate a stat.
That's it. Everything else here is unexplored surface area.

- **Examine.** A `look` action that surfaces lore: zone description, NPC
  flavor, item provenance ("a rusted Warden's sigil is etched into the
  pommel"). Hooks naturally into the lore bible.
- **Talk / dialogue trees.** Today NPCs only have a flat `dialogue` chatter
  array. Add interactive dialogue with branching nodes, persistent flags,
  and quest-dispatch slots. YAML-defined.
- **Use / interact with environment.** Doors that open, levers, chests with
  loot tables, prayer altars (shard-god flavor), bonfires that act as
  checkpoints. Generalize as `interactable` entity components.
- **Channeling / cast actions.** A second action slot besides "attack" for
  spells, prayers, lockpicks, throw-items. Wires up with the wizard work.
- **Stealth / detection.** Rogue identity is currently just Dex scaling.
  Hidden movement when out of an enemy's vision cone unlocks ambushes,
  scouting, and a real reason to play rogue.
- **Trade.** A two-pane exchange UI between player and NPC (or eventually
  player ↔ player). Closes the gold loop the merchant gestures at today.

## Loot & item generation

- **Functional affixes.** Affix system rolls onto items but bonuses are
  currently raw additive (damage range). Wire up named effects: "Flaming"
  adds fire damage, "of the Bear" adds Str, "of Whispers" reduces detection.
- **Rarity tiers.** Common / uncommon / rare / unique with different affix
  budgets and visual treatment. Color the inventory cell border by rarity.
- **Unique items.** Named, hand-authored items with fixed affixes and lore
  text. The bible already gestures at named artifacts of the Shattering —
  these are the natural home for those. YAML-defined in `entities/items/unique/`.
- **Set items.** Multi-piece gear that grants bonuses at 2/4/6-piece worn.
  Cheap to express in YAML, high impact on build identity.
- **Loot tables on containers, not just mobs.** Chests, sacks, dredge piles.
  Reuses the existing `loot_table` shape.
- **Drop rate tuning + magic find.** A single `luck` stat (or affix) that
  shifts loot-table rolls toward better tiers.
- **Salvage / crafting.** Break low-tier items into components, combine into
  new gear or affix re-rolls. Gives unused drops a purpose.
- **Identification.** Optional unidentified state for rare items — gates
  affix reveal behind a scroll, an NPC, or a skill check.

## Weapons & combat depth

- **Wizard staves + spells.** Int scaling infrastructure exists; the next step
  is `kind: spell` weapons and a separate cast action, or just staves that
  scale damage with Int and reuse the existing attack flow.
- **Weapon types matter.** Different `kind:` on a weapon (sword/axe/dagger/
  bow/staff) should map to different attack patterns: range, swing arc,
  windup, special. Today it's all generic melee.
- **Bows + projectiles.** Real ranged combat means a projectile entity with
  a tick-step trajectory, line-of-sight checks, and falloff.
- **Damage types.** Physical / fire / cold / arcane / holy, with per-mob
  resistances and weaknesses. Affixes hang off this naturally.
- **Status effects.** Bleed, burn, slow, stagger, poison — short-duration
  components on the target. Many affixes and skills hinge on these existing.
- **Parries, dodges, blocks.** A defensive action that costs stamina or has
  a cooldown. Pairs with the rogue stealth / wizard cast model — three
  classes, three combat verbs.
- **Equipment requirements.** Currently no class gates on gear. Decide whether
  to add stat requirements (Souls-style) or keep it open.

## Skills & progression

Right now level-up only grants a stat point. Skill-tree work is the natural
next progression layer.

- **Active skills.** Class-bound abilities slotted to a hotkey — power
  attack (fighter), backstab (rogue), firebolt (wizard). YAML-defined with
  costs, cooldowns, and per-class gates.
- **Passive trees.** Branching trees of small modifiers (+5% melee damage,
  +1 health regen) spent with a separate currency from stat points.
- **Weapon proficiency.** Hidden stat that grows with use of a weapon class,
  unlocking small bonuses. Pairs with weapon-type combat work.
- **Crafting / utility skills.** Cooking, alchemy, smithing as non-combat
  progression with their own XP tracks. Sinks for harvested materials.
- **Reputation with factions.** A standing score per faction (Wardens Guild,
  goblin warbands, eventual shard cults) that gates dialogue, vendor
  inventory, and zone aggression. Hooks the lore bible directly into mechanics.
- **Shard-god boons.** Lore-flavored progression: pledging to a shard god
  grants a thematic bonus and a thematic cost. Builds out the cosmology
  through play.

## NPCs & quests

- **Make the quest stub real.** `server/game/systems/quests.ts` reads/writes
  flags but no quest YAMLs trigger anything. Wire up `talk`, `kill`, `reach`
  triggers so the existing flag store actually advances quest state.
- **Quest dispatch from notice boards.** A non-NPC interactable that
  surfaces available quests for the player's level / standing. Generalizes
  what merchant-as-questgiver does today.
- **NPC schedules.** A simple time-of-day routine (sleeps, works, drinks)
  so NPCs aren't statues. Pairs with day/night.
- **Real monster variety.** Goblins are the only mob. Add a few more with
  distinct stats + behavior to make zones feel different.

## Economy

- **Merchant shop loop.** Tavern merchant exists as a static NPC. Wire up a
  buy/sell UI, set base prices in item bases, give gold its first sink.
- **Sinks beyond shops.** Repair costs, fast travel fees, skill respec,
  faction donations. The gold loop is broken without sinks.

## Pipeline (Gardener / Implementer)

- **Implementer schema validation.** Today the Implementer trusts the LLM's
  YAML. Run the resulting zone through the loader's schema before writing
  to catch broken `relative_to` references, missing tiles, bad portal coords.
- **Diff preview mode.** A pre-write step that prints colored diffs for
  every modified file. Easier than `--dry-run` plus eyeballing.
- **Approval workflow.** Honor `status: approved` consistently across both
  pipelines and add a `--prompt` for the Implementer too ("build this but
  make it bigger / darker / Warden-controlled").
- **Specialized prompts per opportunity type.** `new_zone` and `add_entity`
  want different system prompts and different example sets. Today both
  share one prompt.
- **Lore-bible drift detection.** Periodic Gardener run that ONLY checks
  for contradictions between zones, entities, and the bible. Output as
  `refactor_lore` opportunities.
- **History-aware Gardener.** Feed implemented-opportunity outcomes back
  into the next Gardener run so it learns what kinds of proposals tend to
  produce good zones vs. broken ones.

## Persistence

- **Mob state survives restart.** Right now mobs respawn fresh on server
  reboot. Decide if this matters; if so, snapshot mob HP/position on shutdown.
- **Ground items persist.** Same — dropped items vanish on reboot.
- **Player flags / quest state.** Quest progress and dialogue flags need to
  survive both reboot and reconnect.

## Tech debt

- **Tests.** Zero test coverage. Mapgen primitives + RNG are pure and would
  be easy first targets (deterministic in, deterministic out). Combat damage
  formulas + scaling letters are another good fit. The pipeline's
  `mergeLore` / `splitLoreHeader` helpers are also pure and easy to cover.
- **Cast-heavy stats access.** `progress.ts` and `combat.ts` use
  `as Record<string, unknown>` to read stats by string key. A keyed
  `Stats[stat]` access pattern would clean this up.
- **Hot-reload covers zones only.** Editing a mob template or item base
  doesn't trigger world rebuild. Extend the watcher to handle entity defs,
  and ideally the lore bible too (so the Gardener's writes hot-reload).

## Client / UX

- **Touch / mobile controls.** Currently keyboard-only. Phones can't play.
- **Better death overlay.** Two-second red fade isn't enough feedback. Show
  "killed by X", maybe a respawn countdown.
- **Minimap.** Useful for the new larger / non-rectangular zones.
- **Lore reader.** An in-game journal that surfaces the bible's geography,
  factions, and cosmology as the player discovers them. Pulls directly from
  the YAML; no duplication.



### Trace Callout Functional Features:
 - [ ] Penalty for killing innocents (e.g. villagers, merchants) that reduces faction standing and/or causes guards to attack on sight.
 - [x] Better quest marker handling: Question mark for quest return or next step, notification / banner when quest is completed, on screen quest log with active quests and objectives.
 - [x] Some quests that are supposed to be serially available are currently all available at once. Add gating logic to ensure they unlock in the intended order.
 - [x] Add a "repeatable" flag to quests that can be done multiple times, and ensure the quest system handles this correctly.
 - [x] Add a item collection quest type that requires the player to gather specific items, either from the world or as drops from mobs, and turn them in to an NPC.
 - [x] Add an actual merchant system to sell extra drops
 - [x] Add basic purchasable items like basic potions from merchants to give a use for gold and a reason to engage with the economy.
 - [x] Adjust spawn rate of mobs. The current spawn rate is pretty high and makes the world feel more crowded. 
 - [ ] Adjust region generation pipeline to actually render and consider the layout of the area to better refine the placement and density of mobs, resources, and points of interest.
 - [ ] Make the movement system less clunky, click and walk right now is slow and doesn't feel good. Consider pathfinding, or at least a more responsive movement system.
 - [ ] Move click-to-move pathfinding + execution to the server. Client sends a single `autopath` event with target tile; server runs A* and advances one step per game tick; client renders authoritative position. Current client-side path execution breaks down under network latency (120ms client tick vs 100ms server tick causes jitter/desync). Client-side prediction can be layered on top later if movement feel suffers.
 - [x] Make some mobs more aggressive and add some passive mobs. 
 - [ ] Adjust the region preview render to call out inaccessible areas, and maybe add a heatmap of mob density.
 - [x] Need a window that shows all the active players on the server
 - [ ] Need some chat channels that are global, and PMs between players
 - [x] Character customization, even just changing colors of blob for now.  
 - [ ] More types of items. Need some generalized handling for consumables and specials. Thinking we might want some kind of item that shows the changelog from the implementor. In universe lore item that gives the player notes on what's changed in the world.
 - [ ] A larger pool of potential loot. Some kind of procedurally generated loot with affixes and item types would be ideal, but even just a larger pool of static items would be a good start.
 - [x] Item rarity scale. Common, uncommon, rare, legendary, etc. with different colors and drop rates.
 - [ ] A more robust combat system. 