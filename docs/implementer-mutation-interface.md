# Implementer Mutation Interface — Hypothesis & Direction

## Status

**Exploration / hypothesis — not an approved plan.** This document hands off a
diagnosis and a set of options to a fresh context. It should inform a decision
about *how the implementer commits world mutations*, not prescribe a specific
implementation. Read the "Grounding" section first to orient in the code, then
the diagnosis, then decide which rung of the ladder to build.

The immediate question it exists to answer: **the content pipeline keeps
crashing when driven by a cheap model. Is that a model-capability problem, an
engine-interface problem, or something in between — and what is the durable
fix?**

---

## TL;DR

- The crashes are **not** evidence the engine is wrong or the model is too
  small. They live at the **boundary** between them: the implementer asks an LLM
  to hand-write one large, multi-schema document in a single shot, and the host
  validates it late and throws (crashing the whole loop) on the first malformed
  piece.
- The `file_ops` the implementer already emits (`append_spawns`,
  `append_features`, `patch_zone_field`, `new_zones`) **are already a
  tool-like primitive API.** The pipeline is ~70% of the way to a tools
  architecture; it just *delivers* the calls as a slice of a YAML blob instead
  of as individually-validated, individually-isolated operations.
- The genuine engine gap is the absence of a **single
  validate-everything-then-apply-atomically mutation boundary**. Validation is
  scattered (Zod schemas, thrown mid-apply in `fileOps.ts`, thrown at
  `loadWorld`, thrown at render). `applyFileOps` is not atomic, so a failure on
  op N leaves ops 1..N-1 written and the world half-mutated.
- The scaling constraint is **cheap, reusable models** (cost at scale). "Just
  use Sonnet/Opus" is a valid *diagnostic* but not the long-term answer.
- **Recommended direction:** shrink the unit of work the model commits at once
  (a flat list of validated, discriminated ops), and give the engine one atomic
  validated mutation API to commit them through. This serves cheap-model
  reliability *and* loop robustness from the same change. Reserve a full agentic
  tool loop for the few genuinely hard opportunities, not every spawn.

---

## Grounding (read the code first)

The content pipeline is two LLM roles plus a deterministic host, all under
`pipeline/`:

- **Gardener** (`pipeline/gardener.ts`, prompt in `pipeline/lib/prompts.ts`
  `GARDENER_SYSTEM`) reads world state + metrics + sagas and writes
  `world/pipeline/opportunities.yaml` — a list of structured proposals.
- **Implementer** (`pipeline/implementer.ts`, prompts composed per-type by
  `implementerSystemFor` in `pipeline/lib/prompts.ts`) takes ONE opportunity and
  emits a single fenced-YAML document validated by `ImplementerOutputSchema`
  (`pipeline/lib/schemas.ts`). That document can contain: `files[]` (mob/item/
  quest YAML + prefab JSON, each with its own body schema), `file_ops[]` (the
  mutation primitives), `new_zones[]`, `lore_update`, `tileset_update`.
- **Loop** (`pipeline/loop.ts`) drains the implementer until no `pending`
  opportunities remain, runs one gardener pass (which *overwrites* the queue —
  fresh batch each run), and repeats. It stops on a non-zero implementer exit.
- **Transport** (`pipeline/lib/llm.ts`) is a single-shot Messages-API call. The
  header comment is important context: an earlier "Implementor v2" rework
  **deliberately deleted an agentic Agent-SDK loop** because per-call subprocess
  spawning was "pure overhead." Reintroducing tool round-trips re-incurs that
  cost — weigh it.

The mutation primitives that matter most:

- `pipeline/lib/fileOps.ts` — `FileOpSchema` is a discriminated union over
  `op`: `create`, `append_spawns`, `append_features`, `patch_zone_field`.
  `applyFileOps` applies them **sequentially, mutating + writing per op**, and
  **throws mid-loop** on inner validation failures (e.g. `patch_zone_field`
  with `field: level_band` whose value isn't `{tier, minLevel, maxLevel}` throws
  at ~`fileOps.ts:283`). There is no "validate all, then commit" phase and no
  rollback.
- `ImplementerOutputSchema` (`pipeline/lib/schemas.ts`) validates the
  *structure* of the response but defers a lot of semantic validity to apply
  time and to `loadWorld` (`server/world/loader.ts`, which throws on e.g. an
  invalid mob `role`).

---

## Observed failure evidence (one cheap-model run, representative)

Three crashes across three sessions, each a **different throw site**, same
underlying pattern — the model got one piece of the mega-document wrong:

1. **Mob schema** — model wrote a mob with no `id`/`role` and invented
   `hp`/`damage`/`loot` fields. Crashed at `loadWorld` during the post-write
   render pass.
