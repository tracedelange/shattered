# Plan 5 — Abilities & status effects (one actor primitive)

**Status:** design agreed 2026-06-16. Net-new combat layer. Builds on Plan 1
(retune) and Plan 3 (affix/brand procgen), both landed.

## Goal

A single, generic ability system that **both mobs and players** consume, so the
shared logic is built once. Mobs stop being identical stat blocks: a handful of
authored abilities (charge, ranged spit, heal, slow, enrage) turns one encounter
into a dozen. The basic attack becomes "ability 0" so combat has exactly one
resolution path. This is also the gameplay vocabulary the forge cascade designs
against (Tier 2 references ability ids; the judge checks they resolve).

## The core distinction (the build-once boundary)

An **ability** describes *what happens*. A **controller** decides *when to fire*.
They never mix:

- **PlayerController** — an input/slot maps to an ability id.
- **MobController** — an AI policy fires an eligible ability (in range, off
  cooldown, hp-below threshold, …) and otherwise falls back to ability 0.

Both call one `executeAbility(world, actor, ability, target?)`. That executor —
targeting → cost/cooldown gate → effect resolution — is the thing we build once.
"Activation" lives on the controller, never in the ability data.

## Agreed decisions

- **Gating: generalized `cost` map + cooldown.** `cost: Record<resource, number>`
  (only `mana` exists now; the map reserves the seam for rage/energy later).
  `cost: {}` = free, cooldown-only — used by caster abilities and by ability 0.
- **Mana is a real resource that regenerates.** Base pool scales with
  intelligence; INT does double duty (spell power *and* sustain). Regen mirrors
  the existing health-regen tick (`nextRegenTick` / combat lockout in `loop.ts`).
- **Max-HP / max-mana bonuses are NOT formulas.** They are stat keys
  (`max_health`, `max_mana`) that **item effects and `modifier` effects grant**,
  flowing through the same aggregation as `+strength` etc. The base pool is the
  only thing the INT formula sets; everything above it is an effect.
- **Autoattack = ability 0.** The basic swing is a `damage` ability with
  `cost: {}`, `cooldown = attack speed`. The current `resolveAttack` damage core
  (roll + dodge + subtractive armor + min-damage floor) becomes the `damage`
  effect resolver, parameterized by `(base, scaling, brand)`.
- **Ability damage scales with the actor's stats, per-ability.** A spell scales
  intelligence; a headbutt scales strength. Reuses the existing letter-graded
  `scaling` map (`{ intelligence: 'B' }` → `SCALING_COEFFS`). For ability 0 the
  scaling map *is* the equipped weapon's `scaling` — so a wand autoattack scales
  INT for free the day this lands.
- **Verbs in v1: `damage`, `heal`, `modifier`, `move`.** `summon` deferred
  (seam reserved, no code).
- **Telegraphs in.** `cast.wind_up_ticks` is an optional visible cast window —
  what makes a mob ability dodgeable/designed rather than random burst.
- **Mobs are cooldown-dominant.** All actors carry a mana pool (build-once), but
  mob abilities use `cost: {}` so cooldown is their practical gate. Mana is the
  meaningful axis for players.
- **Abilities resolve through the existing dodge path**, so when Plan 4's to-hit
  layer lands, every ability inherits accuracy automatically.

## Model spine

1. **Ability data** (`world/abilities/*.yaml`, loaded into a registry like item
   bases). Schema:
   ```yaml
   id: <snake_case>
   name: "<Display>"
   targeting: { shape: <self|target|projectile|area>, range: <tiles> }
   cast:      { cost: { mana: <int> }, cooldown_ticks: <int>, wind_up_ticks: <int?> }
   effects:
     - { kind: damage,   base: [<min>,<max>], scaling: { intelligence: <grade> }, brand: <brand_key?> }
     - { kind: heal,     base: [<min>,<max>], scaling: { intelligence: <grade?> } }
     - { kind: modifier, stats: { strength: <int>, max_mana: <int>, ... }, duration_ticks: <int>, tick_effect: <damage|heal effect?> }
     - { kind: move,     motion: <charge|leap|knockback|blink>, distance: <tiles> }
   ```
   `grade` ∈ S/A/B/C/D/E (the existing `SCALING_COEFFS`). A dot/hot is just a
   `modifier` with a `tick_effect`.

2. **Shared effective-stat read** — promote `effectiveStat` out of `combat.ts`
   into `server/game/systems/stats.ts` and add the third aggregation term:
   ```
   effectiveStat(e, k) = base[k] + sumEquipRolled(e)[k] + sumActiveModifiers(e)[k]
   ```
   Every existing combat read (damage scaling, dodge, defense) then respects
   buffs/debuffs with no further change. `max_mana`/`max_health` are read the
   same way: `effectiveMaxMana = BASE_MANA + int*MANA_PER_INT + agg(max_mana)`.

3. **`scaledDamage(actor, base, scaling)`** — one function; the generalized form
   of today's `rollDamage`/`scaledBonus`. Weapon-fed for ability 0, ability-fed
   otherwise.

