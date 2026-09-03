import { makeItem } from '../entities.ts';
import {
  MAX_ILVL, ILVL_JUMP_CHANCE, ILVL_JUMP_RANGE, ILVL_VARIANCE,
  RARITY_MAGNITUDE, ILVL_MAGNITUDE_SLOPE, BRAND_KEYS,
  GOLD_DROP_CHANCE, GOLD_BASE, GOLD_PER_LEVEL,
} from '../../../shared/constants.ts';
import type { Affix, ItemBase, ItemEntity, Range, Rarity, RolledStats, WorldDefs } from '../../../shared/types.ts';

export function rollRange([lo, hi]: Range): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

const RARITY_RANK: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, legendary: 3 };

// Slots that procedural drops draw from. Currency/quest/consumable are excluded.
export const DROP_SLOTS = new Set(['mainhand', 'helmet', 'chest', 'gloves', 'leggings', 'boots', 'ring', 'amulet']);

/**
 * Every knob the procedural roll reads. Defaults come from shared/constants.ts
 * so the game behaves identically whether or not a caller passes overrides; the
 * point of threading this is to let dev tools (tools/loot-lab) re-roll with
 * tweaked numbers WITHOUT duplicating the roll logic here.
 */
export interface LootTuning {
  maxIlvl: number;
  ilvlJumpChance: number;
  ilvlJumpRange: Range;
  ilvlVariance: Range;
  /** Base cumulative rarity thresholds (before ilvl bias). */
  rarity: { legendary: number; rare: number; uncommon: number };
  /** Rarer-with-ilvl shift: bias = min(cap, ilvl*slope); applied to rare/uncommon
   *  in full and to legendary scaled by legendaryFactor. */
  rarityIlvlSlope: number;
  rarityIlvlCap: number;
  rarityLegendaryFactor: number;
  rarityMagnitude: Record<string, number>;
  ilvlMagnitudeSlope: number;
  /** Weight multiplier applied to bases matching a theme's loot affinity. */
  affinityBoost: number;
  /** Chance a branded pick draws from the themed (elemental) affix subset. */
  brandPickChance: number;
  goldDropChance: number;
  goldBase: Range;
  goldPerLevel: Range;
}

export const DEFAULT_TUNING: LootTuning = {
  maxIlvl: MAX_ILVL,
  ilvlJumpChance: ILVL_JUMP_CHANCE,
  ilvlJumpRange: ILVL_JUMP_RANGE,
  ilvlVariance: ILVL_VARIANCE,
  rarity: { legendary: 0.03, rare: 0.15, uncommon: 0.40 },
  rarityIlvlSlope: 0.0025,
  rarityIlvlCap: 0.12,
  rarityLegendaryFactor: 0.4,
  rarityMagnitude: RARITY_MAGNITUDE,
  ilvlMagnitudeSlope: ILVL_MAGNITUDE_SLOPE,
  affinityBoost: 4,
  brandPickChance: 0.6,
  goldDropChance: GOLD_DROP_CHANCE,
  goldBase: GOLD_BASE,
  goldPerLevel: GOLD_PER_LEVEL,
};

export function rollRarity(): Rarity {
  const r = Math.random();
  if (r < 0.03) return 'legendary';
  if (r < 0.15) return 'rare';
  if (r < 0.40) return 'uncommon';
  return 'common';
}

/** Rarity weights shift modestly toward rarer as item-level climbs. */
export function rollRarityForIlvl(ilvl: number, t: LootTuning = DEFAULT_TUNING): Rarity {
  const b = Math.min(t.rarityIlvlCap, ilvl * t.rarityIlvlSlope);
  const r = Math.random();
  if (r < t.rarity.legendary + b * t.rarityLegendaryFactor) return 'legendary';
  if (r < t.rarity.rare + b) return 'rare';
  if (r < t.rarity.uncommon + b) return 'uncommon';
  return 'common';
}

/**
 * Sample an item-level from a mob level. Centered on the mob's level with small
 * variance, plus a rare upward jump — the source of "godrolls from weak mobs".
 */
export function sampleIlvl(mobLevel: number, t: LootTuning = DEFAULT_TUNING): number {
  const jump = Math.random() < t.ilvlJumpChance ? rollRange(t.ilvlJumpRange) : rollRange(t.ilvlVariance);
  return Math.max(1, Math.min(t.maxIlvl, mobLevel + jump));
}

/** Roll the gold a combat mob of the given level drops (0 if the chance fails). */
export function rollMobGold(mobLevel: number, t: LootTuning = DEFAULT_TUNING): number {
  if (Math.random() >= t.goldDropChance) return 0;
  return rollRange(t.goldBase) + mobLevel * rollRange(t.goldPerLevel);
}

function isDroppableEquip(base: ItemBase): boolean {
  return DROP_SLOTS.has(base.slot) && !base.tags.includes('quest_item');
}

