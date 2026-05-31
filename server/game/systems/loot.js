import { makeGroundItem, EQUIPMENT_SLOTS } from '../entities.js';
import { generateItem, rollRange } from '../items/generator.js';

function findDropTile(world, zoneId, x0, y0) {
  if (!world.groundItemsAt(zoneId, x0, y0).length && world.canMoveTo(zoneId, x0, y0)) {
    return { x: x0, y: y0 };
  }
  for (let r = 1; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x0 + dx, ny = y0 + dy;
        if (!world.canMoveTo(zoneId, nx, ny)) continue;
        if (world.groundItemsAt(zoneId, nx, ny).length) continue;
        return { x: nx, y: ny };
      }
    }
  }
  return { x: x0, y: y0 }; // fall back to the original tile (stack)
}

function makeGoldDrop(world, zone, x, y, amount) {
  const base = world.defs.itemBases['gold_coin'];
  return makeGroundItem({
    zone, x, y,
    base: 'gold_coin',
    sprite: base?.sprite || 'item_gold',
    name: base?.name || 'Gold Coin',
    gold: amount,
  });
}

function makeItemDrop(zone, x, y, base, item) {
  return makeGroundItem({
    zone, x, y,
    base: base.id,
    sprite: base.sprite || 'item_misc',
    name: base.name || base.id,
    item,
  });
}

export function dropLootFromMob(world, mob) {
  const lootTable = world.defs.mobs[mob.components?.ai?.template_id]?.loot_table || [];
  if (lootTable.length === 0) return [];
  const zoneId = mob.position.zone;
  const ox = mob.position.x;
  const oy = mob.position.y;
  const drops = [];

  for (const entry of lootTable) {
    const chance = entry.chance ?? 1;
    if (Math.random() > chance) continue;

    const base = world.defs.itemBases[entry.item];
    if (!base) continue;

    const { x, y } = findDropTile(world, zoneId, ox, oy);

    let ground;
    if (base.slot === 'currency') {
      const amount = Array.isArray(base.value) ? rollRange(base.value) : (base.value || 1);
      ground = makeGoldDrop(world, zoneId, x, y, amount);
    } else {
      const item = generateItem({ baseId: base.id, defs: world.defs, prefixCount: 0 });
      if (!item) continue;
      ground = makeItemDrop(zoneId, x, y, base, item);
    }
    world.addEntity(ground);
    drops.push(ground);
  }
  return drops;
}

// All drops share the player's death tile.
export function dropPlayerInventory(world, player) {
  const { zone, x, y } = player.position;
  const drops = [];
  const drop = (stack) => {
    const base = world.defs.itemBases[stack.base] || { id: stack.base };
    const ground = makeItemDrop(zone, x, y, base, stack.item);
    // Preserve the stack's stored name/sprite if it diverged from the base.
    if (stack.name) ground.name = stack.name;
    if (stack.sprite) ground.sprite = stack.sprite;
    world.addEntity(ground);
    drops.push(ground);
  };

  const slots = player.components.inventory.slots;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]) { drop(slots[i]); slots[i] = null; }
  }
  const equipment = player.components.equipment;
  for (const slotKey of EQUIPMENT_SLOTS) {
    if (equipment[slotKey]) { drop(equipment[slotKey]); equipment[slotKey] = null; }
  }
  const gold = player.components.wallet?.gold || 0;
  if (gold > 0) {
    const ground = makeGoldDrop(world, zone, x, y, gold);
    world.addEntity(ground);
    drops.push(ground);
    player.components.wallet.gold = 0;
  }
  return drops;
}
