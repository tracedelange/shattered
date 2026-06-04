# TODO

Areas for future expansion. Not a backlog — directional notes for where the
codebase wants to grow next.


### Trace Callout Functional Features:
 - [ ] Penalty for killing innocents (e.g. villagers, merchants) that reduces faction standing and/or causes guards to attack on sight.
 - [x] Better quest marker handling: Question mark for quest return or next step, notification / banner when quest is completed, on screen quest log with active quests and objectives.
 - [x] Some quests that are supposed to be serially available are currently all available at once. Add gating logic to ensure they unlock in the intended order.
 - [x] Add a "repeatable" flag to quests that can be done multiple times, and ensure the quest system handles this correctly.
 - [x] Add a item collection quest type that requires the player to gather specific items, either from the world or as drops from mobs, and turn them in to an NPC.
 - [x] Add an actual merchant system to sell extra drops
 - [x] Add basic purchasable items like basic potions from merchants to give a use for gold and a reason to engage with the economy.
 - [x] Adjust spawn rate of mobs. The current spawn rate is pretty high and makes the world feel more crowded. 
 - [X] Adjust region generation pipeline to actually render and consider the layout of the area to better refine the placement and density of mobs, resources, and points of interest.
 - [X] Make the movement system less clunky, click and walk right now is slow and doesn't feel good. Consider pathfinding, or at least a more responsive movement system.
 - [X] Move click-to-move pathfinding + execution to the server. Client sends a single `autopath` event with target tile; server runs A* and advances one step per game tick; client renders authoritative position. Current client-side path execution breaks down under network latency (120ms client tick vs 100ms server tick causes jitter/desync). Client-side prediction can be layered on top later if movement feel suffers.
 - [x] Make some mobs more aggressive and add some passive mobs. 
 - [X] Adjust the region preview render to call out inaccessible areas, and maybe add a heatmap of mob density.
 - [x] Need a window that shows all the active players on the server
 - [x] Need some chat channels that are global, and PMs between players
 - [x] Character customization, even just changing colors of blob for now.  
 - [x] More types of items. Need some generalized handling for consumables and specials. Thinking we might want some kind of item that shows the changelog from the implementor. In universe lore item that gives the player notes on what's changed in the world.
 - [x] A larger pool of potential loot. Some kind of procedurally generated loot with affixes and item types would be ideal, but even just a larger pool of static items would be a good start.
 - [x] Item rarity scale. Common, uncommon, rare, legendary, etc. with different colors and drop rates.
 - [ ] A more robust combat system. 


 NEW DEV SESSION:
  - [x] Non-hostile mobs should defend themselves if attacked, but not attack the player on sight.
  - [x] **Mob stat parity with players.** Mobs currently have HP and damage only. They should have the same stat
        block as players: strength, dexterity, intelligence, constitution. Constitution drives max HP (same formula
        as players: 100 + (con-5)*10, scaled by role). Strength drives melee damage bonus (same SCALING_COEFFS).
        Dexterity drives dodge chance (same dodgeChance() formula). The role system sets base stat values at a
        given level, and individual mobs can override them via explicit stats in YAML. Defense should be derived
        from constitution or a flat armor value on the mob template (no equipment slots needed). Health regen
        should tick on the server the same way player regen works — slow out-of-combat recovery. The combat
        system (resolveAttack, dodgeChance, totalDefense) already reads from components.stats for players; extend
        it to read mob stats the same way so no parallel code path is needed.
  - [x] We should have some hotbar that shows the players available skills + consumable items. Let's start it simple and have a slot for the basic attack function and a slot for consuming a potion with an arbitrary effect. Cooldowns on both with visual indicators. 
  - [ ] Add a "damage type" to weapons (slash, pierce, blunt) and have mobs have different resistances/vulnerabilities to these types. This would be a good first step towards more interesting combat depth without needing to build out the full spell / status effect system.
  - [x] BUG: When we try to switch characters, nothing happens. We might want to make character switching only available from the main menu and allow for a logout. 

---

## Roadmap

