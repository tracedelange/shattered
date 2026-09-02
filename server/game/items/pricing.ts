// What a merchant pays for an item. The price is the base's hand-tuned
// `sell_value` (what a plain example of that base is worth) plus a cut of the
// item's *rolled budget* — the gold worth of everything the affix roll put on
// top of the base. See docs/plan-loot-merchant-pipeline.md.
//
// Pricing off the roll is what makes loot a real gold source: base value alone
// is identical for every copy of a base, and jewelry has no base stats at all,
// so a legendary gold ring and a common one fetched the same coin. Selling is
// the faucet the ability-rank prices (`cost_gold`) and shop prices are tuned
// against, so it has to scale with the loot curve the way the loot does.

import { AFFIX_SELL_RATE, DEFAULT_STAT_SELL_WORTH, STAT_SELL_WORTH } from '../../../shared/constants.ts';
import type { InventoryStack, ItemBase, Range, RolledStats, WorldDefs } from '../../../shared/types.ts';

// Slots a merchant won't take. Quest items are progress, not property; currency
// is already gold.
const UNSELLABLE_SLOTS = new Set(['quest', 'currency']);

// RolledStats keys that aren't affix output: damage/defense/speed carry the
// base's own profile and are priced as a delta against it below, and
// scaling/weapon_brand aren't numeric.
const NON_AFFIX_KEYS = new Set(['damage', 'defense', 'speed', 'scaling', 'weapon_brand']);

function mid(r: Range | null | undefined): number {
  return Array.isArray(r) ? (r[0] + r[1]) / 2 : 0;
}

function worthOf(stat: string): number {
  return STAT_SELL_WORTH[stat] ?? DEFAULT_STAT_SELL_WORTH;
}

/** The gold worth of what an item's roll added on top of its base — its rolled
 *  budget. Damage, defense and speed are priced as the delta over the base's own
 *  profile (generateItem seeds `rolled` from the base, then folds affix
 *  damage_bonus/defense_bonus straight into those ranges, so the delta *is* the
 *  affix contribution); every other numeric key on `rolled` came from an affix
 *  and is priced outright. Exported for the loot-lab tuning tool. */
export function rolledBudget(rolled: RolledStats, base: ItemBase): number {
  let budget = 0;
  budget += Math.max(0, mid(rolled.damage) - mid(base.base_damage)) * worthOf('damage_bonus');
  budget += Math.max(0, mid(rolled.defense) - mid(base.base_defense)) * worthOf('defense_bonus');
  const speed = typeof rolled.speed === 'number' ? rolled.speed : 0;
  budget += Math.max(0, speed - (base.base_speed ?? 0)) * worthOf('speed');
  for (const [stat, value] of Object.entries(rolled)) {
    if (NON_AFFIX_KEYS.has(stat) || typeof value !== 'number') continue;
    // Clamped at 0 so a debuff-shaped stat can never price an item below its base.
    budget += Math.max(0, value) * worthOf(stat);
  }
  return budget;
}

/** What a merchant pays for this stack, or null if it isn't sellable at all
 *  (quest/currency slots, or a base that no longer exists). Authoritative: the
 *  trade handler recomputes with this rather than trusting the price stamped on
 *  the stack, which is only there for the client to display. */
export function sellPriceOf(stack: InventoryStack, defs: WorldDefs): number | null {
  const base = defs.itemBases[stack.base];
  if (!base || UNSELLABLE_SLOTS.has(base.slot)) return null;
  const rolled = stack.item?.components?.equipment?.rolled;
  const budget = rolled ? rolledBudget(rolled, base) : 0;
  return Math.max(1, Math.round((base.sell_value ?? 0) + budget * AFFIX_SELL_RATE));
}
