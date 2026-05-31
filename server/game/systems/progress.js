const HP_PER_CONSTITUTION_POINT = 10;
const ALLOCATABLE_STATS = ['strength', 'dexterity', 'intelligence', 'constitution'];

export function xpForNext(level) {
  return level * 100;
}

export function grantXp(player, amount) {
  const prog = player.components.progress;
  if (!prog) return { leveled: 0 };
  const fromLevel = prog.level;
  prog.xp += amount;

  let leveled = 0;
  while (prog.xp >= xpForNext(prog.level)) {
    prog.xp -= xpForNext(prog.level);
    prog.level += 1;
    leveled += 1;
    prog.unspent_points = (prog.unspent_points || 0) + 1;
  }
  return { leveled, fromLevel, toLevel: prog.level };
}

// Constitution also bumps max HP and tops off; others are flat counters.
export function allocateStat(player, stat) {
  const prog = player.components.progress;
  if (!prog || (prog.unspent_points || 0) <= 0) return false;
  if (!ALLOCATABLE_STATS.includes(stat)) return false;
  const stats = player.components.stats;
  stats[stat] = (stats[stat] || 0) + 1;
  if (stat === 'constitution') {
    const hp = player.components.health;
    hp.max += HP_PER_CONSTITUTION_POINT;
    hp.current = hp.max;
  }
  prog.unspent_points -= 1;
  return true;
}
