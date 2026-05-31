import { makeItem } from '../entities.ts';
import type { Affix, ItemEntity, Range, RolledStats, WorldDefs } from '../../../shared/types.ts';

export function rollRange([lo, hi]: Range): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
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
}

export function generateItem({ baseId, defs, prefixCount = 1 }: GenerateItemArgs): ItemEntity | null {
  const base = defs.itemBases[baseId];
  if (!base) return null;
  const prefixes = pickAffixes(defs.affixes.prefixes || [], base.tags, prefixCount);
  const rolled: RolledStats = {
    damage: Array.isArray(base.base_damage) ? [...base.base_damage] as Range : null,
    defense: Array.isArray(base.base_defense) ? [...base.base_defense] as Range : null,
    speed: base.base_speed,
    scaling: base.scaling ? { ...base.scaling } : null,
  };
  for (const a of prefixes) {
    for (const [k, v] of Object.entries(a.bonus || {})) {
      if (Array.isArray(v)) {
        rolled[k] = rollRange(v as Range);
      } else {
        const prev = typeof rolled[k] === 'number' ? (rolled[k] as number) : 0;
        rolled[k] = prev + (v as number);
      }
    }
  }
  return makeItem({ base: baseId, affixes: prefixes.map(p => p.id), rolled });
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
