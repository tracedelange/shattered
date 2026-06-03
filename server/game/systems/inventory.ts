import { EQUIPMENT_SLOTS } from '../entities.ts';
import type {
  Equipment, EquipSlot, InventoryStack, PlayerEntity, WorldDefs,
} from '../../../shared/types.ts';
import type { World } from '../world.ts';

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
    const itemBase = world.defs.itemBases[g.base];
    slots[slot] = { base: g.base, item: g.item, name: g.name, sprite: g.sprite, sell_value: itemBase?.sell_value, item_slot: itemBase?.slot };
    world.removeEntity(g.id);
    picked.push({ kind: 'item', name: g.name, slot, base: g.base });
  }
  return picked;
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
