# Iterative organic world growth

Status: Phases 0–3 built (substrate, wired grow, branching, the inventor). Now evolving
from append-only sprawl toward a **two-move looper** (sprout + deepen) — see
"The depth↔sprawl evolution" below, which supersedes the append-only framing.
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

## Phases — original build (status)

- **Phase 0 — Persistent world state.** ✅ Built. The durable `world-grown/` artifact
  (graph + blueprint + content, shared assets symlinked, canonical `world/grammar/`).
- **Phase 1 — `forge:grow` MVP (live Tier 2).** ✅ Built. Tier-1 region proposal + approve/regenerate
  gate → region synthesis → live Tier 2 + deterministic Tier 3 → wired into `world-grown/` (spawns,
  quest givers, biome-filtered features).
- **Phase 2 — Structural variety.** ✅ Built (branching spine/`side` shapes, coherent biomes).
  Deferred: per-zone interior layout archetypes (`ZoneArchetype`) — folded into "deepen" below.
- **Phase 3 — The inventor (grammar novelty).** ✅ Built. `forge/lib/inventor.ts` + the grammar UI
  mint validated archetypes/factions into the single canonical `world/grammar/`.
- **Phase 4 — Prefab + sprite novelty.** Not built — subsumed by "deepen" actions below.

---

## The depth↔sprawl evolution: the two-move looper

**The problem.** Everything above is *append-only*: each step sprouts a new region at the frontier
and never revisits what exists. Run it N times and the world can only **sprawl** — a strip of regions
marching outward, every zone a flat biome field with mobs scattered on it. There is no **depth**:
no densifying, re-theming, landmark/dungeon-building, or quest-chaining of regions already placed.

**The insight: both halves already exist.** The depth engine is the original **gardener**
(`pipeline/gardener.ts` + `pipeline/lib/mutations.ts`). It already emits the verbs we want —
`refactor_zone`, `refactor_lore`, `mob_populate`, `quest_add`, `zone_enhance`, with mutation ops
`patch_mob`, `patch_item`, `add_spawns`, `remove_spawns`, `add_features`, and patching a zone's
`name`/`level_band` — and it has an **`--anchor` mode** that scopes to one zone and biases toward
`refactor_zone`. "Lean back toward the gardener" is therefore **not a rebuild — it's unifying the
two systems under one looper.**

### One looper, two moves
Each step the looper chooses an **intent**, gated by user approval, continuing the blueprint
storyline + frozen grammar:

- **SPROUT (sprawl)** → forge grow: a new themed region at a frontier seam. *Today's path.*
- **DEEPEN / REFACTOR (depth)** → the gardener anchored to an *existing* region: re-theme zones,
  add a dungeon sub-area or named landmark, densify/re-tune spawns, extend a one-off bounty into a
  chain, fix incoherence.

The looper's themes (storyline, faction grammar, approve/regenerate gate) wrap both moves, so a
deepen reads as story continuation ("the cult's grip on the desert tightens — a buried shrine
surfaces"), not random edits.

### "Done" is the wrong frame — maturity is a gradient
A region is never asserted "done." A deterministic **maturity scan** scores each region from its
on-disk content (spawn density vs. band, dungeon/landmark presence, quest depth, biome/terrain
variety, lore coherence). The gap to a target profile *is* the deepen backlog. Maturity only **tilts
the deepen↔sprout choice** — a dial, not a gate. The current loop has that dial pinned at 100% sprawl.

### Per-step flow
1. **Maturity scan** *(new, deterministic, no LLM)* — per-region summary + the frontier.
2. **Tier-1 proposes ONE intent** *(extends `runTier1Grow`)* — either `sprout` (a `RegionSpec`) or
   `deepen` (`{ region_id, rationale, goals[] }`) → approve / regenerate / switch gate.
3. **Route:** sprout → region-synth + Tier 2/3 + wiring (unchanged); deepen → the gardener anchored
   to that region, restricted to the allowlist below.
4. **Commit** to `world-grown/` + append a blueprint note (story continuation either way).

The **instanced dungeon sub-area** (overworld zone + entrance portal → self-contained `biome: dungeon`
sub-zone, wired by a non-cardinal connection, mirroring the existing `cellar`/`undercroft` zones) is a
**deepen action**, not a sprout-time thing — a region earns its dungeon when it's deepened.

### Reuse vs. build
- **Reuse:** `gardener.ts` (anchor mode), `mutations.ts` (the ops), the approval gate, region-synth, the cascade.
- **Build:** the maturity scan; the Tier-1 `sprout|deepen` intent schema + prompt; the **deepen executor**
  that applies gardener output into `world-grown/`; allowlist enforcement; the dungeon sub-area action.
- **Known integration risk:** the gardener/implementer currently targets the pipeline's `world/` and its
  own opportunity/history files — pointing its mutation-apply at `world-grown/` is the main plumbing, and
  the atomic mutation-apply path was noted as "half-built" (see `docs/implementer-mutation-interface.md`).

### Phasing (each shippable; user stays in the loop)
- **A — Decision loop only:** maturity scan + `sprout|deepen` proposal + gate. Deepen just *prints its
  goals* (dry run). Proves the balance mechanism; low risk.
- **B — Additive deepen executor:** apply the safe ops (spawns/features/quests/`level_band`) over
  `world-grown/`. First real depth.
- **C — `refactor_zone` + dungeon sub-area** as deepen actions (re-theming + the instanced delve).
- **D — Maturity tuning** / balance the dial.

## Settled decisions
- **World location:** dedicated `world-grown/` (shared assets symlinked from `world/`; non-destructive; boot via `WORLD_DIR`).
- **Single grammar:** the canonical `world/grammar/` is the one library the grower and inventor read/write (no per-world copy). It will collapse into `world/` once performance is satisfactory.
- **Growth unit (sprout):** an intentional multi-zone **region**, ~5–8 zones.
- **Two moves:** every step is **sprout** (new region) or **deepen** (modify an existing region).
- **Intent selection:** **model-proposed, user-approved** — Tier 1 reads the story + a maturity scan and proposes ONE intent (sprout *or* deepen); user approves / regenerates / switches.
- **Deepen scope:** **additive + light refactor** — add spawns/landmarks/dungeons/quests, patch `level_band`/`name`, allow `refactor_zone` (re-theme); **never destructive** (no `remove_spawns`, no layout teardown).
- **"Done":** not a gate — region **maturity** is a gradient that tilts the deepen↔sprout choice.
- **Dungeons:** **instanced sub-areas** (entrance portal → self-contained `dungeon`-biome sub-zone), produced as a deepen action.
- **Seam (sprout):** Tier 1 picks the bordering frontier zone from story logic; user may override.
- **Inventor trigger:** manual (via the grammar UI / green-light).

## Open / to-discuss (next session)
- **Maturity rubric:** which axes, weights, and target profile actually produce a world that *feels*
  balanced — needs play-tuning, not a priori.
- **Sprout fan-out:** growth currently only goes north (seam = deepest frontier + `[N,E,W,S]` direction
  preference). Fix direction to radiate away from the world's center of mass so sprawl spreads.
- **Mutation-apply plumbing:** the half-built atomic apply path into `world-grown/` (Phase B's crux).
