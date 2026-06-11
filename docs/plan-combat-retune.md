# Plan 1 — Combat re-tune

**Priority:** highest. Fixes the core "level doesn't matter" bug — a L3 player
currently loses to almost every L2 mob.

## Goal

A level-N player at stat parity can win a 1v1 against a same-level skirmisher on
stats alone — slowly and at real cost (~5–6 hits to kill, ~8–10 to die). Gear is
the **multiplier**, not a prerequisite: it lets you kill faster, survive 2–3
mobs at once, and punch up against higher-level mobs. Losing to a higher-level
mob while unarmed is correct behavior, not a bug.

This follows the WoW Classic / OSRS model (level + skill as the spine, gear as
the multiplier), not the Diablo model (gear-gated viability).

> **Note:** A hit-chance / weapon-skill layer is coming in Plan 4. Today combat
> has **no accuracy roll** — every non-dodged swing lands. Do this re-tune with
> that in mind: once the to-hit layer exists, TTK changes and these numbers get
> re-tuned. Tune for the *current* model now to make the game playable, but
> don't over-fit.

## Root cause (why it's broken today)

1. **Unarmed players get zero stat scaling.** `combat.ts:52-63` (`rollDamage`)
   derives a player's damage bonus *only* from the equipped weapon's `scaling`
   field. With no weapon, `weaponRolled()` returns `null` and `scaledBonus`
   returns 0 — so a fighter's STR 8–10 contributes nothing and damage is a flat
   `[3,6]` regardless of stats or level. Mobs (`combat.ts:56-58`) always get
   `strength × 0.4` baked in, so mobs scale with level and players don't.

2. **Mob HP uses the player HP formula.** `constants.ts:90`:
   `(100 + (con-5)×10) × role.hp`. The ~100 HP floor makes a trivial L2
   skirmisher a 72 HP sponge against 3–6 unarmed damage.

## Steps

1. **Unarmed stat scaling** — `combat.ts:52-63` (`rollDamage`).
   When no weapon is equipped, fall back to `strength × SCALING_COEFFS['C']`
   (mirror the existing mob branch), or a class-appropriate stat.
   - verify: a STR-10 fighter unarmed rolls ~7–10, not 3–6.

2. **Lower the mob HP floor** — `constants.ts:86-96` (`mobStats`).
   Replace the `100 + (con-5)×10` base (borrowed from the player formula) with
   something like `40 + con×k`, scaled by `role.hp`. Re-derive the role HP
   multipliers so a L2 skirmisher lands ~30–40 HP, not 72.
   - verify: re-run the TTK sim; L2 skirmisher/brute become wins for a L3
     player, tank stays hard, pest trivial.

3. **Set the TTK anchor explicitly.** Before touching numbers, pin the target
   ratio (kills-in-N / dies-in-M at level parity) as a comment or constant so
   future tuning has a reference. Tune mob HP and unarmed damage *to that
   anchor*, not by feel.
   - verify: sim across levels 1–10 and roles shows M > N at parity for
     non-tank roles.

4. **Sanity-check armor doesn't over-correct.** After steps 1–2, re-run the sim
   with a full iron set equipped (~14–19 flat reduction averaged in
   `totalDefense`, `combat.ts:71-87`) to confirm geared players don't become
   unkillable vs same-level mobs.
   - verify: geared L5 vs L5 skirmisher still takes a few hits; mobs aren't
     reduced to 1-damage chip.

## Scope

~2 files (`combat.ts`, `constants.ts`), no schema/data changes. The risky part
is re-deriving `MOB_ROLES` / `MOB_ROLE_STATS` multipliers — do it against the
sim, not by eye. Tank role (`hp: 2.0`) is the outlier and needs a manual check.

## Out of scope

- Dodge rework (`dex × 0.01` is a dead stat early — leave it).
- Per-class unarmed flavor.

## Dependencies

None. This is the foundation; do it first. Plan 2's potions/loot are most
valuable *after* this lands.
