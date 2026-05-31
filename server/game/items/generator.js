import { makeItem } from '../entities.js';

export function rollRange([lo, hi]) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function pickAffixes(pool, baseTags, count = 1) {
  const eligible = pool.filter(a => a.applies_to.some(t => baseTags.includes(t)));
  const picks = [];
  for (let i = 0; i < count && eligible.length > 0; i++) {
    picks.push(eligible[Math.floor(Math.random() * eligible.length)]);
  }
  return picks;
}

export function generateItem({ baseId, defs, prefixCount = 1 }) {
  const base = defs.itemBases[baseId];
  if (!base) return null;
  const prefixes = pickAffixes(defs.affixes.prefixes || [], base.tags, prefixCount);
  const rolled = {
    damage: Array.isArray(base.base_damage) ? [...base.base_damage] : null,
    speed: base.base_speed,
  };
  for (const a of prefixes) {
    for (const [k, v] of Object.entries(a.bonus || {})) {
      rolled[k] = Array.isArray(v) ? rollRange(v) : (rolled[k] || 0) + v;
    }
  }
  return makeItem({ base: baseId, affixes: prefixes.map(p => p.id), rolled });
}

export function resolveItemName(item, defs) {
  const eq = item.components?.equipment;
  if (!eq) return 'Item';
  const base = defs.itemBases[eq.base];
  const prefixNames = (eq.affixes || []).map(id => {
    const a = (defs.affixes.prefixes || []).find(p => p.id === id);
    return a?.name_prefix;
  }).filter(Boolean);
  return [...prefixNames, base?.name || eq.base].join(' ');
}
