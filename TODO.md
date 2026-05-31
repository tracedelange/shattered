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
- **More zones.** `river_crossing` is referenced from starting_village but
  doesn't exist yet. General need for a content pipeline.

## Combat / progression

- **Wizard staves + spells.** Int scaling infrastructure exists; the next step
  is `kind: spell` weapons and a separate cast action, or just staves that
  scale damage with Int and reuse the existing attack flow.
- **Functional affixes.** Affix system rolls onto items but bonuses are
  currently raw additive (damage range). Wire up named effects: "Flaming"
  adds fire damage, "of the Bear" adds Str, etc.
- **Real monster variety.** Goblins are the only mob. Add a few more with
  distinct stats + behavior to make zones feel different.
- **Equipment requirements.** Currently no class gates on gear. Decide whether
  to add stat requirements (Souls-style) or keep it open.

## Economy / NPCs

- **Merchant shop loop.** Tavern merchant exists as a static NPC. Wire up a
  buy/sell UI, set base prices in item bases, give gold its first sink.
- **NPC dialogue trees.** Today NPCs only have a flat `dialogue` chatter
  array. Add interactive dialogue (talk to merchant, talk to questgiver).

## Quests

- **Make the stub real.** `server/game/systems/quests.ts` reads/writes flags
  but no quest YAMLs trigger anything. Wire up `talk`, `kill`, `reach`
  triggers so the existing flag store actually advances quest state.

## Persistence

- **Mob state survives restart.** Right now mobs respawn fresh on server
  reboot. Decide if this matters; if so, snapshot mob HP/position on shutdown.
- **Ground items persist.** Same — dropped items vanish on reboot.

## Tech debt

- **Tests.** Zero test coverage. Mapgen primitives + RNG are pure and would
  be easy first targets (deterministic in, deterministic out). Combat damage
  formulas + scaling letters are another good fit.
- **Cast-heavy stats access.** `progress.ts` and `combat.ts` use
  `as Record<string, unknown>` to read stats by string key. A keyed
  `Stats[stat]` access pattern would clean this up.
- **Hot-reload covers zones only.** Editing a mob template or item base
  doesn't trigger world rebuild. Extend the watcher to handle entity defs.

## Client / UX

- **Touch / mobile controls.** Currently keyboard-only. Phones can't play.
- **Better death overlay.** Two-second red fade isn't enough feedback. Show
  "killed by X", maybe a respawn countdown.
- **Minimap.** Useful for the new larger / non-rectangular zones.
