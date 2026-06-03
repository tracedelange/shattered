import { makeGroundItem, EQUIPMENT_SLOTS } from '../entities.ts';
import { generateItem, rollRange, rollRarity } from '../items/generator.ts';
import type {
  GroundItemEntity, ItemBase, ItemEntity, MobEntity, PlayerEntity, Range,
} from '../../../shared/types.ts';
import type { World } from '../world.ts';

function findDropTile(world: World, zoneId: string, x0: number, y0: number): { x: number; y: number } {
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
  return { x: x0, y: y0 };
}

function makeGoldDrop(world: World, zone: string, x: number, y: number, amount: number): GroundItemEntity {
  const base = world.defs.itemBases['gold_coin'];
  return makeGroundItem({
    zone, x, y,
    base: 'gold_coin',
    sprite: base?.sprite || 'item_gold',
    name: base?.name || 'Gold Coin',
    gold: amount,
  });
}

function makeItemDrop(zone: string, x: number, y: number, base: Partial<ItemBase> & { id: string }, item: ItemEntity | null): GroundItemEntity {
  return makeGroundItem({
    zone, x, y,
    base: base.id,
    sprite: base.sprite || 'item_misc',
    name: base.name || base.id,
    item,
  });
}

export function dropLootFromMob(world: World, mob: MobEntity): GroundItemEntity[] {
  const lootTable = world.defs.mobs[mob.components?.ai?.template_id]?.loot_table || [];
  if (lootTable.length === 0) return [];
  const zoneId = mob.position.zone;
  const ox = mob.position.x;
  const oy = mob.position.y;
  const drops: GroundItemEntity[] = [];

  for (const entry of lootTable) {
    const chance = entry.chance ?? 1;
    if (Math.random() > chance) continue;

    const base = world.defs.itemBases[entry.item];
    if (!base) continue;

    const { x, y } = findDropTile(world, zoneId, ox, oy);

    let ground: GroundItemEntity;
    if (base.slot === 'currency') {
      const amount = Array.isArray(base.value) ? rollRange(base.value as Range) : (base.value as number || 1);
      ground = makeGoldDrop(world, zoneId, x, y, amount);
    } else if (base.slot === 'quest') {
      const item = generateItem({ baseId: base.id, defs: world.defs, rarity: 'common' });
      if (!item) continue;
      ground = makeItemDrop(zoneId, x, y, base, item);
    } else {
      const rarity = rollRarity();
      const item = generateItem({ baseId: base.id, defs: world.defs, rarity });
      if (!item) continue;
      ground = makeItemDrop(zoneId, x, y, base, item);
    }
    world.addEntity(ground);
    drops.push(ground);
  }
  return drops;
}

export function dropPlayerInventory(world: World, player: PlayerEntity): GroundItemEntity[] {
  const { zone, x, y } = player.position;
  const drops: GroundItemEntity[] = [];
  const drop = (stack: { base: string; item: ItemEntity | null; name?: string; sprite?: string }) => {
    const base = world.defs.itemBases[stack.base] || { id: stack.base };
    const ground = makeItemDrop(zone, x, y, base, stack.item);
    if (stack.name) ground.name = stack.name;
    if (stack.sprite) ground.sprite = stack.sprite;
    world.addEntity(ground);
    drops.push(ground);
  };

  const slots = player.components.inventory.slots;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s) { drop(s); slots[i] = null; }
  }
  const equipment = player.components.equipment;
  for (const slotKey of EQUIPMENT_SLOTS) {
    const s = equipment[slotKey];
    if (s) { drop(s); equipment[slotKey] = null; }
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
