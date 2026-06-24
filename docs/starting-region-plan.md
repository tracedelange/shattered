# Starting region: a handcrafted baseline, then offload to the LLM

Status: plan / strategic pivot (2026-06-23). Supersedes the "LLM authors the world forward"
default for now. The iterative grow loop (`docs/iterative-growth.md`) is paused, not abandoned —
it becomes the *final* stage of this plan, running over a kit this plan produces.

## The pivot — and why

The project thesis was: *a low-cost LLM can build out world content sufficient to make a world
interesting to explore over time.* After many iterations of the forge/grow loop, the played results
have been disappointing — "all sprawl," flat biome fields, much the same run to run.

The diagnosis: **this is a substrate problem, not a generator problem.** The LLM has been authoring
*labels and structure* (faction, biome, archetype, level band, quest beat) onto a canvas that renders
every zone as a flat field, composed from a vocabulary of stat-knobs. Iterating the generator can't
escape a thin substrate — which is exactly why the results converge.

**Reframed thesis (the one we'll actually test):**

> ~~A low-cost LLM authors interesting content from scratch.~~
> **A low-cost LLM composes a rich, human-authored kit into a world that stays interesting over time.**

This is more defensible, and the *low-cost* constraint argues for it: cheap models are weak authors
of evocative novelty but capable composers of structured pieces. Every positive result so far has been
a *composition* win (theming, narrative continuity, the approval loop, quest/loot wiring); every
disappointment has been an *authoring* failure. So: build the kit and the baseline by hand, keep the
LLM in the composer role, and switch it back on once there's something worth composing.

## The target — an ideal starting region

What a starting region should contain (none of which the experience delivers today):

1. **A unique, visually interesting village** — town square, multiple NPCs, unique merchants, several
   faction presences, buildings with unique interiors (tavern, guardhouse, inn), a few passive mobs,
   quest givers, and a sample dungeon (sewer/cave).
2. **A cohesive, interesting wilderness around it** — a goblin camp, more creatures, unique geography,
   loot, and extra caves / dungeons.
3. **A true challenge** — a unique, visually interesting abandoned castle taken over by the goblin
   leader, with progressive difficulty, a boss fight tied to a quest, and unique loot.

This baseline, once we're happy with it, is the **gate** that re-introduces the LLM — and it doubles
as the LLM's composition library.

## Gap analysis — the engine has the primitives; the kit and ergonomics are missing

"None of this is createable today" is true of the *finished experience*, but most **primitives
already exist**. The gap is the *kit* (content) + *authoring ergonomics* + a few discrete *engine*
features — a bounded investment, not a rewrite.

| Element | Primitive today | Gap (bucket) |
|---|---|---|
| Town square | `market_square` feature | content (a good layout) |
| NPCs / quest givers / passive mobs | templates + spawns + dialogue | content |
| Unique merchants | inventory system; **no NPC vendor economy** | **engine** (discrete) |
| Faction presence | grammar factions | content (placement) |
| Building interiors (tavern/inn/guardhouse) | interior sub-zone *mechanism* (the `cellar` pattern); **none authored** | content + **tooling**; mechanism exists |
| Sample sewer/cave dungeon | `cave` / `sewer` biomes + sub-zones | wiring / authoring |
| Goblin camp | prefab stamping | content (a camp prefab) |
| Unique geography | ~10 feature operators (thin) | content + a few **engine** terrain primitives |
| Abandoned castle | `dungeon` biome + prefab stamping | content (a large authored prefab) |
| Progressive difficulty | level bands + scaling | — |
| Boss fight + quest | quests-with-stages; "boss" = max-band mob (**no boss mechanics/arena**) | quest done; **engine** if richer bosses wanted |
| Unique loot | procedural rarity incl. legendary; **no hand-authored named uniques** | **engine** (fixed-unique path) + content |

**Genuine engine gaps (small, discrete):** NPC vendor economy; named/fixed unique items;
building-interior authoring ergonomics (mechanism present); optionally boss mechanics + terrain
primitives. **Biggest gap:** the kit (prefabs, sprites, features, named NPCs/uniques). **Also real:**
authoring ergonomics — the existing `tools/zone-editor` and `tools/biome-workbench` are outdated.

## The gameplan (decided ordering)

Three stages. The bet is that each handcrafted piece in Stage 2 becomes reusable kit, so Stage 3's
LLM has a real vocabulary to compose.

### Stage 1 — Authoring tooling (do this first)
Modernize the outdated editors into a **preview + modify** workflow good enough that hand-authoring,
accelerated by Claude / CLI tools, is pleasant. Targets:
- Rehabilitate / replace `tools/zone-editor` and `tools/biome-workbench` — live preview of a zone
  (terrain, features, spawns, portals) with inline edit.
- Preview + place: features, prefabs, spawns, portals/sub-zone entrances on a zone.
- A fast loop to view a generated/edited zone and tweak it (the thing that makes hand + CLI authoring
  viable).
- CLI-friendly: editing the underlying YAML/JSON should be first-class so Claude can drive it.

Principle: **don't over-build the editor up front.** Build enough to author the first village slice;
let the act of authoring reveal what the editor actually needs.

### Stage 2 — Hand- + CLI-authored baseline slice (vertical slice)
Build the starting region by hand (with Stage 1 tooling + Claude/CLI), **village first** — it's the
densest concentration of gaps (interiors, merchant, NPCs, faction presence, a sample dungeon).
Building one of each thing forces the real engine gaps to surface *in priority order* and turns each
piece into reusable kit:
- a tavern/inn/guardhouse interior → an interior template,
- a merchant → a placeable vendor,
- the square / camp / castle → prefabs and layout grammar,
- a boss + named unique → an encounter + loot template.

Order within the slice (recommended): **building interiors first** (highest experiential payoff,
surfaces sub-zone ergonomics), then merchant economy, then the wilderness, then the castle challenge.
The baseline is "done" when it's a region the designer genuinely enjoys exploring — that's the gate.

### Stage 3 — Offload to the LLM (composition over the kit)
With a baseline we're happy with and a kit of real building blocks, re-enable the LLM in the composer
role: propose / theme / connect / vary / wire — the two-move looper of `docs/iterative-growth.md`
(sprout + deepen), now recombining evocative pieces instead of stat-knobs on flat fields. This is the
actual test of the reframed thesis.

## Guardrails
- **Bound the step-back.** Engine/tooling work is a comfortable sink. The baseline region is the gate;
  build only what the slice needs to reach it, then move to the next stage.
- **Every handcrafted piece is kit.** If something can't later be reused/varied by the LLM, reconsider
  how it's authored.
- **Keep the engine able to express it.** When the slice hits a true engine wall (vendor economy,
  named uniques, building interiors), build that feature — narrowly — rather than working around it.

## Relationship to other docs
- `docs/iterative-growth.md` — the LLM grow loop (sprout + deepen). Paused; becomes Stage 3.
- `docs/v2-top-down-generation.md` — the grammar/deterministic-Tier-3 machinery the kit + composer reuse.
