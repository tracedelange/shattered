# Plan 4 — Combat skills & accuracy layer

**Priority:** after Plan 1 (the re-tune makes the game playable; this changes the
combat model and will force a re-tune of those numbers). Independent of Plan 2.

## Goal

Introduce a hit-chance layer driven by **use-trained, weapon-category skills**,
in the WoW Classic mould. Landing hits with a weapon type raises that skill,
which raises your future hit chance. Skill is measured **relative to the target's
level**, so a skill deficit against higher-level mobs causes misses — this is the
"punch up" gate that makes gear and skill (not just stats) the thing that lets
you fight above your level.

### Decisions locked

- **Affects:** hit chance only (no damage/speed scaling from skill — those can be
  layered later if desired).
- **Scaling:** level-relative (WoW-style). Your effective skill vs the mob's
  level/defense sets miss chance.
- **Training:** by use. Each landed hit has a chance to raise the skill used.

### Skill categories

`defense`, `unarmed`, `one_handed`, `two_handed`, `polearm`. Weapon categories
drive the attacker's accuracy; `defense` is the defender-side skill that makes
incoming attacks miss more often (trained by being hit).

## The key architectural fact

Combat currently has **no accuracy roll**. `resolveAttack` (`combat.ts:99-132`)
does one stochastic thing — the target's dodge check — then applies
`damage − defense`, floored at 1. Every non-dodged swing lands for full damage.
This plan introduces the to-hit roll the engine skips. That roll is the bulk of
the work; the skill numbers feed it.

## Steps

1. **Add a `skills` component to players.** Per-category skill values, in
   `shared/types.ts` (new `SkillsComponent`) and initialized in `makePlayer`
   (`entities.ts:33-62`). Cap each skill WoW-style at `5 × level` (so skill can't
   outrun level). Register the category list as a shared master array (e.g.
   `SKILL_CATEGORIES` in `shared/constants.ts`) — the to-hit code, training code,
   and client display all read it.
   - verify: a new player has all skills at a defined floor; cap rises on
     level-up.

2. **Tag each weapon base with its skill category.** Item bases
   (`world/entities/items/bases/*.yaml`) need a `skill_category` so the engine
   knows which skill a weapon trains/uses. Derive from existing `tags` if
   possible (e.g. `blade` + one-hand → `one_handed`), or add an explicit field.
   Unarmed (no weapon) maps to `unarmed`.
   - verify: equipping a sword reads `one_handed`; bare fists read `unarmed`.

3. **Add the to-hit roll to `resolveAttack`** — a new step *before* damage.
   Hit chance is a function of the attacker's effective weapon skill vs the
   target's level-derived defense. Proposed shape (all constants tunable):
   ```
   attackerSkill = skills[weaponCategory]        # capped at 5×level
   targetDefense = targetLevel × DEFENSE_PER_LEVEL + targetDefenseSkill
   hitChance     = clamp(BASE_HIT + K × (attackerSkill − targetDefense),
                         MIN_HIT, MAX_HIT)
   ```
   Mobs have no skills component — use `mob.level × 5` as their effective weapon
   skill, and their `defense` skill = `level × DEFENSE_PER_LEVEL`. Keep the
   existing dodge check as a separate layer or fold it in — decide during impl.
   - verify: same-level attacker lands most hits; a large skill deficit
     (low-skill player vs much higher mob) produces frequent misses; emit a
     `missed` flag on `AttackEvent` for the client.

4. **Use-based training.** On a landed hit, roll a chance to increment the
   weapon category used (attacker side) and the `defense` skill (defender side,
   when a player is struck). Diminishing chance as skill approaches the
   `5 × level` cap so it self-limits.
   - verify: repeatedly hitting a training dummy raises one-handed skill and
     observably improves hit rate over time; getting hit raises defense.

5. **Surface it.** Add `skills` to the player snapshot (`world.ts` snapshot
   builder, ~`world.ts:390-414`) and a client display. Emit miss events so the
   client can show "miss".
   - verify: client shows skill values and miss feedback.

6. **Re-tune against the new model.** With accuracy in play, Plan 1's TTK math
   shifts (misses lengthen fights, skill deficits gate punch-up). Re-run the sim
   with the hit-roll included and re-anchor mob HP / player damage.
   - verify: parity 1v1 still matches the TTK anchor *after* accounting for miss
     rate; higher-level mobs are gated by skill deficit as intended.

## Open tuning knobs (decide during impl)

- `BASE_HIT`, `MIN_HIT`, `MAX_HIT`, `K`, `DEFENSE_PER_LEVEL` — the accuracy curve.
- Skill gain chance per hit and its falloff near the cap.
- Whether dodge stays a separate roll or merges into the miss calc.

## Scope

Meaningful: new component + master registry, item base tagging, a new combat
roll, training hooks, snapshot + client wiring, and a re-tune. Touches
`shared/types.ts`, `shared/constants.ts`, `entities.ts`, `combat.ts`, `world.ts`,
item base YAML, and the client.

## Dependencies

- **Plan 1 first** — get the game playable under the current model, then add this
  layer and re-tune.
- **Feeds Plan 3 step 6** — once accuracy exists, gear can roll accuracy /
  weapon-skill affixes, giving gear an explicit lever on the punch-up axis.

## Out of scope (for now)

- Skill affecting damage or attack speed (DCSS-style) — possible later.
- Crit / glancing-blow / parry / block as separate mechanics — WoW has them, but
  start with hit/miss only.
