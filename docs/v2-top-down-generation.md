# V2: Top-Down Generation with a Frozen Grammar and an Automated Judge

Status: design / not yet implemented. Supersedes the v1 generation thesis.

## 1. Why v1 produces "plausible mediocrity"

The v1 loop (Gardener → Implementer → structural validation) asks **one cheap model, per node, with local context, to do three jobs at once**:

1. **Invent the standard** — decide what "good" content is.
2. **Design the node** — decide what should exist here, how hard, how it fits the region.
3. **Instantiate** — write the specific mob/item/quest/zone.

Quality at the *region* scale is emergent and un-promptable; coherence is negotiated *locally* (each zone, blind to the whole); and validation checks *structure*, not *quality*, so valid-but-flat content sails through. The result is patchy, inconsistent, and not fun — and every prompt tweak just moves the defect somewhere else. That is the whack-a-mole.

The fix is not a bigger model. It is to stop asking the model to do (1) and (2) per-instance, and to make quality **checkable** rather than hoped-for.

## 2. The thesis

**Author the grammar; generate the instances. Coherence is inherited top-down. Quality is enforced by an explicit spec plus an automated judge.**

Three structural moves, none of which require a human to author world content:

- **A frozen, generated-once grammar.** The model's creativity is spent *once* on a reusable, curated vocabulary (factions, monster archetypes, quest templates, vault pieces, affix effects). Forever after, generation *recombines* the frozen kit instead of reinventing it. This is the consistency unlock — every node draws from the same vocabulary — and the scalability unlock — creativity is amortized, not re-paid per instance.

- **A real top-down design cascade.** A lore seed is the axiom. Each layer's output is the *constraint set* for the layer below. Coherence flows downward from the seed instead of being assembled sideways between peer zones.

- **An automated quality gate (the judge).** Each instance is graded against its *decided spec + grammar refs + gold exemplars*, and failures are regenerated. Judging against explicit anchors is tractable for a small model in a way that "is this good?" never is.

A corollary that governs the whole design: **push as much quality determination as possible up into the grammar and the spec** (reviewed by humans at low volume, high leverage), so that the judge's per-instance job degrades to *conformance checking* — which small models do reliably. The judge is the enforcement layer, not the primary quality mechanism. The grammar and spec are.

## 3. The generation cascade

Each layer constrains the one below. The grammar is orthogonal — a library every layer references by ID.

```
Tier 0  World map: biomes, level bands, village placements      [PROGRAMMATIC — exists, mapgen]
Tier 1  10k-ft lore bible, derived from the seed                [LARGE model, rare — partial: bible.yaml exists]
Tier 2  Region/zone design: decided node-specs (ref grammar)    [MID model = Gardener, RE-SCOPED]
Tier 3  Laser mutations from specs                              [Implementer, TIGHTER INPUT]

        ── orthogonal library, referenced by Tier 2 & 3 ──
GRAMMAR  factions · monster archetypes · quest templates ·       [GENERATE-ONCE + human-curated — NET NEW]
         vault pieces · affix effects
JUDGE    grades each instance vs spec + grammar + exemplars,     [NET NEW]
         regenerates failures, routes survivors to human sample
```

We are **not rebuilding the pipeline.** The Gardener stops emitting soft "opportunities" and starts emitting *decided specs* that reference frozen grammar IDs. The Implementer's input gets tighter so its mutations become mechanical. The genuinely new work is the **grammar library**, the **judge**, and a light **lore pass**.

Dependency order: **lore → grammar → design → instance+judge.** The design pass cannot assign "faction Hollow-kin, archetype set {x,y}, vault piece Z, affix flavor F" to a node until that vocabulary exists and is frozen. So the grammar is a *prerequisite* for the design pass to have anything to design with.

## 4. The grammar library (deep dive)

The grammar is a frozen, ID-addressable vocabulary on disk that all downstream generation references. The discipline that makes it work: **the design pass may only reference grammar IDs that already exist.** That single rule is what makes coherence enforceable and the judge's job easy — an instance is "good" largely if it correctly instantiates its grammar refs.

### 4.1 Two layers: primitive (code-gated) vs composite (data, model-generated)

This distinction is load-bearing and honest about where engineering effort lives.

**Primitive layer — code-gated, slow, rarely changed, human+engineer authored.** These are the atoms the *engine itself* understands. Expanding them touches engine code, so they are NOT part of the scalable automation loop:

- **Affix effects** — the set of `bonus` keys (`fire_damage`, `strength`, `armor`, …). Currently freeform; the engine's `sumEquipRolled()` is the only consumer (`server/game/systems/combat.ts`). A *new effect* (e.g. `light_radius`, `move_speed`, `find_secrets`) requires engine wiring. The grammar freezes "here are the N effects that exist, what each does, and the value curve by rarity/ilvl."
- **Quest objective kinds** — the fixed enum of 5 (`kill_count, kill_specific, collect_count, reach, talk`; `server/world/quest_schema.ts`). A 6th kind requires schema + validator + engine changes in three places.

