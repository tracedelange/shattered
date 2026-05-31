import { ALLOCATABLE_STATS } from '../../../shared/constants.ts';
import type { PlayerEntity, StatId } from '../../../shared/types.ts';

const HP_PER_CONSTITUTION_POINT = 10;

export function xpForNext(level: number): number {
  return level * 100;
}

export interface XpResult { leveled: number; fromLevel?: number; toLevel?: number }

export function grantXp(player: PlayerEntity, amount: number): XpResult {
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

export function allocateStat(player: PlayerEntity, stat: StatId): boolean {
  const prog = player.components.progress;
  if (!prog || (prog.unspent_points || 0) <= 0) return false;
  if (!(ALLOCATABLE_STATS as readonly string[]).includes(stat)) return false;
  const stats = player.components.stats as Record<string, number | unknown>;
  stats[stat] = ((stats[stat] as number) || 0) + 1;
  if (stat === 'constitution') {
    const hp = player.components.health;
    hp.max += HP_PER_CONSTITUTION_POINT;
    hp.current = hp.max;
  }
  prog.unspent_points -= 1;
  return true;
}
