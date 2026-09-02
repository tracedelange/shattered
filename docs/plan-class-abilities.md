# Plan 6 — Class abilities, trainers & guild halls

**Status:** design agreed 2026-06-26. Builds on Plan 5 (abilities executor,
status effects, mana — all landed). This is the **player-facing** ability layer:
class-bound kits, level-gated learning, gold-purchased rank upgrades, and the
trainer NPCs / guild halls that sell them.

## Goal

A player learns a small, class-locked kit of active abilities. Each class starts
with its basic attack (ability 0) plus one auto-known starter skill, and buys the
rest — and their rank upgrades — from a **class trainer** in a starting-village
guild hall. Class becomes a permanent identity, not just a starting stat lean.

Verifiable "done": a fresh Fighter spawns knowing exactly one starter skill,
walks into the Fighter guild hall, is **refused** a Wizard ability, is refused an
ability above their level or beyond their gold, successfully buys a rank-2 upgrade
that visibly hits harder, and casts it from the hotbar.

## Decisions locked (this conversation)

- **Hard class gating.** Every player ability carries `class: fighter | rogue |
  wizard | global`. A trainer teaches only its own class's set; `global`
  abilities are the cross-class exception (utility, sold everywhere). Mob
  abilities are untouched.
- **Class is permanent.** No respec in v1 (seam noted; add later).
- **Upgrades are ranks 1–3, power only.** Rank raises the `base` of `damage` /
  `heal` effects via a `power_mult`. Cooldown, cost, range, and shape are fixed
  across ranks. One tuning knob.
- **"Grows with level" is emergent, not a third system.** Abilities already scale
  off live stats through the existing `scaling` grade map (`SCALING_COEFFS`). As
  stats rise on level-up, abilities get stronger for free. We add **no** per-level
  multiplier on top of rank + stat scaling.
- **Cost = gold AND level.** Each rank has both `cost_gold` and `requires_level`.
  Gold is the sink (per `TODO.md` roadmap); level is the pacing guardrail.
- **Starter kit per class:** basic attack (ability 0, universal code constant) +
  **one** starter skill auto-known at rank 1, level 1, cost 0. Two more
  purchasable per class, plus ~2 global abilities. (3 class + ~2 global authored
  for v1.)
- **Hotbar = 10 slots.** Slot 0 is the basic attack. Known abilities auto-equip
  into the next free slot on learn (v1). Consumable/slot customization is later
  work.
- **Author fresh player abilities.** The 5 existing abilities (`gore_charge`,
  `venom_bite`, `ember_spit`, `rallying_roar`, `mending_touch`) are mob-only;
  tag them `actor: mob`. `STARTER_ABILITIES` (the global flat list in
  `shared/constants.ts:50`) is removed.

## Model spine

### 1. Schema additions — `AbilityDef` (`shared/types.ts` + `ability_schema.ts`)

New optional fields (mob abilities omit the player-only ones):

```yaml
id: power_strike
name: "Power Strike"
actor: player                 # player | mob | any   (default 'any'; existing 5 -> mob)
class: fighter                # fighter | rogue | wizard | global  (player abilities only)
targeting: { shape: target, range: 1 }
cast: { cost: { mana: 0 }, cooldown_ticks: 30 }
effects:
  - kind: damage
    base: [6, 10]
    scaling: { strength: B }
ranks:                        # rank 1 == the effects above at power_mult 1.0
  - { rank: 1, requires_level: 1, cost_gold: 0,   power_mult: 1.0 }   # starter: free, auto-known
  - { rank: 2, requires_level: 4, cost_gold: 150, power_mult: 1.4 }
  - { rank: 3, requires_level: 8, cost_gold: 400, power_mult: 1.8 }
```