/**
 * A mob's loot theme, threaded from its template into the procedural drop so a
 * faction/archetype's drops cohere. Both are SOFT biases (weights), never hard
 * filters, so loot stays varied and the rarity/ilvl gates still govern.
 *   affinity — loot type the base should lean toward (archetype loot_affinity).
 *   brand    — element the affixes should lean toward (faction loot_flavor; a BRAND_KEY).
 */
export interface DropTheme {
  affinity?: string[];
  brand?: string[];
}

// Archetype loot_affinity terms → item-base tags they should bias toward. The
// two vocabularies differ (light_armor vs the base's [armor, light]), so this
// bridges them. Unmapped terms (hide, reagent, coin, …) have no equip base and
// are simply ignored.
//
// Note that `heavy`/`light` are WEIGHT tags, not category tags: a maul is
// [melee, blade, heavy] and a dagger is [melee, blade, light], so heavy_armor /
// light_armor match weapons too. `armor` is the only tag no weapon carries —
// use it alone when a term has to actually mean armour (see the armorer's
// featured_stock).
export const AFFINITY_TAGS: Record<string, string[]> = {
  light_armor: ['light'],
  heavy_armor: ['heavy'],
  armor: ['armor'],
  weapon: ['melee', 'blade', 'blunt'],
  blade: ['blade'],
  blunt: ['blunt'],
  wand: ['staff'],
  staff: ['staff'],
  trinket: ['jewelry', 'curio'],
  gem: ['jewelry'],
  relic: ['jewelry', 'trophy'],
  jewelry: ['jewelry'],
};

/** Tags an affinity list maps to (deduped). */
function affinityTags(affinity: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const a of affinity ?? []) for (const t of AFFINITY_TAGS[a] ?? []) out.add(t);
  return out;
}

/** Pick an equip base eligible at this ilvl, weighted toward higher tiers and
 *  (when a theme is given) toward bases matching the theme's affinity. */
export function pickDropBase(defs: WorldDefs, ilvl: number, theme?: DropTheme, t: LootTuning = DEFAULT_TUNING): ItemBase | null {
  const eligible = Object.values(defs.itemBases).filter(
    b => isDroppableEquip(b) && (b.min_ilvl ?? 1) <= ilvl,
  );
  if (eligible.length === 0) return null;
  const wanted = affinityTags(theme?.affinity);
  const weights = eligible.map(b => {
    const base = ((b.min_ilvl ?? 1) + 1) ** 2;
    const matches = wanted.size > 0 && b.tags.some(t => wanted.has(t));
    return matches ? base * t.affinityBoost : base;
  });
  const total = weights.reduce((a, w) => a + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < eligible.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return eligible[i]!;
  }
  return eligible[eligible.length - 1]!;
}

function rarityAffixCounts(rarity: Rarity): { prefix: number; suffix: number } {
  switch (rarity) {
    case 'legendary': return { prefix: 2, suffix: Math.random() < 0.5 ? 2 : 1 };
    case 'rare':      return { prefix: Math.random() < 0.5 ? 2 : 1, suffix: 1 };
    case 'uncommon':  return { prefix: 1, suffix: 0 };
    default:          return { prefix: 0, suffix: 0 };
  }
}

/** True if an affix grants one of the theme's brand elements (e.g. fire_damage). */
function isBrandAffix(a: Affix, brand: Set<string>): boolean {
  return Object.keys(a.bonus ?? {}).some(k => brand.has(k));
}

// Elemental (BRAND_KEYS-bearing) affix keys this affix grants, e.g. ['fire_damage'].
// Only weapon-tagged affixes carry these today (see prefixes.yaml), which is what
// makes a weapon's whole swing typed by weapon-imbue (see generateItem below).
function elementalKeys(a: Affix): string[] {
  return Object.keys(a.bonus ?? {}).filter(k => (BRAND_KEYS as readonly string[]).includes(k));
}

function pickAffixes(pool: Affix[], baseTags: string[], rarity: Rarity, count: number, brand?: Set<string>, t: LootTuning = DEFAULT_TUNING): Affix[] {
  const eligible = pool.filter(
    a => a.applies_to.some(t => baseTags.includes(t)) && RARITY_RANK[a.rarity ?? 'common'] <= RARITY_RANK[rarity],
  );
  const branded = brand && brand.size > 0 ? eligible.filter(a => isBrandAffix(a, brand)) : [];
  const picks: Affix[] = [];
  // A weapon can only be imbued with a single element (see generateItem's
  // weapon_brand stamping) — once one elemental affix is picked, exclude
  // differently-elemental affixes from later picks on this item.
  let chosenElement: string | null = null;
  for (let i = 0; i < count && eligible.length > 0; i++) {
    // Lean toward the faction's element when an eligible branded affix exists.
    const from = branded.length > 0 && Math.random() < t.brandPickChance ? branded : eligible;
    const candidates = chosenElement
      ? from.filter(a => { const keys = elementalKeys(a); return keys.length === 0 || keys.includes(chosenElement!); })
      : from;
    const pickFrom = candidates.length > 0 ? candidates : from;
    const pick = pickFrom[Math.floor(Math.random() * pickFrom.length)]!;
    if (!chosenElement) {
      const keys = elementalKeys(pick);
      if (keys.length > 0) chosenElement = keys[0]!;
    }
    picks.push(pick);
  }
  return picks;
}

