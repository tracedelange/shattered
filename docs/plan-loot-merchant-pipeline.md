# Plan 2 — Loot / merchant pipeline

**Priority:** second. Fixes the early-game loot hole and the "no merchants" gap.

## Goal

The pipeline can reliably place (a) level-appropriate drops on every combat mob
and (b) merchants that sell gear/potions.

## Background

There is **no dedicated item or merchant operator** today. `OPPORTUNITY_TYPES`
(`pipeline/lib/schemas.ts:40-49`) is: `zone_enhance, zone_connect, mob_populate,
prefab_create, quest_add, quest_refactor, lore_refactor, tile_create`. Item
bases are only created as a side effect of `mob_populate` (loot items) or
`quest_add` (collect_count items). Consequences:

- Loot only appears when a mob_populate opportunity happens to add it. Most
  early mobs (`rat`, `giant_rat`, `goblin`) drop coins + a broken `crude_knife`.
  The good gear (`iron_sword`, `warhammer`, full iron set) is gated behind
  `hobgoblin` / `hobgoblin_warlord` — mobs you can't reach because you die to
  L2s. **The loot curve has a hole exactly at the early game.**
- No merchant/vendor operator exists at all, so a merchant is currently
  impossible to author through the pipeline (despite `TradeMessage` /
  `TradeResponse` scaffolding in `shared/types.ts` + `server/index.ts` and
  `sell_value` on item bases).

## Two independent tracks — do A first (cheaper, unblocks survival)

### Track A — close the early-game loot hole (data + light pipeline)

1. **Fix `crude_knife.yaml`** — it's a `mainhand` weapon with no `base_damage`
   and no `scaling`, so equipping it gives the `[3,6]` fallback + zero scaling.
   Either give it real (weak) damage or demote it to vendor-trash.
   - verify: equipping it raises a fighter's damage above unarmed.

2. **Seed low-mob loot tables** — `rat`, `giant_rat`, `goblin`, `goblin_shaman`
   drop coins + the broken knife. Add `health_potion` (already functional,
   `server/index.ts:877-890`) and a low-tier weapon/armor base at modest chance.
   - verify: killing ~10 early mobs yields at least one usable weapon or potion.

3. **Strengthen `MOB_RULES`** (`pipeline/lib/prompts.ts:418-437`) so the
   implementor *must* give combat mobs a level-appropriate drop, and validate
   invented item bases against the zone level band (no damageless weapons, no
   `sword_of_heros` on a L2 rat).
   - verify: a new mob_populate run produces mobs whose drops match their level;
     validation rejects a weapon with no `base_damage`.

### Track B — merchant operator (new pipeline capability)

4. **Add a `merchant_add` opportunity type** — register in `OPPORTUNITY_TYPES`
   (`schemas.ts:40-49`), add a `TYPE_BLOCKS` entry + a `MERCHANT_RULES` block in
   `prompts.ts`. The gardener prompt is generated from the enum (automatic), but
   check `pipeline/lib/validate.ts` and `refValidate.ts` for places that
   enumerate types.
   - verify: a merchant_add opportunity round-trips through
     gardener → implementor → validation.

5. **Wire the vendor to existing trade scaffolding** — server already has
   `TradeMessage` / `TradeResponse` and `sell_value` on bases. Define how a
   merchant NPC carries a stock list (new field on the mob template, or a `shop`
   component) and have the trade handler read it. Inspect the existing buy/sell
   handler in `server/index.ts` first to scope how much already works.
   - verify: a placed merchant lets a player buy a potion and sell loot for gold.

## Scope

Track A is mostly data + prompt text (low risk). Track B is the bigger lift — a
new opportunity type touches schema, prompts, validation, **and** the server
trade handler.

## Dependencies

- Track A's potions/loot are most valuable *after* Plan 1 (otherwise you hand
  potions to a player who still can't fight).
- Plan 3 (affix/brand) only matters once this plan distributes loot.
