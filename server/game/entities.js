import { randomUUID } from 'node:crypto';

export const INVENTORY_SLOT_COUNT = 12;
export const EQUIPMENT_SLOTS = [
  'mainhand', 'helmet', 'chest', 'gloves', 'leggings', 'boots',
  'ring1', 'ring2', 'amulet',
];

export function isAlive(entity) {
  return (entity?.components?.health?.current ?? 0) > 0;
}

function emptyEquipment() {
  const eq = {};
  for (const s of EQUIPMENT_SLOTS) eq[s] = null;
  return eq;
}

export function makePlayer({ id = randomUUID(), zone, x, y, name = 'Player' }) {
  return {
    id,
    type: 'player',
    name,
    position: { zone, x, y },
    facing: 'south',
    nextActTick: 0,
    nextRegenTick: 0,
    components: {
      health:    { current: 100, max: 100 },
      inventory: { slots: new Array(INVENTORY_SLOT_COUNT).fill(null) },
      equipment: emptyEquipment(),
      wallet:    { gold: 0 },
      stats:     {
        strength: 5, dexterity: 5, intelligence: 5, constitution: 5,
        speed: 1.0, damage: [3, 6],
      },
      progress:  { level: 1, xp: 0, unspent_points: 0 },
    },
  };
}

export function makeGroundItem({ zone, x, y, base, sprite, name, item = null, gold = 0 }) {
  return {
    id: randomUUID(),
    type: 'ground_item',
    name,
    sprite: sprite || 'item_misc',
    position: { zone, x, y },
    passable: true,
    base,           // base id (e.g. 'iron_sword', 'gold_coin')
    item,           // rolled item entity for equipment; null for currency
    gold,           // for currency drops
  };
}

export function makeMob(template, { zone, x, y }) {
  return {
    id: randomUUID(),
    type: 'mob',
    name: template.name,
    sprite: template.sprite,
    position: { zone, x, y },
    facing: 'south',
    nextActTick: 0,
    xpReward: template.xp ?? 0,
    dialogue: template.dialogue || [],
    components: {
      health:    { current: template.stats.health, max: template.stats.health },
      stats:     { damage: template.stats.damage, speed: template.stats.speed },
      ai:        {
        behavior: template.behavior,
        aggro_range: template.aggro_range,
        template_id: template.id,
        target: null,
      },
      inventory: { slots: [] },
    },
  };
}

export function makeItem({ base, affixes = [], rolled = {} }) {
  return {
    id: randomUUID(),
    type: 'item',
    components: {
      equipment: { base, affixes, rolled },
    },
  };
}