/** Rarer / higher-ilvl items roll stronger affix magnitudes. */
function magnitudeMult(rarity: Rarity, ilvl: number, t: LootTuning): number {
  return (t.rarityMagnitude[rarity] ?? 1) * (1 + ilvl * t.ilvlMagnitudeSlope);
}

export interface GenerateItemArgs {
  baseId: string;
  defs: WorldDefs;
  rarity?: Rarity;
  ilvl?: number;
  /** Bias affixes toward these brand elements (faction loot_flavor). */
  brand?: string[];
  /** Tuning overrides; defaults to DEFAULT_TUNING (the shipped constants). */
  tuning?: LootTuning;
}

export function generateItem({ baseId, defs, rarity, ilvl, brand, tuning = DEFAULT_TUNING }: GenerateItemArgs): ItemEntity | null {
  const base = defs.itemBases[baseId];
  if (!base) return null;
  const resolvedRarity: Rarity = rarity ?? 'common';
  const resolvedIlvl = ilvl ?? (base.min_ilvl ?? 1);
  const brandSet = brand && brand.length ? new Set(brand) : undefined;
  const counts = rarityAffixCounts(resolvedRarity);
  const prefixes = pickAffixes(defs.affixes.prefixes || [], base.tags, resolvedRarity, counts.prefix, brandSet, tuning);
  const suffixes = pickAffixes(defs.affixes.suffixes || [], base.tags, resolvedRarity, counts.suffix, brandSet, tuning);
  const affixes = [...prefixes, ...suffixes];
  const mult = magnitudeMult(resolvedRarity, resolvedIlvl, tuning);

  const rolled: RolledStats = {
    damage: Array.isArray(base.base_damage) ? [...base.base_damage] as Range : null,
    defense: Array.isArray(base.base_defense) ? [...base.base_defense] as Range : null,
    speed: base.base_speed,
    scaling: base.scaling ? { ...base.scaling } : null,
  };
  for (const a of affixes) {
    for (const [k, v] of Object.entries(a.bonus || {})) {
      // Speed is a small float multiplier — never magnitude-scaled or rounded.
      if (k === 'speed') {
        const prev = typeof rolled.speed === 'number' ? rolled.speed : 0;
        rolled.speed = prev + (Array.isArray(v) ? rollRange(v as Range) : (v as number));
        continue;
      }
      const raw = Array.isArray(v) ? rollRange(v as Range) : (v as number);
      const scaled = Math.max(1, Math.round(raw * mult));
      // damage_bonus / defense_bonus fold a flat value into the base Range.
      if (k === 'damage_bonus' && Array.isArray(rolled.damage)) {
        rolled.damage = [rolled.damage[0] + scaled, rolled.damage[1] + scaled];
      } else if (k === 'defense_bonus' && Array.isArray(rolled.defense)) {
        rolled.defense = [rolled.defense[0] + scaled, rolled.defense[1] + scaled];
      } else {
        const prev = typeof rolled[k] === 'number' ? (rolled[k] as number) : 0;
        rolled[k] = prev + scaled;
      }
    }
  }
  // Weapon-imbue: a damage-dealing item whose affixes include an elemental brand
  // gets the whole swing tagged as that type (see abilities.ts applyEffect's
  // from_weapon handling), not just a flat untyped bonus. pickAffixes already
  // enforced at most one element per item, so the first one found is the only one.
  if (Array.isArray(rolled.damage)) {
    for (const a of affixes) {
      const keys = elementalKeys(a);
      if (keys.length > 0) { rolled.weapon_brand = keys[0]; break; }
    }
  }
  return makeItem({ base: baseId, affixes: affixes.map(a => a.id), rolled, rarity: resolvedRarity });
}

/** Roll a fully procedural equip drop for a given item-level, optionally themed
 *  to a mob's loot affinity (base bias) and brand (affix bias). */
export function generateDrop(defs: WorldDefs, ilvl: number, theme?: DropTheme, tuning: LootTuning = DEFAULT_TUNING): ItemEntity | null {
  const base = pickDropBase(defs, ilvl, theme, tuning);
  if (!base) return null;
  return generateItem({ baseId: base.id, defs, rarity: rollRarityForIlvl(ilvl, tuning), ilvl, brand: theme?.brand, tuning });
}

export function resolveItemName(item: ItemEntity, defs: WorldDefs): string {
  const eq = item.components?.equipment;
  if (!eq) return 'Item';
  const base = defs.itemBases[eq.base];
  const ids = eq.affixes || [];
  const prefixNames = ids
    .map(id => (defs.affixes.prefixes || []).find(p => p.id === id)?.name_prefix)
    .filter((n): n is string => Boolean(n));
  const suffixNames = ids
    .map(id => (defs.affixes.suffixes || []).find(s => s.id === id)?.name_suffix)
    .filter((n): n is string => Boolean(n));
  return [...prefixNames, base?.name || eq.base, ...suffixNames].join(' ');
}
