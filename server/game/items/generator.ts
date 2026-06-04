import { makeItem } from '../entities.ts';
import type { Affix, ItemEntity, Range, Rarity, RolledStats, WorldDefs } from '../../../shared/types.ts';

export function rollRange([lo, hi]: Range): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function rollRarity(): Rarity {
  const r = Math.random();
  if (r < 0.03) return 'legendary';
  if (r < 0.15) return 'rare';
  if (r < 0.40) return 'uncommon';
  return 'common';
}

function rarityPrefixCount(rarity: Rarity): number {
  if (rarity === 'legendary') return 2;
  if (rarity === 'rare') return Math.random() < 0.5 ? 2 : 1;
  if (rarity === 'uncommon') return 1;
  return 0;
}

function pickAffixes(pool: Affix[], baseTags: string[], count = 1): Affix[] {
  const eligible = pool.filter(a => a.applies_to.some(t => baseTags.includes(t)));
  const picks: Affix[] = [];
  for (let i = 0; i < count && eligible.length > 0; i++) {
    picks.push(eligible[Math.floor(Math.random() * eligible.length)]!);
  }
  return picks;
}

export interface GenerateItemArgs {
  baseId: string;
  defs: WorldDefs;
  prefixCount?: number;
  rarity?: Rarity;
}

export function generateItem({ baseId, defs, prefixCount, rarity }: GenerateItemArgs): ItemEntity | null {
  const base = defs.itemBases[baseId];
  if (!base) return null;
  const resolvedRarity: Rarity = rarity ?? 'common';
  const resolvedPrefixCount = prefixCount ?? rarityPrefixCount(resolvedRarity);
  const prefixes = pickAffixes(defs.affixes.prefixes || [], base.tags, resolvedPrefixCount);
  const rolled: RolledStats = {
    damage: Array.isArray(base.base_damage) ? [...base.base_damage] as Range : null,
    defense: Array.isArray(base.base_defense) ? [...base.base_defense] as Range : null,
    speed: base.base_speed,
    scaling: base.scaling ? { ...base.scaling } : null,
  };
  for (const a of prefixes) {
    for (const [k, v] of Object.entries(a.bonus || {})) {
      // damage_bonus / defense_bonus: add a rolled flat value to the base Range.
      if (k === 'damage_bonus' && Array.isArray(rolled.damage)) {
        const bonus = Array.isArray(v) ? rollRange(v as Range) : (v as number);
        rolled.damage = [rolled.damage[0] + bonus, rolled.damage[1] + bonus];
      } else if (k === 'defense_bonus' && Array.isArray(rolled.defense)) {
        const bonus = Array.isArray(v) ? rollRange(v as Range) : (v as number);
        rolled.defense = [rolled.defense[0] + bonus, rolled.defense[1] + bonus];
      } else if (Array.isArray(v)) {
        rolled[k] = rollRange(v as Range);
      } else {
        const prev = typeof rolled[k] === 'number' ? (rolled[k] as number) : 0;
        rolled[k] = prev + (v as number);
      }
    }
  }
  return makeItem({ base: baseId, affixes: prefixes.map(p => p.id), rolled, rarity: resolvedRarity });
}

export function resolveItemName(item: ItemEntity, defs: WorldDefs): string {
  const eq = item.components?.equipment;
  if (!eq) return 'Item';
  const base = defs.itemBases[eq.base];
  const prefixNames = (eq.affixes || []).map(id => {
    const a = (defs.affixes.prefixes || []).find(p => p.id === id);
    return a?.name_prefix;
  }).filter((n): n is string => Boolean(n));
  return [...prefixNames, base?.name || eq.base].join(' ');
}