- `power_mult` scales the `base` range of every `damage`/`heal` effect (and a
  `modifier`'s `tick_effect` base) at resolve time. Nothing else.
- Validator: `class` required when `actor: player`; `ranks` strictly ascending
  `requires_level` and `cost_gold`; rank 1 present. Reuse the existing zod gate.
- **Master registry:** the ability loader (`server/world/loader.ts:189-221`)
  already globs `world/abilities/*.yaml` — no registry array to update, but the
  forge engine ref-check (Plan 5 follow-on) should learn `actor`/`class`.

### 2. `knownAbilities` component + persistence

- `PlayerEntity.components.knownAbilities: Record<string, number>` (id → current
  rank). Add beside `modifiers` in `shared/types.ts:141-151`.
- **Persist** as a new `known_abilities_json` column on the `characters` table
  (mirror `quests_json` exactly — `server/db/index.ts`: `StoredCharacterRow`,
  `upsertCharacterStmt`, `rowParams`, and the load mapper). One additive
  migration (`ALTER TABLE characters ADD COLUMN known_abilities_json TEXT`), with
  a NULL→`{}` fallback in `rowParams`.

### 3. Starter-kit grant at character creation

- Where the player entity is built from a new character (`server/game/entities.ts`
  / creation path in `server/index.ts`), seed `knownAbilities` with that class's
  starter ability at rank 1. Drive it from a `CLASS_STARTERS: Record<ClassId,
  string>` constant in `shared/constants.ts` (replaces `STARTER_ABILITIES`).

### 4. Hotbar (10 slots)

- `PlayerEntity.hotbar: (string | null)[]` length 10; slot 0 = basic attack
  (ability 0). On learn, fill the first free slot with the new ability id (v1
  auto-equip). Persist alongside `knownAbilities` (same JSON column or a sibling).
- Client binds number keys 1–0 to slots; the server `ability` action already
  resolves by ability id, so this is a lookup change, not a new path.

### 5. Power-by-rank in the executor

- `executeAbility` (`server/game/systems/abilities.ts`) gains a rank lookup: for a
  **player** actor, `rank = knownAbilities[id] ?? 0` (0 ⇒ refuse: not learned),
  and the matching `ranks[].power_mult` multiplies the `base` of each
  `damage`/`heal` resolver. Mob abilities (no `ranks`) default `power_mult 1.0`.
- Add `not_learned` to the existing `CastFailure` union.

### 6. Trainer interaction (sibling to the merchant `trade` path)

- **Mob template:** `trainer: { class: ClassId }` on `MobTemplate` (parallels
  `shop`). The offered list is computed: every ability where `ability.class ===
  trainer.class`, plus all `class: global` abilities.
- **Two socket events**, modeled on the `trade` handler (`server/index.ts:856`):
  - `train_list { mobId }` → for each offered ability: id, name, current rank,
    next rank's `requires_level` + `cost_gold`, and a `locked` reason if any.
  - `train { mobId, abilityId }` → validate, in order: proximity (reuse the
    dist ≤ 2 + same-zone check), **class match** (`player.klass ===
    ability.class || ability.class === 'global'`), there *is* a next rank,
    `progress.level >= nextRank.requires_level`, `wallet.gold >=
    nextRank.cost_gold`. On success: deduct gold, bump `knownAbilities[id]`,
    auto-equip if newly learned, `emitToEntity('self')`, ack `{ ok, self }`.
- Refusal reasons: `wrong_class`, `under_level`, `insufficient_gold`,
  `max_rank`, `out_of_range` — same ack shape as `trade`.

### 7. Guild halls + trainers (content)

- Three trainer mobs: `fighter_trainer`, `rogue_trainer`, `wizard_trainer`
  (`role: npc`, `speed: 0`, `trainer: { class: … }`), reusing the merchant NPC
  pattern (`world/entities/mobs/trapper.yaml`).
- Three guild-hall prefabs stamped into the starting village (`zone_0_0`) — the
  first authored interior prefabs, and a good shake-out for the "complex prefab"
  appetite. Use `/new-zone-feature` or the prefab stamp post-op already used for
  entrances.

## Files

- `shared/types.ts` — `AbilityDef` (`actor`, `class`, `ranks`); `AbilityRank`;
  `knownAbilities` + `hotbar` on `PlayerEntity`; `trainer` on `MobTemplate`;
  `TrainMessage`/`TrainListResponse` socket types.
- `shared/constants.ts` — remove `STARTER_ABILITIES`; add `CLASS_STARTERS`,
  `HOTBAR_SLOTS = 10`.
- `server/world/ability_schema.ts` — validate the new fields.
- `server/db/index.ts` — `known_abilities_json` (+ `hotbar`) column, migration,
  round-trip mapping.
- `server/game/entities.ts` / `server/index.ts` — starter-kit grant at creation;
  `train` / `train_list` handlers.
- `server/game/systems/abilities.ts` — rank → `power_mult` in damage/heal
  resolvers; `not_learned` gate.
- `world/abilities/*.yaml` — tag the 5 existing as `actor: mob`; author 3 player
  abilities per class + ~2 global.
- `world/entities/mobs/{fighter,rogue,wizard}_trainer.yaml`; guild-hall prefabs +
  `zone_0_0` stamps.
- Client — hotbar binds 10 slots; trainer UI reuses the merchant shell.

## Build order (each step independently verifiable)

1. **Schema + validator** (`actor`/`class`/`ranks`); tag the 5 mob abilities
   `actor: mob`. → world still loads; a player ability YAML validates.
2. **`knownAbilities` component + DB column + migration.** → a character with a
   seeded known ability round-trips through save/load.
3. **Starter-kit grant** (`CLASS_STARTERS`). → a new Fighter spawns knowing its
   starter at rank 1; Rogue/Wizard know theirs.
4. **Hotbar (10 slots)**, replace `STARTER_ABILITIES`, auto-fill from known. →
   hotbar shows basic attack + starter; number keys cast them.
5. **Power-by-rank in `executeAbility`** + `not_learned` gate. → an unlearned
   ability refuses; a manually-set rank-2 hits ~`power_mult`× harder than rank-1.
6. **`train_list` + `train` handlers.** → off-class refused (`wrong_class`),
   under-level refused, broke refused, max-rank refused; a valid buy deducts
   gold, bumps rank, auto-equips.
7. **Author player abilities** (3×3 class + ~2 global). → all load, resolve, and
   scale by their stat grade.
8. **Trainers + guild halls in `zone_0_0`.** → walk in, open trainer, buy an
   upgrade, cast it. End-to-end loop closed.

## Out of scope (seams reserved)

- Respec / class reroll.
- Hotbar slot reassignment + consumable slots (auto-equip only in v1).
- Ranks affecting cooldown / cost / range (power only).
- Multiclass; abilities trained from multiple class sets.
- Forge cascade: teaching Tier 2/3 the `actor`/`class` vocabulary and the engine
  ref-check that player abilities resolve — a Plan 5 follow-on, noted not built.
