import type { ClassId, EquipSlot, StatId } from './types.ts';

export const INVENTORY_SLOT_COUNT = 30;

export const EQUIPMENT_SLOTS: readonly EquipSlot[] = [
  'mainhand', 'helmet', 'chest', 'gloves', 'leggings', 'boots',
  'ring1', 'ring2', 'amulet',
] as const;

export const ARMOR_SLOTS: readonly EquipSlot[] = [
  'helmet', 'chest', 'gloves', 'leggings', 'boots',
] as const;

export const ALLOCATABLE_STATS: readonly StatId[] = [
  'strength', 'dexterity', 'intelligence', 'constitution',
] as const;

export interface ClassTemplate {
  id: ClassId;
  name: string;
  start_stats: { strength: number; dexterity: number; intelligence: number; constitution: number };
}

export const CLASSES: Record<ClassId, ClassTemplate> = {
  fighter: { id: 'fighter', name: 'Fighter', start_stats: { strength: 8, dexterity: 4, intelligence: 4, constitution: 6 } },
  rogue:   { id: 'rogue',   name: 'Rogue',   start_stats: { strength: 4, dexterity: 8, intelligence: 4, constitution: 6 } },
  wizard:  { id: 'wizard',  name: 'Wizard',  start_stats: { strength: 4, dexterity: 4, intelligence: 8, constitution: 6 } },
};

export const SCALING_COEFFS: Record<string, number> = {
  S: 1.5, A: 1.0, B: 0.6, C: 0.4, D: 0.25, E: 0.15,
};

// Tiles that block movement. Shared so client-side pathfinding agrees with
// server's canMoveTo.
export const BLOCKING_TILES: ReadonlySet<string> = new Set(['wall', 'water', 'void', 'tree']);
