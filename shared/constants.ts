import type { ClassId, EquipSlot, MobRole, StatId } from './types.ts';

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

// ─── Mob level scaling ───────────────────────────────────────────────────────

interface RoleConfig {
  hp:  number;   // multiplier on base HP  (base = 10 × level)
  dmg: number;   // multiplier on base dmg (base_lo = level×0.5, base_hi = level×1.0)
  xp:  number;   // multiplier on base XP  (base = level); 0 = no default XP
}

export const MOB_ROLES: Record<MobRole, RoleConfig> = {
  skirmisher: { hp: 0.8, dmg: 1.0, xp: 3 },
  brute:      { hp: 1.5, dmg: 1.3, xp: 3 },
  tank:       { hp: 2.0, dmg: 0.5, xp: 2 },
  pest:       { hp: 0.5, dmg: 0.7, xp: 2 },
  soldier:    { hp: 1.2, dmg: 1.0, xp: 0 },
  npc:        { hp: 2.0, dmg: 0.0, xp: 0 },
  passive:    { hp: 0.7, dmg: 0.0, xp: 1 },
};

export function mobStats(level: number, role: MobRole): { hp: number; damage: [number, number]; xp: number } {
  const r = MOB_ROLES[role];
  const hp = Math.max(1, Math.round(20 * level * r.hp));
  const damage: [number, number] = r.dmg === 0
    ? [0, 0]
    : [Math.max(1, Math.round(level * 2.0 * r.dmg)), Math.max(1, Math.round(level * 4.0 * r.dmg))];
  const xp = Math.round(level * r.xp);
  return { hp, damage, xp };
}
