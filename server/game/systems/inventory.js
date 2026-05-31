import { EQUIPMENT_SLOTS } from '../entities.js';

// 'ring' fans out to ring1 then ring2; otherwise base.slot maps 1:1.
function resolveEquipSlot(baseSlot, equipment) {
  if (baseSlot === 'ring') {
    if (!equipment.ring1) return 'ring1';
    if (!equipment.ring2) return 'ring2';
    return 'ring1';
  }
  if (EQUIPMENT_SLOTS.includes(baseSlot)) return baseSlot;
  return null;
}

// Walking onto a ground item picks it up. Currency goes to wallet.gold;
// items go into the first free inventory slot. If full, the item stays.
export function pickupGroundItemsAt(world, player) {
  const { zone, x, y } = player.position;
  const items = world.groundItemsAt(zone, x, y);
  const picked = [];
  for (const g of items) {
    if (g.gold > 0) {
      player.components.wallet.gold = (player.components.wallet.gold || 0) + g.gold;
      world.removeEntity(g.id);
      picked.push({ kind: 'gold', amount: g.gold, name: g.name });
      continue;
    }
    const slots = player.components.inventory.slots;
    const slot = slots.findIndex(s => !s);
    if (slot === -1) continue; // inventory full — leave item on the ground
    slots[slot] = { base: g.base, item: g.item, name: g.name, sprite: g.sprite };
    world.removeEntity(g.id);
    picked.push({ kind: 'item', name: g.name, slot });
  }
  return picked;
}

export function equipFromSlot(player, slotIndex, defs) {
  const slots = player.components.inventory.slots;
  const stack = slots[slotIndex];
  if (!stack) return { ok: false, reason: 'empty_slot' };
  const base = defs.itemBases[stack.base];
  if (!base) return { ok: false, reason: 'unknown_base' };
  const equipSlot = resolveEquipSlot(base.slot, player.components.equipment);
  if (!equipSlot) return { ok: false, reason: 'not_equipable' };

  const prev = player.components.equipment[equipSlot];
  player.components.equipment[equipSlot] = stack;
  slots[slotIndex] = prev; // swap (or null if nothing was equipped)
  return { ok: true, equipSlot };
}

export function unequipSlot(player, equipSlot) {
  if (!EQUIPMENT_SLOTS.includes(equipSlot)) return { ok: false, reason: 'unknown_slot' };
  const eq = player.components.equipment[equipSlot];
  if (!eq) return { ok: false, reason: 'nothing_equipped' };
  const slots = player.components.inventory.slots;
  const slot = slots.findIndex(s => !s);
  if (slot === -1) return { ok: false, reason: 'inventory_full' };
  slots[slot] = eq;
  player.components.equipment[equipSlot] = null;
  return { ok: true };
}
