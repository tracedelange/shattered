// A merchant's rotating high-end shelf. The staple `shop` array is fixed bases
// at fixed prices in unlimited supply; this is the opposite of that — a handful
// of individually *rolled* items, one copy each, re-rolled on a wall-clock
// cadence and priced off what they actually rolled.
//
// Rotation is the point: a shelf you can exhaust and then must wait on is a
// reason to come back, and a reason for gold to have somewhere to go once the
// staple stock is bought out.
//
// Windows are aligned to the epoch (floor(now / PERIOD)), not to server start,
// so every merchant turns over at the same instant and the countdown the client
// draws is the true one. A shelf is rolled lazily on first read in a window and
// cached until the window ends, which also means every player sees the same
// stock without any of them having to trigger it.
//
// The shelf is deliberately NOT persisted: a restart re-rolls the current
// window's items (the countdown stays correct, since it's derived from the
// clock). Making it survive a restart means seeding the roll deterministically,
// which the generator's Math.random() calls don't currently support.

import { generateItem, pickDropBase, resolveItemName, rollRange, AFFINITY_TAGS } from './generator.ts';
import { featuredPriceOf } from './pricing.ts';
import { makeStack } from '../systems/inventory.ts';
import {
  FEATURED_BASE_TIER_FLOOR, FEATURED_LEGENDARY_CHANCE, FEATURED_STOCK_PERIOD_MS,
} from '../../../shared/constants.ts';
import type { FeaturedStockEntry, FeaturedStockSpec, WorldDefs } from '../../../shared/types.ts';

interface Shelf { window: number; entries: FeaturedStockEntry[] }

// merchant template id -> its shelf for the current window.
const shelves = new Map<string, Shelf>();

/** The refresh window `now` falls in. */
function windowOf(now: number): number {
  return Math.floor(now / FEATURED_STOCK_PERIOD_MS);
}

/** Epoch ms at which the current window ends and every shelf re-rolls. */
export function featuredRefreshAt(): number {
  return (windowOf(Date.now()) + 1) * FEATURED_STOCK_PERIOD_MS;
}

// pickDropBase treats affinity as a soft weight and every base under the ilvl
// as eligible — right for loot, wrong for a shelf. A weaponsmith showing a pair
// of greaves reads as a bug, and a crude dagger carrying great affixes reads as
// one too: a featured item should be MADE of something worthy of its item
// level, not merely enchanted up to it.
//
// Reject-sample the same picker against both conditions rather than forking it.
// Bounded, and it falls back to the first pick, so a shelf whose affinity has
// no eligible base at this ilvl still yields something instead of looping.
const FEATURED_TRIES = 12;
function pickFeaturedBase(defs: WorldDefs, ilvl: number, affinity: string[]) {
  const wanted = new Set(affinity.flatMap((a) => AFFINITY_TAGS[a] ?? []));
  const tierFloor = ilvl * FEATURED_BASE_TIER_FLOOR;
  let anyPick = null, onAffinity = null;
  for (let i = 0; i < FEATURED_TRIES; i++) {
    const base = pickDropBase(defs, ilvl, { affinity });
    if (!base) return null;
    anyPick ??= base;
    if (wanted.size > 0 && !base.tags.some((t) => wanted.has(t))) continue;
    onAffinity ??= base;
    if ((base.min_ilvl ?? 1) >= tierFloor) return base;
  }
  // Out of tries. Affinity is the shop's identity and the tier floor is only a
  // quality preference, so give up the floor first — an under-tier weapon at
  // the weaponsmith beats a perfectly-tiered helmet.
  return onAffinity ?? anyPick;
}

function rollEntry(defs: WorldDefs, spec: FeaturedStockSpec, index: number, window: number): FeaturedStockEntry | null {
  const ilvl = rollRange(spec.ilvl);
  const base = pickFeaturedBase(defs, ilvl, spec.affinity);
  if (!base) return null;
  const rarity = Math.random() < FEATURED_LEGENDARY_CHANCE ? 'legendary' : 'rare';
  const item = generateItem({ baseId: base.id, defs, rarity, ilvl });
  if (!item) return null;
  // The shelf holds the very stack the buyer receives, rather than a
  // description of one: name, sprite, slot and sell_value are then whatever
  // makeStack says they are, and the purchase is a slot assignment.
  const stack = makeStack(defs, base.id, item, { name: resolveItemName(item, defs) });
  return {
    // Window-scoped so a client holding a stale shelf can't buy into the new one.
    id: `${window}:${index}:${item.id}`,
    price: featuredPriceOf(stack, defs),
    ilvl,
    stack,
  };
}

/** This merchant's shelf for the current window, rolling it if this is the
 *  first read of the window. Empty for a merchant with no featured_stock.
 *
 *  Returns the LIVE cached array: each roll is a single copy, so a sale is a
 *  splice out of what this returns. */
export function featuredStockFor(defs: WorldDefs, templateId: string): FeaturedStockEntry[] {
  const spec = defs.mobs[templateId]?.featured_stock;
  if (!spec || spec.count <= 0) return [];
  const window = windowOf(Date.now());
  const cached = shelves.get(templateId);
  if (cached && cached.window === window) return cached.entries;
  const entries: FeaturedStockEntry[] = [];
  for (let i = 0; i < spec.count; i++) {
    const entry = rollEntry(defs, spec, i, window);
    if (entry) entries.push(entry);
  }
  shelves.set(templateId, { window, entries });
  return entries;
}

