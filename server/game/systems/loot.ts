import { makeCorpse, EQUIPMENT_SLOTS } from '../entities.ts';
import { generateItem, rollRange, rollRarity } from '../items/generator.ts';
import { randomUUID } from 'node:crypto';
import type {
  CorpseEntity, ItemBase, ItemEntity, LootSlot, MobEntity, PlayerEntity, Range,
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


function needsQuestItem(killer: PlayerEntity | null, itemBase: string, defs: World['defs']): boolean {
  if (!killer) return false;
  const active = killer.components.quests?.active ?? [];
  for (const entry of active) {
    const questDef = defs.quests[entry.questId];
    if (!questDef) continue;
    const stage = questDef.stages?.find((s) => s.id === entry.stage);
    const obj = stage?.objective;
    if (obj?.kind === 'collect_count' && obj.item_base === itemBase) {
      const collected = entry.progress?.collected ?? 0;
      return collected < obj.target;
    }
  }
  return false;
}

export function dropLootFromMob(world: World, mob: MobEntity, killer: PlayerEntity | null = null): CorpseEntity | null {
  const lootTable = world.defs.mobs[mob.components?.ai?.template_id]?.loot_table || [];
  const zoneId = mob.position.zone;
  const ox = mob.position.x;
  const oy = mob.position.y;
  const slots: LootSlot[] = [];

  for (const entry of lootTable) {
    const chance = entry.chance ?? 1;
    if (Math.random() > chance) continue;

    const base = world.defs.itemBases[entry.item];
    if (!base) continue;

    if (base.slot === 'quest' && !needsQuestItem(killer, base.id, world.defs)) continue;

    if (base.slot === 'currency') {
      const amount = Array.isArray(base.value) ? rollRange(base.value as Range) : (base.value as number || 1);
      const goldBase = world.defs.itemBases['gold_coin'];
      slots.push({ id: randomUUID(), name: goldBase?.name || 'Gold', base: 'gold_coin', item: null, gold: amount });
    } else if (base.slot === 'quest') {
      const item = generateItem({ baseId: base.id, defs: world.defs, rarity: 'common' });
      if (!item) continue;
      slots.push({ id: randomUUID(), name: base.name || base.id, base: base.id, item, gold: 0 });
    } else {
      const rarity = rollRarity();
      const item = generateItem({ baseId: base.id, defs: world.defs, rarity });
      if (!item) continue;
      slots.push({ id: randomUUID(), name: base.name || base.id, base: base.id, item, gold: 0 });
    }
  }

  if (slots.length === 0) return null;
  const corpse = makeCorpse(zoneId, ox, oy, mob.name, slots);
  world.addEntity(corpse);
  return corpse;
}

export function dropPlayerInventory(world: World, player: PlayerEntity): CorpseEntity | null {
  const { zone, x, y } = player.position;
  const slots: LootSlot[] = [];

  const inventory = player.components.inventory.slots;
  for (let i = 0; i < inventory.length; i++) {
    const s = inventory[i];
    if (s) {
      slots.push({ id: randomUUID(), name: s.name, base: s.base, item: s.item, gold: 0 });
      inventory[i] = null;
    }
  }

  const equipment = player.components.equipment;
  for (const slotKey of EQUIPMENT_SLOTS) {
    const s = equipment[slotKey];
    if (s) {
      slots.push({ id: randomUUID(), name: s.name, base: s.base, item: s.item, gold: 0 });
      equipment[slotKey] = null;
    }
  }

  const gold = player.components.wallet?.gold || 0;
  if (gold > 0) {
    const goldBase = world.defs.itemBases['gold_coin'];
    slots.push({ id: randomUUID(), name: goldBase?.name || 'Gold', base: 'gold_coin', item: null, gold });
    player.components.wallet.gold = 0;
  }

  if (slots.length === 0) return null;
  const corpse = makeCorpse(zone, x, y, player.name, slots);
  world.addEntity(corpse);
  return corpse;
}