**Composite layer — pure data, model-generated + human-curated.** This is where the scalable automation lives. Everything here is recombination of primitives:

- **Monster archetypes** — parameterized templates over the existing mob schema (`pipeline/lib/mutations.ts` `MOB_BODY`): `role` + stat profile + `speed`/`behavior`/`aggro_range` + loot affinity + level-scaling rule + a thematic identity. No abilities — capability is stats + role + affixes. An *instance* = archetype + theme skin (name, sprite, flavor) + level. e.g. `archetype: fast_skirmisher` → instanced as "Hollow Scout" at L4.
- **Quest templates** — named compositions of the 5 objective primitives into recognizable shapes: `bounty` (kill_count), `fetch` (collect_count), `courier` (talk/reach chain), `hunt_named` (kill_specific), `seek` (reach). A template is a stage skeleton with typed slots; an *instance* fills giver/target/zone/reward/narrative. This formalizes what is currently implicit in hand-authored quests.
- **Vault / prefab pieces** — a curated catalog of ASCII prefabs (`world/prefabs/*.json`: `data` + `legend` + `anchors`), tagged by biome/role (shrine, ruin, camp, landmark, dungeon-room). The Implementer *stamps from the catalog* via `add_features` rather than hand-drawing grids each time (which is where hollow-box homogeneity came from).
- **Factions / biome-kits** — THE coherence primitive. A faction bundles: a set of archetype IDs, a loot/affix flavor, a vault style, and a lore hook. A zone draws from one or two factions, so its monsters + loot + structures + flavor are guaranteed to cohere. This is the single most important element for fixing "patchy and inconsistent," because it makes a zone's identity a *reference*, not an improvisation.

### 4.2 Storage

New `world/grammar/` directory, format-preserving YAML like the rest of the content tree:

```
world/grammar/
  factions.yaml        # composite — model-generated + curated
  archetypes.yaml      # composite
  quest_templates.yaml # composite
  vault_index.yaml     # composite — tags over world/prefabs/*.json
  affix_effects.yaml   # primitive — documents the code-backed effect keys + value curves
```

Each entry has a stable `id`. New Zod schemas live alongside the existing ones in `pipeline/lib/` and are loaded by `server/world/loader.ts` (engine needs archetypes/factions to resolve instances) and by the pipeline (design + judge reference them).

### 4.3 The generate-once pipeline

A new entry point `pipeline/grammar.ts`:

1. Input: the lore bible (`world/lore/bible.yaml`) + the Tier-0 biome/band/village list.
2. A large model proposes the composite-layer catalog — factions, archetypes, quest templates, vault tags — *consistent with the seed's tone* (grimdark, fractured-divinity, shard-gods).
3. **Human curation gate** — approve/reject/edit. Tiny volume (dozens of entries), highest leverage you will ever exert: it defines everything downstream.
4. Freeze to `world/grammar/*.yaml`.

This runs rarely (region launch, major expansion), not per-cycle. Re-running it is a deliberate vocabulary *expansion*, re-curated each time.

## 5. The judge (deep dive)

The judge is a new pipeline stage that grades a generated instance and gates it. It does **not** ask "is this good?" in the abstract. It grades against explicit anchors:

- **Spec conformance** — does the instance match its decided slot (level band, faction, type, count)?
- **Grammar conformance** — does it correctly use frozen vocabulary, inventing no off-grammar mechanics?
- **Exemplar parity** — does it meet the craft/voice bar set by the gold examples for this unit type?
- **Coherence** — does its flavor match the faction's lore hook and the bible's tone?

These are checkable *because they are relative to explicit anchors the human already approved.*

### 5.1 Where it sits

In the Implementer flow, **after** structural validation (`mutations.ts validateMutations`) and **around** apply:

```
LLM output → structural validate (exists) → JUDGE (new) → apply (exists)
                                              │
                              pass ───────────┘
                              revise → quality-repair prompt (extend existing repair loop in validate.ts), bounded retries
                              reject → block opportunity + route to human queue
```

The existing repair loop in `pipeline/lib/validate.ts` repairs *structural* failures; we extend the same mechanism to *quality* failures — feed the judge's specific issues back into a revise prompt.

### 5.2 Output schema

```yaml
verdict: pass | revise | reject
dimensions:
  spec_conformance: { pass: bool, issues: [string] }
  grammar_conformance: { pass: bool, issues: [string] }
  exemplar_parity: { pass: bool, issues: [string] }
  coherence: { pass: bool, issues: [string] }
suggested_fix: string?   # only on `revise`, fed to the repair prompt
```

Force the judge to cite the *specific* spec/grammar violation per dimension — no vibe scores. Default to `reject`/`revise` on uncertainty for the dimensions that gate (LLM judges skew lenient and verbose; counter it with explicit per-dimension pass criteria and a refute-by-default posture on the load-bearing dimensions).

