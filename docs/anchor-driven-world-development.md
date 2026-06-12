# Anchor-Driven World Development

## Intent

The world generator outputs a large grid of biome-assigned, seeded zone stubs. The
tile layout for each stub is resolved at load time by the biome pipeline, so the
physical world already exists. What doesn't exist yet is *authored content*: mob
tables, NPCs, quests, lore, and flavor that make zones feel inhabited.

The goal is not to fill every zone before players can play. Instead, we build out
content in focused regional bursts, starting from a chosen settlement, expanding
outward as needed, and leaving distant wilderness sparse in the short term. This
mirrors how a tabletop game world gets developed — the area the players are in right
now is detailed; the horizon is vague.

## The Anchor Workflow

1. **Choose a starting village.** Pick one village or city zone from `world/zones/` to
   serve as the first player settlement. Any `village_*` or `city_*` zone works. It
   starts with nothing but a biome seed — that's the blank canvas.

2. **Run the gardener in anchor mode.** This limits the gardener's zone context and
   opportunity scope to a BFS neighborhood around the anchor:

   ```
   npx tsx pipeline/gardener.ts --anchor village_12_32 --radius 3
   ```

   The gardener receives only the anchor zone and its 3-step neighbors as context,
   and is instructed to generate opportunities for that region only. This keeps
   LLM calls focused and token-efficient.

3. **Run the implementer as usual.** The implementer picks the top pending
   opportunity and builds it out. Iterate: gardener → implementer → gardener → …
   until the region reaches a playable threshold.

4. **Advance to a new region.** Once the anchor region feels solid (a quest chain,
   populated wilderness, at least one NPC hub), run the gardener in anchor mode on
   a second settlement to bootstrap the next area, then repeat.

## Zone Stub Contents

After a world-gen export, each stub JSON contains:

| Field | Source | Notes |
|---|---|---|
| `id` | worldgen | Encodes type and grid position (`village_12_32`, `zone_10_10`) |
| `biome` | worldgen | Drives tile generation at load time |
| `seed` | worldgen | `<world_seed>_<x>_<y>` — deterministic tile layout |
| `level_band` | worldgen | `{ tier, minLevel, maxLevel }` — danger from elevation map |
| `connections` | worldgen | Cardinal neighbors (BFS-navigable) |
| `tags` / `features` | worldgen | Beach adjacency tags where applicable |
| `modifier` | worldgen | Settlement modifier (e.g. `hidden`) if present |

The `level_band` is the primary signal the gardener uses to choose appropriate mob
difficulty and quest stakes for each zone.

## Pipeline Architecture Summary

```
World Generator (tools/world-gen/)
  └─ exports stub JSONs to world/zones/
        ↓
Server Loader (server/world/loader.ts)
  └─ resolveBiomeOps(): derives tile ops from biome at load time
        ↓
Gardener (pipeline/gardener.ts)
  ├─ broad sweep:  all zones, broad opportunity finding
  ├─ anchor mode:  BFS neighborhood, region bootstrap
  ├─ focus mode:   all zones, specific concern
  └─ audit mode:   single zone, visual render review
        ↓
opportunities.yaml
        ↓
Implementer (pipeline/implementer.ts)
  └─ calls LLM to build out one opportunity per run
        ↓
world/zones/*.yaml, world/entities/mobs/*.yaml, world/quests/*.yaml
```

## Gardener Modes Reference

| Mode | Flag | Zone context | Use when |
|---|---|---|---|
| Broad | _(none)_ | All zones | Periodic world health sweep |
| Anchor | `--anchor <id> [--radius <n>]` | BFS neighborhood (default r=3) | Bootstrapping a new region |
| Focus | `--prompt "<concern>"` | All zones | Targeted authoring pass |
| Audit | `--audit <zone_id>` | All zones + PNG render | Zone looks visually broken |

## Development Rhythm (Recommended)

- **Anchor pass** to seed 5–10 opportunities for a new region.
- **Implement 3–5 opportunities** (one per implementer run) until the village has
  an NPC, a quest, and wilderness mobs.
- **Focus pass** if a specific gap remains ("the forest ring feels empty").
- **Broad pass** occasionally to catch global coherence drift.
- **Advance anchor** to the next settlement once players can meaningfully engage
  with the current region.

## Open Items

- **Beach tags** for ocean-proximate zones are computed in the exporter but not
  yet wired into any biome feature pipeline. Address in a separate session.
- **City zones** currently use `biome: village` in stubs. The zone ID encodes the
  type (`city_*` vs `village_*`), but an explicit `settlement_type` field would
  make it easier for the gardener to generate city-scale content (guilds, markets,
  multi-NPC hubs).
- **Region threshold definition.** "Playable threshold" is currently informal —
  eventually this could be a checklist the gardener can evaluate: ≥1 quest giver,
  ≥1 mob table, ≥1 merchant, connections to adjacent zones all traversable.
