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

import { generateItem, pickDropBase, resolveItemName, AFFINITY_TAGS } from './generator.ts';
import { featuredPriceOf } from './pricing.ts';
import {
  FEATURED_BASE_TIER_FLOOR, FEATURED_RARITY_WEIGHTS, FEATURED_STOCK_PERIOD_MS,
} from '../../../shared/constants.ts';
import type {
  FeaturedStockEntry, FeaturedStockSpec, InventoryStack, Rarity, WorldDefs,
} from '../../../shared/types.ts';

interface Shelf { window: number; entries: FeaturedStockEntry[] }

// merchant template id -> its shelf for the current window.
const shelves = new Map<string, Shelf>();

/** The refresh window `now` falls in. */
function windowOf(now: number): number {
  return Math.floor(now / FEATURED_STOCK_PERIOD_MS);
}

/** Epoch ms at which the current window ends and every shelf re-rolls. */
export function featuredRefreshAt(now: number = Date.now()): number {
  return (windowOf(now) + 1) * FEATURED_STOCK_PERIOD_MS;
}

function rollRarity(): Rarity {
  const total = FEATURED_RARITY_WEIGHTS.reduce((a, w) => a + w.weight, 0);
  let r = Math.random() * total;
  for (const w of FEATURED_RARITY_WEIGHTS) {
    r -= w.weight;
    if (r <= 0) return w.rarity;
  }
  return FEATURED_RARITY_WEIGHTS[FEATURED_RARITY_WEIGHTS.length - 1]!.rarity;
}

function randIn([lo, hi]: [number, number]): number {
  return lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
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
  const ilvl = randIn(spec.ilvl);
  const base = pickFeaturedBase(defs, ilvl, spec.affinity);
  if (!base) return null;
  const item = generateItem({ baseId: base.id, defs, rarity: rollRarity(), ilvl });
  if (!item) return null;
  const stack: InventoryStack = { base: base.id, item, name: '', sprite: '' };
  return {
    // Window-scoped so a client holding a stale shelf can't buy into the new one.
    id: `${window}:${index}:${item.id}`,
    base: base.id,
    name: resolveItemName(item, defs),
    sprite: base.sprite ?? 'item_misc',
    slot: base.slot,
    price: featuredPriceOf(stack, defs),
    ilvl,
    rarity: item.components.equipment.rarity ?? 'common',
    item,
  };
}

/** This merchant's shelf for the window `now` falls in, rolling it if this is
 *  the first read of the window. Empty for a merchant with no featured_stock. */
export function featuredStockFor(defs: WorldDefs, templateId: string, now: number = Date.now()): FeaturedStockEntry[] {
  const spec = defs.mobs[templateId]?.featured_stock;
  if (!spec || spec.count <= 0) return [];
  const window = windowOf(now);
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

/** Remove and return one featured entry — a sale. Each roll is a single copy,
 *  so a bought row is gone until the shelf turns over. Returns null if the id
 *  isn't on the current shelf (already sold, or from a stale window). */
export function takeFeatured(
  defs: WorldDefs, templateId: string, entryId: string, now: number = Date.now(),
): FeaturedStockEntry | null {
  const entries = featuredStockFor(defs, templateId, now);
  const i = entries.findIndex((e) => e.id === entryId);
  if (i === -1) return null;
  return entries.splice(i, 1)[0]!;
}
