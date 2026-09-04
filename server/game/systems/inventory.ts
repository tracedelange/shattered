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
  // How this weapon attacks is a property of the base, not of the roll — a
  // staple bought off a shop shelf has no rolled item at all, and would
  // otherwise swing instead of bolting.
  if (base?.attack_ability) stack.attack_ability = base.attack_ability;
  if (typeof base?.base_speed === 'number') stack.base_speed = base.base_speed;
  if (base?.base_damage) stack.base_damage = base.base_damage;
  if (base?.scaling) stack.base_scaling = base.scaling;
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

/** Re-stamp the base/roll-derived fields across a loaded character's bags and
 *  worn gear, so a character saved before a field existed (or before its rule
 *  changed) is corrected on login rather than carrying stale data forever.
 *
 *  `sell_value` derives from the item's roll: characters saved before pricing
 *  read the roll carry the flat base value, which would show one number in the
 *  tooltip while the merchant paid another. `attack_ability` derives from the
 *  base: it tells the client how the worn weapon attacks, and a stale one makes
 *  the client walk a staff-wielder into melee for a bolt it could already fire.
 *  `base_speed`, `base_damage` and `base_scaling` likewise: they are how the
 *  client predicts the swing interval and the damage the server will actually
 *  compute, so a retuned weapon stops desyncing the two. */
export function refreshDerivedFields(player: PlayerEntity, defs: WorldDefs): void {
  const stacks = [...player.components.inventory.slots, ...EQUIPMENT_SLOTS.map((s) => player.components.equipment[s])];
  for (const stack of stacks) {
    if (!stack) continue;
    const price = sellPriceOf(stack, defs);
    if (price === null) delete stack.sell_value;
    else stack.sell_value = price;
    // Restamped, not just filled in, so a base retuned to attack differently
    // takes effect on gear players are already carrying.
    const itemBase = defs.itemBases[stack.base];
    const attack = itemBase?.attack_ability;
    if (attack) stack.attack_ability = attack;
    else delete stack.attack_ability;
    if (typeof itemBase?.base_speed === 'number') stack.base_speed = itemBase.base_speed;
    else delete stack.base_speed;
    if (itemBase?.base_damage) stack.base_damage = itemBase.base_damage;
    else delete stack.base_damage;
    if (itemBase?.scaling) stack.base_scaling = itemBase.scaling;
    else delete stack.base_scaling;
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