### Combat & Classes
- **Damage types.** Slash / pierce / blunt on weapons; per-mob resistance/vulnerability table. First step toward elemental (fire, cold, arcane, holy) — affixes and status effects hang off this naturally.
- **Status effects.** Bleed, burn, slow, poison — short-duration components on targets. Many affix ideas and active skills require these to exist first.
- **Active skills.** Class-bound hotkey abilities: power attack (fighter), backstab (rogue), firebolt (wizard). YAML-defined with costs, cooldowns, and class gates. The hotbar has an empty slot waiting.
- **Weapon speed integration.** `rolled.speed` from weapon bases already exists but isn't wired into the player attack cooldown. Once weapon speed is properly applied to `stats.speed`, the server formula (`PLAYER_BASE_ACT_TICKS / speed`) is already in place.
- **Bows + projectiles.** Ranged combat needs a projectile entity with tick-step trajectory, line-of-sight checks, and range falloff.
- **Parry / block / dodge actions.** A defensive verb for each class to complement the single attack verb. Pairs with stamina or a short cooldown.

### Progression & Economy
- **Weapon proficiency.** Stats that grow with use of a weapon class, unlocking small passive bonuses. Gives weapon choice long-term weight.
- **Passive skill trees.** Branching trees of small modifiers (+5% melee damage, +1 HP regen) purchased with a currency separate from stat points.
- **Faction reputation.** A per-faction standing score (Wardens Guild, goblin warbands, shard cults) that gates dialogue options, vendor inventory, and zone aggression. Hooks the lore bible directly into mechanics.
- **Shard-god boons.** Pledging to a shard god grants a thematic bonus and a thematic cost. Builds the cosmology through play.
- **Gold sinks beyond shops.** Repair costs, fast-travel fees, skill respec, faction donations. The gold loop needs outflows to matter.
- **Salvage / crafting.** Break unwanted items into components; recombine into new gear or affix re-rolls. Gives unused drops a purpose.
- **Unique & set items.** Named hand-authored uniques with fixed affixes and lore text. Set bonuses at 2/4/6-piece worn. YAML-defined.

### World & Content
- **Real sprites.** Tiles and entities still render as flat colors. The tileset JSON already maps names to draw data — this is a renderer swap, not a data change.
- **Dedicated `tree` tile.** Currently using `wall` as placeholder in dark_forest. Needs its own impassable tile type with distinct rendering.
- **Day / night cycle.** A global clock tick that shifts ambient lighting and gates certain spawns. Cheap server-side; renderer can tint.
- **Interactable entities.** Doors, levers, chests with loot tables, bonfires as checkpoints, prayer altars. Generalize as `interactable` components on entities.
- **Branching dialogue.** NPCs currently have flat chatter arrays. Add interactive dialogue with branching nodes, persistent flags, and quest-dispatch slots. YAML-defined.
- **NPC schedules.** Time-of-day routines (sleep, work, drink) so NPCs aren't statues. Pairs with day/night.
- **More mob variety.** Goblins dominate every zone. A few more template types with distinct stat/behavior profiles would make zones feel different.
- **Notice boards.** A non-NPC interactable that surfaces available quests for the player's level and faction standing.
- **Smarter mapgen.** A* road routing that avoids walls/water, Perlin/Voronoi noise for rivers and biome boundaries, zone-level default seed for one-integer rerolls.

### Client / UX
- **Minimap.** Useful for larger, non-rectangular zones. Could be a small canvas overlay in a corner.
- **Better death feedback.** The two-second red fade should show "Killed by X" and a respawn countdown.
- **Lore reader.** An in-game journal that surfaces zone descriptions, factions, and cosmology as the player discovers them. Pulls from the YAML directly.
- **Touch / mobile controls.** Currently keyboard-only. A tap-to-move + on-screen hotbar would open up phone play.

### Infrastructure & Tech Debt
- **Tests.** Zero coverage. Mapgen primitives, combat formulas, and the pipeline's `mergeLore` / `splitLoreHeader` helpers are all pure functions — easy deterministic targets.
- **Hot-reload for entity defs.** The file watcher currently only rebuilds on zone changes. Mob template and item base edits should also trigger a world rebuild.
- **Persistence gaps.** Mob HP/position and ground items both reset on server reboot. Decide whether to snapshot on shutdown or document as intentional.
- **Stat access cleanup.** `progress.ts` and `combat.ts` use `as Record<string, unknown>` casts to read stats by string key. A typed `Stats[stat]` accessor pattern would close this.
- **Pipeline improvements.** Implementer schema validation before writing YAML; diff-preview mode; specialized prompts per opportunity type (`new_zone` vs `add_entity`); lore-drift detection as a Gardener-only pass.