### 5.3 Why this is tractable for a small model — and the governing trade

A naive "rate this content 1-10" judge with a weak model is noise. This judge is reliable *to the extent the spec is explicit*, because most dimensions reduce to conformance checks ("is the giver in the quest's zone? does the mob's level sit in the band? are all affixes from the frozen set?"). The open-ended aesthetic call ("is this *interesting*?") is the unreliable part — so we minimize it by **pushing aesthetic determination up into the grammar and spec**, where a human reviewed it once at low volume. The better the spec, the more mechanical the judge, the more reliable a small model is. Invest in spec explicitness to shrink the judge's aesthetic burden.

Model choice: the judge can be a *larger* model than the fill model, run on small outputs — judging is far cheaper than generating, and still vastly cheaper than human review at scale. The crux experiment (below) is whether a small judge suffices; if not, a bigger judge is the cheap fallback.

### 5.4 Calibration — the practical "RLHF" without training

You cannot fine-tune Claude via the CLI, and you do not need to. The spirit you want — your preferences making the system better — is achieved in-context:

- **Approved instances → grow the gold-exemplar library** (better few-shot for both fill and judge). In-context learning, not weight updates.
- **Rejected instances + your reason → become rules in the judge rubric and negative examples in fill prompts.** Your "no" is captured as an explicit constraint.
- **Your approve/reject *sample* calibrates the judge.** You grade a batch, compare to the judge's verdicts, and tune the rubric until they agree. Your eyeballs scale by *checking the checker*, not the content.

Build the approve/reject capture mechanism now regardless — preference data is also the prerequisite if you ever did real RLHF, so you lose nothing by deferring training.

## 6. Where human review lives (the leverage inversion)

"Approve/reject everything" does not scale — it would kill the thesis the moment the world grows. Concentrate review where volume is low and leverage is high; thin it out as volume rises:

| Layer | Volume | Review |
|---|---|---|
| Grammar freeze | dozens of entries | **Exhaustive.** Defines everything downstream. |
| Lore bible + region design | low | **Full.** |
| Instances | high / unbounded | **Sample only**, used to calibrate the judge. The judge reviews the bulk; you audit the judge. |

That inversion — *you approve the grammar and the judge; the judge approves the instances* — is what makes "I want out of the per-instance loop" real rather than aspirational.

## 7. Implementation plan

Dependency-ordered, mapped to the codebase. Grammar + judge are the **de-risking priority** — prototype them against a hand-written tiny seed *before* the full lore pass exists, because they are the two unproven foundations everything else references.

**Phase 0 — this doc + schemas.** Define Zod schemas for `factions / archetypes / quest_templates / vault_index / affix_effects` in `pipeline/lib/`, and the judge verdict schema. No behavior yet.

**Phase 1 — grammar library (the prerequisite, and de-risk #1).**
- `world/grammar/` storage + loaders (`server/world/loader.ts` for engine-consumed kinds; pipeline loaders for design/judge).
- `pipeline/grammar.ts` generate-once pipeline + human curation gate.
- Start with the **composite layer** (factions, archetypes, quest templates, vault tags) — affix/objective primitives partly exist already.

**Phase 2 — the judge (de-risk #2).**
- Judge stage + verdict schema; slot it after `validateMutations` in `pipeline/implementer.ts`.
- Extend `pipeline/lib/validate.ts` repair loop from structural-repair to quality-repair.
- Calibration capture: log verdicts + a human sample queue.

**Phase 3 — re-scope Gardener → design pass.** Emit *decided node-specs* that reference grammar IDs instead of soft opportunities. The spec becomes the Implementer's tightened input and the judge's conformance anchor. Touches `pipeline/gardener.ts`, `pipeline/lib/prompts.ts`, `pipeline/lib/schemas.ts` (opportunity → spec shape).

**Phase 4 — light lore pass.** Large model derives/extends `world/lore/bible.yaml` + faction seeds from the seed. Light because the cosmology axioms already exist.

**Phase 5 — E2E test runs.** Small region + simple lore seed, full cascade. See §8.

## 8. What "proven possible" looks like (the falsifiable bet)

The whole thesis is falsifiable, and the cheapest test is Phases 1+2 in isolation:

1. Take the existing cosmology seed + a hand-written tiny grammar (3-5 factions/archetypes/templates, a few gold exemplars).
2. Generate a dozen instances against decided specs.
3. Run the judge. Spot-check the judge against your own grades.

**The load-bearing question is §5.3: can the judge reliably gate quality given explicit specs?** If yes, the cascade is worth building out and scalable quality is real. If no — even with a larger judge and explicit specs — the automated-storytelling thesis is in trouble, and you will have learned that for the price of a prototype rather than a rewrite.

The end state to aim at: a cohesive level 1-10 starting region, generated by the full cascade from a simple seed, that you would grade as passing — produced without you in the per-instance loop.