2. **file_op scope** — an opportunity with no structured `target_zone` (zone
   named only in `intent` prose) led the model to emit `patch_zone_field` against
   an *arbitrary real zone*, silently renaming a developed zone. (Also: a second
   opportunity targeted the correct zone but was rejected because the
   opportunity declared no scope.)
3. **file_op value shape** — `patch_zone_field` set `level_band` to a string;
   `applyFileOps` threw at apply time and killed the loop.

Each was individually patched (see "What's already been done"), but patching
throw sites one at a time is whack-a-mole. The pattern, not the instances, is
the thing to fix.

Why a cheap model fails here specifically: the probability the *whole* response
is valid is roughly the **product** of per-piece success rates across 6+ strict
schemas. A capable model (this design originally ran on Sonnet/Opus) clears that
bar most of the time; Haiku is borderline; a ~14B local model is over the edge.
Also observed: the model **over-reaches** — emitting `level_band` patches and
`tileset_update`s for a `mob_populate` that needed neither, adding failure
surface for no benefit.

---

## Diagnosis: it's the boundary, not the binary

The instinct to frame this as "engine robustness vs. model scale" is a false
binary. Evidence:

- The engine's *primitives* are reasonably well-factored: frozen biome+seed
  terrain, coordinate-free `file_ops`, feature operators, prefabs, level bands.
  `append_spawns(zone, [{entity, count}])` is `add_spawn(...)` in all but name.
  This is not a weak interface.
- The model is not fundamentally incapable: it produces *coherent* sagas and
  *correct intent*; it fails on **mechanical schema precision under high
  surface area in one shot**.

So the strain is the **LLM→engine bridge**:

1. **Delivery shape** — one free-form document instead of discrete, validated
   operations. High surface area, all-or-nothing.
2. **Validation timing** — scattered and late (some Zod, some thrown at apply,
   some at `loadWorld`/render). No single upfront gate.
3. **Non-atomic apply** — partial writes leave the world half-mutated.

Fix the bridge and the same change improves cheap-model reliability *and* loop
robustness. That is the leverage point.

---

## Why "tools / simple parameters" is the right instinct (mechanically)

Turning an operation from "a slice of a YAML blob" into "a validated typed op"
changes three things:

1. **Schema enforcement moves to the boundary.** A `level_band` typed as
   `{tier, minLevel, maxLevel}` *cannot* be a string — rejected with structured
   feedback before anything touches disk. The class of crash #3 becomes
   structurally impossible.
2. **Per-decision surface collapses.** Cheap models are far better at "fill
   these 4 params" than "emit 200 correct lines across 6 schemas." You stop
   multiplying per-piece failure probabilities. This is the biggest single lever
   for cheap-model reliability.
3. **Failure is isolated by construction.** One bad op fails alone; the rest
   apply. Partial progress instead of all-or-nothing. No monolith left to crash.

---

## The genuine engine investment (pays off regardless of LLM pattern)

Independent of how the model is driven, the engine should expose **one atomic,
validated mutation API**:

```
applyMutations(ops) -> { applied: Op[], failed: { op: Op, error: string }[] }
```

- Validates the entire op set up front (every op's inner shape — `level_band`,
  spawn entries, feature ids, field types — checked before any write).
- Applies atomically, or per-op with clean skip + rollback of partials.
- Returns per-op results so the caller can repair/skip just the failures and
  report precise feedback to the model.

This is the missing seam. It removes the scattered apply-time throws, eliminates
half-mutated worlds, and becomes the foundation any of the delivery options
below build on. Today this logic is spread across `fileOps.ts` (throws),
`schemas.ts` (structure only), and `loader.ts` (throws at load). Consolidating
it is valuable even if the delivery shape never changes.

---

## The delivery ladder (and where to land)

A spectrum from where the pipeline is today to a full agentic loop:

1. **Today** — one YAML doc, late validation, all-or-nothing, crashes the loop.
2. **Hardened monolith** — same doc, but full upfront validation + per-op
   isolation + a top-level safety net so one bad opportunity can never crash the
   loop. *Band-aid: keeps the brittle delivery shape, just stops the bleeding.*
3. **Flat typed-op list** — the response *is* a validated list of discriminated
   ops (`{ op, ...params }`), each validated, applied, repaired, and skipped
   independently against the atomic mutation API. **One shot, op-granular, no
   round-trips.** Keeps the cost profile of the current design while getting
   per-op validation + isolation + targeted repair.
4. **Real tools** — agentic loop, per-call tool schema enforcement, model sees
   each result and self-corrects. Most robust, but reintroduces the multi-round-
   trip cost the v2 rework deliberately removed.

