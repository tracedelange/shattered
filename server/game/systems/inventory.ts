import { EQUIPMENT_SLOTS, makeGroundItem } from '../entities.ts';
import { findDropTile } from './loot.ts';
import { sellPriceOf } from '../items/pricing.ts';
import type {
  Equipment, EquipSlot, InventoryStack, ItemEntity, PlayerEntity, WorldDefs,
} from '../../../shared/types.ts';
import type { World } from '../world.ts';

/** Build the inventory stack for an item. The single place stacks are made, so
 *  every route into a player's bags (ground pickup, corpse loot, a purchase,
 *  /give) stamps the same display fields — in particular `sell_value`, which is
 *  the item's actual sale price and so depends on its roll, not on its base
 *  alone (see pricing.ts). Corpse loot used to skip both it and `item_slot`
 *  entirely, which is how the main source of rolled gear ended up showing a 1g
 *  tooltip and reading as sellable even when it was a quest item. */
export function makeStack(
  defs: WorldDefs,
  baseId: string,
  item: ItemEntity | null,
  overrides: { name?: string; sprite?: string } = {},
): InventoryStack {
  const base = defs.itemBases[baseId];
  const stack: InventoryStack = {
    base: baseId,
    item,
    name: overrides.name || base?.name || baseId,
    sprite: overrides.sprite || base?.sprite || 'item_misc',
    item_slot: base?.slot,
  };
  const price = sellPriceOf(stack, defs);
  if (price !== null) stack.sell_value = price;
  return stack;
}

function resolveEquipSlot(baseSlot: string, equipment: Equipment): EquipSlot | null {
  if (baseSlot === 'ring') {
    if (!equipment.ring1) return 'ring1';
    if (!equipment.ring2) return 'ring2';
    return 'ring1';
  }
  if ((EQUIPMENT_SLOTS as readonly string[]).includes(baseSlot)) return baseSlot as EquipSlot;
  return null;
}

export interface PickupResult {
  kind: 'gold' | 'item';
  name: string;
  amount?: number;
  slot?: number;
  base?: string;   // item base id; only set for kind: 'item'
}

export function pickupGroundItemsAt(world: World, player: PlayerEntity): PickupResult[] {
  const { zone, x, y } = player.position;
  const items = world.groundItemsAt(zone, x, y);
  const picked: PickupResult[] = [];
  for (const g of items) {
    if (g.gold > 0) {
      player.components.wallet.gold = (player.components.wallet.gold || 0) + g.gold;
      world.removeEntity(g.id);
      picked.push({ kind: 'gold', amount: g.gold, name: g.name });
      continue;
    }
    const slots = player.components.inventory.slots;
    const slot = slots.findIndex(s => !s);
    if (slot === -1) continue;
    slots[slot] = makeStack(world.defs, g.base, g.item, { name: g.name, sprite: g.sprite });
    world.removeEntity(g.id);
    picked.push({ kind: 'item', name: g.name, slot, base: g.base });
  }
  return picked;
}

/** Re-stamp `sell_value` across a loaded character's bags and worn gear. The
 *  field is a pure derivative of the item's roll, and characters saved before
 *  pricing read the roll carry the flat base value — which would show one
 *  number in the tooltip while the merchant paid another. */
export function refreshSellValues(player: PlayerEntity, defs: WorldDefs): void {
  const stacks = [...player.components.inventory.slots, ...EQUIPMENT_SLOTS.map((s) => player.components.equipment[s])];
  for (const stack of stacks) {
    if (!stack) continue;
    const price = sellPriceOf(stack, defs);
    if (price === null) delete stack.sell_value;
    else stack.sell_value = price;
  }
}

export interface OpResult { ok: boolean; reason?: string; equipSlot?: EquipSlot }

export function equipFromSlot(player: PlayerEntity, slotIndex: number, defs: WorldDefs): OpResult {
  const slots = player.components.inventory.slots;
  const stack = slots[slotIndex];
  if (!stack) return { ok: false, reason: 'empty_slot' };
  const base = defs.itemBases[stack.base];
  if (!base) return { ok: false, reason: 'unknown_base' };
  const equipSlot = resolveEquipSlot(base.slot, player.components.equipment);
  if (!equipSlot) return { ok: false, reason: 'not_equipable' };

  const prev = player.components.equipment[equipSlot];
  player.components.equipment[equipSlot] = stack;
  slots[slotIndex] = prev as InventoryStack | null;
  return { ok: true, equipSlot };
}

/** Removes up to `count` inventory stacks matching `base`. Returns how many were removed. */
export function removeItemsByBase(player: PlayerEntity, base: string, count: number): number {
  const slots = player.components.inventory.slots;
  let removed = 0;
  for (let i = 0; i < slots.length && removed < count; i++) {
    if (slots[i]?.base === base) { slots[i] = null; removed++; }
  }
  return removed;
}

/** Drops the inventory stack at `slotIndex` onto the ground at the player's feet
 *  (or the nearest free tile if one is already occupied). */
export function dropFromSlot(world: World, player: PlayerEntity, slotIndex: number): OpResult {
  const slots = player.components.inventory.slots;
  const stack = slots[slotIndex];
  if (!stack) return { ok: false, reason: 'empty_slot' };
  const { zone, x, y } = player.position;
  const tile = findDropTile(world, zone, x, y);
  const base = world.defs.itemBases[stack.base];
  world.addEntity(makeGroundItem({
    zone,
    x: tile.x,
    y: tile.y,
    base: stack.base,
    sprite: stack.sprite || base?.sprite,
    name: stack.name,
    item: stack.item,
  }));
  slots[slotIndex] = null;
  return { ok: true };
}

export function unequipSlot(player: PlayerEntity, equipSlot: EquipSlot): OpResult {
  if (!(EQUIPMENT_SLOTS as readonly string[]).includes(equipSlot)) return { ok: false, reason: 'unknown_slot' };
  const eq = player.components.equipment[equipSlot];
  if (!eq) return { ok: false, reason: 'nothing_equipped' };
  const slots = player.components.inventory.slots;
  const slot = slots.findIndex(s => !s);
  if (slot === -1) return { ok: false, reason: 'inventory_full' };
  slots[slot] = eq;
  player.components.equipment[equipSlot] = null;
  return { ok: true };
}
