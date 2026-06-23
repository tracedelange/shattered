# Iterative organic world growth

Status: design / implementation plan (not yet built)
Supersedes the "fill a fixed graph top-down" assumption of `docs/v2-top-down-generation.md` while reusing its machinery (closed-vocab grammar, deterministic Tier 3).

## The reframing

Today the zone graph is a **fixed input** the forge fills in one batch. The iterative
model makes it a **persistent, append-only artifact the forge both reads and extends**.
A "grow" step designs one intentional, themed **region** (~5–8 zones) that attaches to the
existing world at a frontier **seam**, seeded by the world that already exists. Run it N times
→ the world grows region by region, walkable at every step.

The growth unit is a *region*, not a single zone — each step adds a coherent themed area
with purpose (a motif, an internal structure, a quest beat), not one more tile in a ring.

A free win falls out: **growth order is the difficulty gradient.** Origin (the village)
is L1–5; each new region's bands start near its seam zone's band and ramp up through the
region. Bands come from distance-from-origin, not a Perlin macro — which structurally fixes
the scrambled-band problem (e.g. `zone_1_1` landing at tier 5).

## The central tension: novelty vs. correctness-by-construction

Deterministic Tier 3 + a frozen grammar is what made generation correct (real sprites,
in-band levels, valid quests, no biome-wrong features). It is *also* what bounds variety:
everything is a recombination of frozen pieces. We want **unique, varied growth — not boxes
popping up in a ring** — WITHOUT reintroducing the per-instance whack-a-mole we just escaped.

**Resolution: two clocks.**

- **Grow (fast clock, every step):** recombine the *existing* library deterministically
  into a new arc. Cheap, correct — what we have today.
- **Invent (slow clock, occasionally / on demand):** an LLM "inventor" mints **new library
  entries** — archetypes, factions, prefabs, optionally sprites — *validated once against the
  engine's primitives, then FROZEN into the library*. Subsequent grow steps recombine the
  now-larger vocabulary.

Novelty enters the **library**, not the **instance**. The inventor's output is validated and
frozen exactly like the seed grammar, so instancing stays deterministic and we never
re-open the whack-a-mole loop. The world feels new because its *vocabulary* grows.

## Which level to bake novelty in

| Level | Lever for uniqueness | Risk | Verdict |
|---|---|---|---|
| **Instance** (Tier 3) | per-mob/zone LLM emission | high — re-breaks correctness | **No.** Keep deterministic. |
| **Grammar** (archetype / faction) | inventor mints new chassis + themes | low — data, validated once | **Yes — primary novelty source.** |
| **Structure** (prefab / arc-shape / layout archetype) | new prefabs, branching arcs, varied zone layouts | medium — schemas already exist | **Yes — this is what kills "boxes in a ring."** |
| **Asset** (sprite atlas) | mint a new sprite id + procedural color | low–med | **Optional** — cheap visual distinctness. |
| **Engine mechanics** (new ability / objective kinds) | new code (codegen) | high | **Later** — out of scope. |

Headline: **novelty = a growing library + structural variety; instancing stays deterministic.**
"Not boxes in a ring" comes from two places working together — varied *threats/themes* (new
grammar) and varied *shape/structure* (arc layout + prefabs).

## The persistent world state (the substrate)

A durable, growing world dir (promote from `forge/runs/<id>/world`, or a dedicated
`world-grown/`). It accumulates and is read back each step:

- `graph.json` — the zone graph, append-only (the growable artifact).
- `blueprint.json` — cumulative storyline + lore + per-region records (Tier-1 state / "story so far").
- `grammar/{archetypes,factions}.yaml` — the **living** library (grows via the inventor; frozen *per step*).
- `prefabs/`, `entities/`, `zones/`, `quests/` — forged content, accumulating.

"Feed the output back in" = the next grow step loads this state as its context.

## The two new core pieces (where the real design is)

### 1. Region synthesis primitive (deterministic graph-building from a region spec)
Given the current graph and a region spec from Tier 1 (below), lay out the region's ~5–8 new
zone nodes and stitch them to the existing world at the chosen **seam** zone. Per node:
coord-derived id placed beyond the seam, biome (from the spec), `level_band` (ramps from the
seam zone's band up through the region), internal links + one link across the seam, terrain features.

The region is **not a straight ring** — it carries internal structure from the spec
(e.g. `approach → gatehouse → dungeon (+ side: treasure vault / dead-end shrine)`). Shape and
biome mix come from Tier 1 for variety, within a validated set of structural primitives.

### 2. Tier-1 region proposal (the LLM "feed-back")
Tier 1 in grow mode is no longer "design the whole world." It receives the **story-so-far**
(cumulative storyline + lore), the **current frontier** (the open-edge zones with their
lore/faction/band/biome), and the **available library**. It **proposes the next region from
the story** (the user approves or regenerates) — a region spec:

- the region's purpose / motif + a lore-continuation paragraph (appended to `blueprint.json`),
- which frontier zone it seams to (chosen from story logic; user may override),
- ~5–8 zones with their biomes, roles (approach / gate / dungeon / reward), and internal shape,
- which faction(s) field the threats — **existing** library entries,
- the region's quest beat.

(Inventor is manual-only to start — see Phase 3. When enabled, a spec requesting an uncovered
theme/faction will trigger it before Tier 2/3.)

### 3. The inventor tier (slow clock — where novelty is born)
Input: a theme request from Tier 1 + the engine primitives (MOB_ROLES, ability catalog,
sprite atlas, item tags, feature registry). Output (each **validated then frozen** into the library):

- new **archetypes** — validated against `MOB_BODY` + ability catalog + sprite atlas,
- a new **faction** — validated against grammar invariants (`validateGrammar`),
- optional new **prefabs** — validated against the prefab schema + tile vocab,
- optional new **sprite atlas entry** — id + procedural color (cheap visual novelty).

## Phases (each independently shippable + playable)

- **Phase 0 — Persistent world state.** Define + write/read the durable `world-grown/` artifact
  (graph + blueprint + living grammar + content, shared assets symlinked). No behavior change yet;
  just the substrate. Seed it from the current village/start so step 1 has something to grow from.
- **Phase 1 — `forge:grow` MVP over existing grammar (live Tier 2).** Tier-1 region proposal
  (model-proposed from the story, with an approve/regenerate gate) → region synthesis primitive
  (a straight 5–8 zone region is OK here) → forge the region with live Tier 2 + deterministic
  Tier 3 → append to `world-grown/`. Proves the loop end-to-end.
- **Phase 2 — Structural variety.** Branching region shapes, varied biomes per region, layout
  archetypes (`ZoneArchetype`) so zones aren't same-shaped. First "not boxes."
- **Phase 3 — The inventor (grammar novelty).** Manual trigger first; later demand-driven on an
  uncovered theme/biome. Mints archetypes/factions, validated + frozen into the library. Real novelty.
- **Phase 4 — Prefab + sprite novelty.** Inventor mints structures (prefabs at landmarks) and
  optional new atlas sprites. Structural + visual distinctness.

## Settled decisions
- **World location:** dedicated `world-grown/` (shared assets symlinked from `world/`; non-destructive; boot via `WORLD_DIR`).
- **Growth unit:** an intentional multi-zone **region**, ~5–8 zones.
- **Region intent:** **model-proposed** — Tier 1 invents the next region's purpose from the story-so-far; user approves or regenerates.
- **Seam:** Tier 1 picks the bordering frontier zone from story logic; user may override.
- **Inventor trigger:** manual-only to start (Phases 1–2 use existing grammar only).
- **Phase 1 model:** live Tier 2 from the start (deterministic Tier 3 unchanged).