4. **Resource + cooldown state.** Add `mana: { current, max }` to player and mob
   components, plus a per-ability cooldown map (`abilityReadyTick: Record<id,tick>`)
   and `nextManaRegenTick`. Mana regen loop sits beside the health-regen loop in
   `GameLoop._tick` (same combat-lockout pattern).

5. **`executeAbility(world, actor, ability, target?)`** — the single entry point:
   check range + cooldown + can-afford `cost`; deduct cost; set cooldown; if
   `wind_up_ticks > 0` enter a casting state and resolve on completion; resolve
   targets by `shape`; apply each effect via its resolver.

6. **Effect resolvers** — `damage` (generalized `resolveAttack` core), `heal`,
   `modifier` (push a `TimedModifier` onto the target's `modifiers` component),
   `move` (reposition / knockback).

7. **`modifiers` component + tick** — `modifiers: TimedModifier[]` on actors.
   Each tick: decrement durations, apply `tick_effect` (dot/hot), expire. Placed
   next to the regen loop in `_tick`.

8. **Controllers** —
   - Player: new `PendingAction` variant `{ action: 'ability', abilityId, targetId? }`
     in `loop.ts` → `executeAbility`.
   - Mob: `MOB_BODY.abilities: [{ ability: <id>, conditions: [...], weight }]`;
     `aiTick` picks the highest-weight eligible ability (range + cooldown +
     `hp_below`/`on_spawn`/`target_fleeing`) and calls `executeAbility`, else
     falls back to ability 0.

9. **Ability-0 migration** — define the `attack` ability (`damage` effect, base
   + scaling from the equipped weapon / unarmed STR fallback, `cost: {}`,
   `cooldown = PLAYER_BASE_ACT_TICKS / speed`). Reroute the `attack` action and
   the mob basic attack through `executeAbility`. The dodge/defense/floor logic
   stays inside the `damage` resolver — no behavior change to existing combat.

## Forge vocabulary hook

- The ability pool is **hand-authored** (low volume, high review) — the
  code-gated primitive layer. Tier 2 draws `library_refs` from it; Tier 3 mob
  bodies carry `abilities: [<ids>]`.
- `validateEngineBody('mob', …)` (forge `engine.ts`) gains a check that every
  referenced ability id resolves in the registry and is level-appropriate —
  same conformance-not-taste story already proven on the lore axis.

## Files

- New: `world/abilities/*.yaml` (the pool); `server/game/systems/abilities.ts`
  (registry load + `executeAbility` + effect resolvers); `server/game/systems/stats.ts`
  (promoted `effectiveStat` + modifier aggregation).
- `shared/types.ts` — `mana`/`modifiers`/cooldown fields on `PlayerEntity` &
  `MobEntity`; `TimedModifier`, `Ability`, `AbilityEffect` types.
- `shared/constants.ts` — `BASE_MANA`, `MANA_PER_INT`, `MANA_REGEN_INTERVAL_TICKS`.
- `server/game/systems/combat.ts` — extract the `damage` core; route through it.
- `server/game/loop.ts` — `ability` action; mana-regen + modifier-tick loops.
- `server/game/systems/ai.ts` — ability selection in `aiTick`.
- `pipeline/lib/mutations.ts` — add `abilities` to `MOB_BODY` (**register in the
  schema's master body, not just the create op**).
- `forge/lib/engine.ts` — ability-ref resolution check; `forge/tiers/tier2.ts`
  + `tier3.ts` — pool as content library + `abilities` in the mob skeleton.

## Build order (each step independently verifiable)

1. `stats.ts`: promote `effectiveStat` + add modifier term (no callers yet) →
   verify combat math unchanged with empty modifiers.
2. Ability data + registry load → verify a YAML ability loads.
3. `executeAbility` + `damage`/`heal` resolvers (no cost/cooldown yet) → verify a
   scripted `damage` ability deals scaled damage through the dodge path.
4. Resource + cooldown gate + mana regen → verify a costed ability drains and
   refuses when broke; regen refills out of combat.
5. `modifier` effect + tick (dot/hot, buff/debuff, `max_mana` bonus) → verify a
   slow debuff lowers effective speed and expires; a `+max_mana` modifier raises
   the cap.
6. `move` effect → verify a charge closes distance / knockback pushes.
7. Ability-0 migration → verify autoattack (melee STR + wand INT) is unchanged
   in feel and now flows through `executeAbility`.
8. Mob controller + 3 sample mobs (ranged, healer, enrager) → verify three
   visibly different fights.
9. Player `ability` action + minimal client wiring → verify a player casts.
10. `MOB_BODY.abilities` + forge ref-check → verify a generated mob with bad
    ability id fails validation; a good one passes.

## Out of scope (seams reserved)

- `summon` verb (new-entity ownership/leash/despawn).
- Resource types beyond mana (rage/energy); the `cost` map already allows them.
- Player ability UI/hotbar polish (server-first; minimal client wiring in v1).
- Targeting shapes beyond self/target/projectile/area (cone/line later).
- Accuracy affixes — blocked on Plan 4's to-hit layer.
</content>
</invoke>