**Recommended target: rung 3** for the cheap-reusable-at-scale constraint. It
plays to cheap models' strengths, reuses existing engine primitives, and keeps
one-shot economics. **Reserve rung 4** for the few opportunity types that
genuinely need iterative reasoning (e.g. multi-level dungeon construction), not
for every mob spawn. Rung 2 is worth doing *now* regardless, as a stopgap, since
it is small and model-agnostic (see next section — it is partially built).

Open design questions for whoever picks this up:

- Can a cheap model reliably produce a *long* correct op-list in one shot, or
  does the surface-area problem just reshape? (Per-op repair/skip mitigates it,
  but measure — see Experiment.)
- Should `files[]` (mob/item/quest/prefab creation) also become ops
  (`create_mob`, `create_item`, ...) so the *entire* response is one flat op
  list? This is the cleanest unification but the largest rework.
- How does per-type narrowing interact with op-lists? Today
  `implementerSystemFor(type)` composes a per-type prompt but
  `ImplementerOutputSchema` still accepts everything. Constraining the *allowed
  op set per opportunity type* (a `mob_populate` literally cannot emit a tileset
  op) would cut the over-reach failure mode directly.

---

## What's already been done this session (current state)

Robustness patches already in the tree — partial, and important to know so the
new context doesn't redo them or mistake the half-built safety net for complete:

- **Mob-body pre-validation** (`collectBodyErrors` in `implementer.ts`):
  catches missing `id`/`role`, invalid role, and the `hp`/`damage`/`loot`
  wrong-shape *before* write, routing to the one repair retry. Prevented crash
  class #1.
- **file_op scope guard** (`collectBodyErrors`): a `file_op` may only touch the
  opportunity's `target_zone` + immediate ring; out-of-scope (and
  no-target-zone) ops are rejected. Prevented crash class #2's clobber.
- **`target_zone` enforcement** (`OpportunitySchema` superRefine +
  `ZONE_SCOPED_TYPES` in `schemas.ts`, plus a `GARDENER_SYSTEM` rule): zone-
  scoped opportunity types must carry a structured `target_zone`; the gardener's
  own validation/repair now catches a missing one at authoring time.
- **Failure isolation (`blockOpportunity` in `implementer.ts`) — INCOMPLETE.**
  An unrecoverable response after the repair retry marks the opportunity
  `blocked` and exits cleanly so the loop advances. **BUT it is only wired into
  the two pre-write validation phases (ref + body).** The **apply/write/render
  phases still throw and crash the loop** (this is exactly crash class #3 at
  `applyFileOps`). Completing this — a top-level per-opportunity safety net in
  `main()` that catches *any* unexpected throw (except `UsageLimitError` and the
  "no pending" signal), blocks the opp, and exits 0 — is rung 2 and is the
  smallest immediate win.

Also relevant context (separate feature shipped this session): a **saga** layer
(`pipeline/lib/sagas.ts`, `world/lore/sagas.yaml`) sits above opportunities — a
region-scale arc with escalating, level-banded stages. The gardener authors a
saga per region and tags opportunities to its stages; the implementer gets a
saga brief and marks stages realized. Not directly part of the mutation-
interface question, but it is why opportunities now carry `saga_id`/`saga_stage`
and why the loop is "saga-driven" in selection.

---

## Suggested de-risking experiment (half a day, reversible)

Before committing to a rework, get real signal instead of vibes:

1. Pick the highest-failure opportunity type — `mob_populate`.
2. Prototype it at **rung 3**: a tiny schema of discriminated ops
   (`create_mob`, `add_spawn`) validated per-op, applied through a minimal
   atomic `applyMutations`, with per-op repair/skip.
3. Run it on the **cheap model** (Haiku, and a local Ollama model) against a
   handful of `mob_populate` opportunities.
4. Compare failure/partial-success rate vs. the current YAML-blob path.

Also run **one Sonnet pass on the current (unchanged) structure** as a control:
if Sonnet runs clean, the architecture is sound and the op-list is a
reliability/cost optimization; if Sonnet *also* trips, the structure genuinely
over-asks and the op-list is mandatory. Right now the model and the architecture
are being debugged simultaneously, which is why progress feels stuck — the
control pass separates the two variables.

---

## Decision the next context should drive

1. Is cheap/local-model autonomy a **hard requirement** (→ commit to the op-list
   + atomic mutation API), or acceptable to run the implementer on a capable
   model and reserve cheap models for experiments (→ just finish rung 2 and
   move on)?
2. Regardless of (1): **finish the rung-2 safety net now** — it is small,
   model-agnostic, and the loop should never crash on a single opportunity.
3. If committing to the rework: build the **atomic validated mutation API
   first** (it is the shared foundation), then reshape the implementer response
   into a flat op-list against it, then decide whether `files[]` creation folds
   into ops too.
