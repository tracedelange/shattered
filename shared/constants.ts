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

// ─── Loot / item-level (see docs/plan-affix-brand-procgen.md) ─────────────────

/** Upper clamp on a rolled item-level. */
export const MAX_ILVL = 50;

/** Chance per drop that ilvl jumps well above mob level (rare godrolls). */
export const ILVL_JUMP_CHANCE = 0.02;
export const ILVL_JUMP_RANGE: [number, number] = [5, 12];
/** Normal per-drop ilvl variance around mob level. */
export const ILVL_VARIANCE: [number, number] = [-1, 2];

/** Chance a combat-role mob drops a generated equip item (on top of loot_table). */
export const GENERIC_DROP_CHANCE = 0.18;

/** Rarity magnitude multipliers — rarer items roll stronger affix values. */
export const RARITY_MAGNITUDE: Record<string, number> = {
  common: 1.0, uncommon: 1.15, rare: 1.4, legendary: 1.8,
};
/** Per-ilvl slope added to the magnitude multiplier. */
export const ILVL_MAGNITUDE_SLOPE = 0.03;

/** Rolled stat keys that add flat damage to a swing (brands). Combat reads these. */
export const BRAND_KEYS: readonly string[] = [
  'fire_damage', 'cold_damage', 'poison_damage', 'lightning_damage', 'arcane_damage',
] as const;

// Tiles that block movement. Shared so client-side pathfinding agrees with
// server's canMoveTo.
export const BLOCKING_TILES: ReadonlySet<string> = new Set(['wall', 'water', 'void', 'tree']);

// Zone where new players spawn, and the origin the content pipeline expands
// outward from (sticky loop). Falls back to the first loaded zone if absent —
// see startingZone() in server/index.ts.
export const PREFERRED_STARTING_ZONE = 'village_41_41';

// ─── Mob level scaling ───────────────────────────────────────────────────────

interface RoleConfig {
  hp:  number;   // multiplier applied to the constitution-derived max HP
  dmg: number;   // multiplier on base dmg (see MOB_DMG_LO/HI)
  xp:  number;   // multiplier on base XP  (base = level); 0 = no default XP
}

// ─── TTK anchor (see docs/plan-combat-retune.md) ──────────────────────────────
// At level parity, an unarmed fighter should kill a same-level *skirmisher* in
// ~5-6 hits and die in ~8-10. Skirmisher (hp 1.0) is the baseline "fair fight";
// other roles' hp multipliers are relative to it. Tune MOB_HP_* and these
// multipliers against tools/combat-sim.ts, not by feel.
export const MOB_ROLES: Record<MobRole, RoleConfig> = {
  skirmisher: { hp: 1.0, dmg: 1.0, xp: 3 },
  brute:      { hp: 1.3, dmg: 1.2, xp: 3 },
  tank:       { hp: 2.2, dmg: 0.5, xp: 2 },
  pest:       { hp: 0.5, dmg: 0.7, xp: 2 },
  soldier:    { hp: 1.2, dmg: 1.0, xp: 0 },
  npc:        { hp: 2.0, dmg: 0.0, xp: 0 },
  passive:    { hp: 0.7, dmg: 0.0, xp: 1 },
};

// Mob max HP = (MOB_HP_BASE + constitution × MOB_HP_PER_CON) × role.hp.
// Deliberately *not* the player formula (100 + (con-5)×10); that floor turned
// trivial mobs into HP sponges. These land a L2 skirmisher near ~35 HP.
const MOB_HP_BASE = 24;
const MOB_HP_PER_CON = 3;

// Mob base damage range per level, before role.dmg. The old [×2, ×4] slope
// (avg level×3) outpaced the player's nearly-flat unarmed damage, so parity
// collapsed past ~L5. A gentler slope keeps same-level fights winnable 1-10.
const MOB_DMG_LO = 1.3;
const MOB_DMG_HI = 2.3;

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
  const hp = Math.max(1, Math.round((MOB_HP_BASE + stats.constitution * MOB_HP_PER_CON) * r.hp));
  const damage: [number, number] = r.dmg === 0
    ? [0, 0]
    : [Math.max(1, Math.round(level * MOB_DMG_LO * r.dmg)), Math.max(1, Math.round(level * MOB_DMG_HI * r.dmg))];
  const xp = Math.round(level * r.xp);
  return { hp, damage, xp, stats };
}

// ─── Level-based aggro ────────────────────────────────────────────────────────
// How a mob reacts to a player scales with their relative level. At parity or
// when the mob is stronger, it aggros at its full aggro_range. For each level
// the player is *above* the mob, effective aggro range shrinks by this many
// tiles, so weaker mobs notice you later (or not at all). Once the player is
// AGGRO_AVERSION_GAP+ levels above, the mob stops aggroing and instead flees
// when the player comes within its aggro_range.
export const AGGRO_DROPOFF_PER_LEVEL = 1;
export const AGGRO_AVERSION_GAP = 5;

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
