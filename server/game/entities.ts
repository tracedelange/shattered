import { randomUUID } from 'node:crypto';
import {
  CLASSES, EQUIPMENT_SLOTS, INVENTORY_SLOT_COUNT,
} from '../../shared/constants.ts';
import type {
  ClassId, Direction, Entity, Equipment, GroundItemEntity, InventoryStack,
  ItemEntity, MobEntity, MobTemplate, PlayerEntity, Rarity, RolledStats,
} from '../../shared/types.ts';

export { EQUIPMENT_SLOTS, ARMOR_SLOTS, INVENTORY_SLOT_COUNT, CLASSES } from '../../shared/constants.ts';

export function isAlive(entity: Entity | undefined | null): boolean {
  if (!entity) return false;
  const hp = (entity as PlayerEntity | MobEntity).components?.health;
  return (hp?.current ?? 0) > 0;
}

function emptyEquipment(): Equipment {
  const eq = {} as Equipment;
  for (const s of EQUIPMENT_SLOTS) eq[s] = null;
  return eq;
}

export interface MakePlayerArgs {
  id?: string;
  zone: string;
  x: number;
  y: number;
  name?: string;
  klass?: ClassId;
}

export function makePlayer({
  id = randomUUID(), zone, x, y, name = 'Player', klass = 'fighter',
}: MakePlayerArgs): PlayerEntity {
  const cls = CLASSES[klass] || CLASSES.fighter;
  const s = cls.start_stats;
  const maxHp = 100 + (s.constitution - 5) * 10;
  return {
    id,
    type: 'player',
    name,
    klass: cls.id,
    position: { zone, x, y },
    facing: 'south',
    nextActTick: 0,
    nextRegenTick: 0,
    components: {
      health:    { current: maxHp, max: maxHp },
      inventory: { slots: new Array(INVENTORY_SLOT_COUNT).fill(null) },
      equipment: emptyEquipment(),
      wallet:    { gold: 0 },
      stats:     {
        strength: s.strength, dexterity: s.dexterity,
        intelligence: s.intelligence, constitution: s.constitution,
        speed: 1.0, damage: [3, 6],
      },
      progress:  { level: 1, xp: 0, unspent_points: 0 },
      quests:    { active: [], completed: [] },
    },
  };
}

export interface MakeGroundItemArgs {
  zone: string;
  x: number;
  y: number;
  base: string;
  sprite?: string;
  name: string;
  item?: ItemEntity | null;
  gold?: number;
}

export function makeGroundItem({
  zone, x, y, base, sprite, name, item = null, gold = 0,
}: MakeGroundItemArgs): GroundItemEntity {
  return {
    id: randomUUID(),
    type: 'ground_item',
    name,
    sprite: sprite || 'item_misc',
    position: { zone, x, y },
    passable: true,
    base,
    item,
    gold,
  };
}

export function makeMob(template: MobTemplate, { zone, x, y, spawnId }: { zone: string; x: number; y: number; spawnId?: string }): MobEntity {
  return {
    id: randomUUID(),
    type: 'mob',
    name: template.name,
    sprite: template.sprite,
    position: { zone, x, y },
    facing: 'south' as Direction,
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
        spawn_id: spawnId,
        target: null,
      },
      inventory: { slots: [] },
    },
  };
}

export interface MakeItemArgs {
  base: string;
  affixes?: string[];
  rolled?: RolledStats;
  rarity?: Rarity;
}

export function makeItem({ base, affixes = [], rolled = {} as RolledStats, rarity }: MakeItemArgs): ItemEntity {
  return {
    id: randomUUID(),
    type: 'item',
    components: {
      equipment: { base, affixes, rolled, rarity },
    },
  };
}

export type { InventoryStack };
