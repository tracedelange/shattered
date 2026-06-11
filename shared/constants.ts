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
  hp:  number;   // multiplier applied to the constitution-derived max HP
  dmg: number;   // multiplier on base dmg (base_lo = level×2, base_hi = level×4)
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

// Per-role base stats and per-level growth rates.
// These values are chosen so that a level-5 mob's HP stays close to the
// previous flat formula (20 × level × role.hp) while giving meaningful stats.
interface RoleStatConfig {
  str_base: number; str_lvl: number;
  dex_base: number; dex_lvl: number;
  int_base: number;
  con_base: number; con_lvl: number;
}

const MOB_ROLE_STATS: Record<MobRole, RoleStatConfig> = {
  skirmisher: { str_base: 4, str_lvl: 0.8, dex_base: 5, dex_lvl: 0.8, int_base: 2, con_base: 3, con_lvl: 0.4 },
  brute:      { str_base: 6, str_lvl: 1.0, dex_base: 2, dex_lvl: 0.3, int_base: 2, con_base: 3, con_lvl: 0.5 },
  tank:       { str_base: 3, str_lvl: 0.4, dex_base: 2, dex_lvl: 0.2, int_base: 2, con_base: 4, con_lvl: 0.8 },
  pest:       { str_base: 2, str_lvl: 0.4, dex_base: 5, dex_lvl: 0.8, int_base: 2, con_base: 2, con_lvl: 0.3 },
  soldier:    { str_base: 5, str_lvl: 0.8, dex_base: 4, dex_lvl: 0.6, int_base: 2, con_base: 3, con_lvl: 0.5 },
  npc:        { str_base: 2, str_lvl: 0.0, dex_base: 2, dex_lvl: 0.0, int_base: 5, con_base: 5, con_lvl: 0.8 },
  passive:    { str_base: 2, str_lvl: 0.3, dex_base: 4, dex_lvl: 0.5, int_base: 2, con_base: 2, con_lvl: 0.4 },
};

export function mobStatBlock(level: number, role: MobRole): { strength: number; dexterity: number; intelligence: number; constitution: number } {
  const r = MOB_ROLE_STATS[role];
  return {
    strength:     Math.max(1, Math.round(r.str_base + level * r.str_lvl)),
    dexterity:    Math.max(1, Math.round(r.dex_base + level * r.dex_lvl)),
    intelligence: r.int_base,
    constitution: Math.max(1, Math.round(r.con_base + level * r.con_lvl)),
  };
}

export function mobStats(level: number, role: MobRole): { hp: number; damage: [number, number]; xp: number; stats: ReturnType<typeof mobStatBlock> } {
  const r = MOB_ROLES[role];
  const stats = mobStatBlock(level, role);
  // HP uses the same formula as players (100 + (con-5)*10), scaled by role.
  const hp = Math.max(1, Math.round((100 + (stats.constitution - 5) * 10) * r.hp));
  const damage: [number, number] = r.dmg === 0
    ? [0, 0]
    : [Math.max(1, Math.round(level * 2.0 * r.dmg)), Math.max(1, Math.round(level * 4.0 * r.dmg))];
  const xp = Math.round(level * r.xp);
  return { hp, damage, xp, stats };
}

const XP_TABLE = [
     50,   131,   253,   417,   648,
    825,   957,  1173,  1455,  1641,
   1739,  1855,  1978,  2109,  2249,
   2398,  2557,  2727,  2907,  3100,
   3306,  3525,  3759,  4008,  4274,
   4557,  4859,  5182,  5525,  5892,
   6282,  6699,  7143,  7617,  8122,
   8660,  9235,  9847, 10500, 16692,
  17772, 18897, 20066, 21281, 22543,
  23853, 25999, 27933, 30815, 38806,
];

export function xpForNext(level: number): number {
  return XP_TABLE[Math.min(level, XP_TABLE.length) - 1];
}
