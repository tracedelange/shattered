# shattered

A small browser MMO. The world is defined in YAML, mutated by an LLM-driven
content pipeline, and served by a TypeScript socket.io backend to a Vite +
canvas client.

## Running

```bash
npm install
npm run dev          # server (tsx watch) + client (vite) in parallel
```

Open http://localhost:5173.

## Layout

```
shared/         types shared between server and client
server/         socket.io game server, world loader, hot-reload watcher
client/         vite + canvas client
world/          YAML world definitions (zones, mobs, items, quests, lore)
pipeline/       Gardener + Implementer (LLM-driven world evolution)
```

Zones are deterministic — each is a list of generation ops (regions, roads,
noise patches) that rebuild the tile grid on load. The watcher reloads zones
in-place when their YAML changes, so editing a file or running the
Implementer takes effect without a server restart.

## The Gardener and Implementer

Two CLI pipelines for evolving the world.

```bash
npm run gardener                                # broad sweep
npm run gardener -- --prompt "<focus>"          # focused investigation
npm run implementer                             # build top pending opportunity
npm run implementer -- --opportunity opp_004    # build a specific one
npm run implementer -- --dry-run                # show what would change
```

Both shell out to `claude --print`, so auth piggybacks on whatever Claude
Code is logged into — no separate API key. See `docs/gardener-v1.md` for the
design.

The Gardener reads the world and writes `world/pipeline/opportunities.yaml`
— a prioritized list of proposals (new zones, refactors, quests, entities).
The Implementer picks the top pending opportunity, builds it as YAML diffs,
and updates the lore bible and history. The handoff between them is a
human-readable YAML file: you can edit priorities, set `status: blocked`,
or write opportunities by hand.

## What's there now

- Three TypeScript classes (fighter, rogue, wizard) with stat scaling,
  affix-rolled gear, an armor system, and stat allocation on level-up.
- Four zones (`firdale`, `tavern`, `dark_forest`, `river_crossing`) plus
  a lore bible that grounds the setting (the Shattering, the Gardener,
  shard gods).
- A quest stub, a static merchant, hot-reloading zones.
- A working content pipeline with one implemented opportunity to date.

## What's next

`TODO.md` is the canonical list of directional notes for expansion —
combat depth, loot systems, NPC interaction, persistence, etc.
