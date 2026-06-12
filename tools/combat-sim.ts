// TTK combat sim — tunes mob HP / unarmed damage against the TTK anchor in
// docs/plan-combat-retune.md. Run: npx tsx tools/combat-sim.ts
//
// resolveAttack() ignores its `world` arg, so we can drive real combat with
// constructed entities placed adjacent in the same zone. This uses the actual
// rollDamage / totalDefense / dodge code paths — no formula duplication.

import { resolveAttack } from '../server/game/systems/combat.ts';
import { makeMob } from '../server/game/entities.ts';
import type { MobRole, PlayerEntity, MobTemplate } from '../shared/types.ts';
import type { World } from '../server/game/world.ts';

const dummyWorld = null as unknown as World;

// Canonical unarmed fighter build. Starts STR 8 / CON 6 (see CLASSES), gains
// 1 point per level; we spend ~60% into STR, the rest into CON.
function makeFighter(level: number): PlayerEntity {
  const pts = level - 1;
  const strAdds = Math.round(pts * 0.6);
  const conAdds = pts - strAdds;
  const strength = 8 + strAdds;
  const constitution = 6 + conAdds;
  const maxHp = 100 + (constitution - 5) * 10;
  return {
    id: 'sim-player',
    type: 'player',
    name: 'Sim',
    klass: 'fighter',
    position: { zone: 'sim', x: 0, y: 0 },
    facing: 'south',
    nextActTick: 0,
    nextRegenTick: 0,
    components: {
      health: { current: maxHp, max: maxHp },
      inventory: { slots: [] },
      equipment: {} as PlayerEntity['components']['equipment'],
      wallet: { gold: 0 },
      stats: { strength, dexterity: 4, intelligence: 4, constitution, speed: 1.0, damage: [3, 6] },
      progress: { level, xp: 0, unspent_points: 0 },
      quests: { active: [], completed: [] },
    },
  } as PlayerEntity;
}

// Geared fighter: iron sword (dmg [4,7], STR:D/DEX:E) + full iron set (~20 def).
function makeGearedFighter(level: number): PlayerEntity {
  const p = makeFighter(level);
  const eq = p.components.equipment as Record<string, unknown>;
  const armorRoll = (lo: number, hi: number) => ({
    item: { components: { equipment: { rolled: { defense: [lo, hi] } } } },
  });
  eq.mainhand = {
    item: { components: { equipment: { rolled: { damage: [4, 7], scaling: { strength: 'D', dexterity: 'E' } } } } },
  };
  eq.helmet = armorRoll(3, 5);
  eq.chest = armorRoll(4, 7);
  eq.gloves = armorRoll(2, 4);
  eq.leggings = armorRoll(3, 5);
  eq.boots = armorRoll(2, 3);
  return p;
}

function makeSimMob(level: number, role: MobRole): ReturnType<typeof makeMob> {
  const template: MobTemplate = {
    id: `sim-${role}`, name: role, sprite: 'x',
    level, role, speed: 1.0, behavior: 'aggressive', aggro_range: 5,
  };
  const mob = makeMob(template, { zone: 'sim', x: 1, y: 0 });
  return mob;
}

// Average hits-to-kill: attacker swings at target until target dies.
function avgHitsToKill(makeAtt: () => any, makeTgt: () => any, runs = 4000): number {
  let total = 0;
  for (let i = 0; i < runs; i++) {
    const att = makeAtt();
    const tgt = makeTgt();
    let hits = 0;
    while ((tgt.components.health.current ?? 0) > 0 && hits < 1000) {
      resolveAttack(dummyWorld, att, tgt);
      hits++;
    }
    total += hits;
  }
  return total / runs;
}

const ROLES: MobRole[] = ['pest', 'skirmisher', 'soldier', 'brute', 'tank'];

function row(label: string, makeP: () => any, pLvl: number, mLvl: number, role: MobRole): void {
  const mob = makeSimMob(mLvl, role);
  const hp = mob.components.health.max;
  const killsIn = avgHitsToKill(makeP, () => makeSimMob(mLvl, role));
  const mobDmgZero = mob.components.stats.damage?.[1] === 0;
  const diesIn = mobDmgZero ? Infinity : avgHitsToKill(() => makeSimMob(mLvl, role), makeP);
  const win = diesIn > killsIn ? 'WIN ' : 'LOSE';
  console.log(
    `  ${label.padEnd(11)} mobHP=${String(hp).padStart(3)}  killsIn=${killsIn.toFixed(1).padStart(5)}  ` +
    `diesIn=${(diesIn === Infinity ? '∞' : diesIn.toFixed(1)).padStart(5)}  ${win}`,
  );
}

console.log('TTK anchor: at level parity, unarmed player kills in ~5-6 hits, dies in ~8-10.');
console.log('(non-tank roles should satisfy diesIn > killsIn → player wins)\n');

console.log('═══ Unarmed, level parity ═══\n');
for (const level of [1, 2, 3, 5, 7, 10]) {
  console.log(`── Level ${level} ──`);
  for (const role of ROLES) row(role, () => makeFighter(level), level, level, role);
  console.log();
}

console.log('═══ Step 2: L3 player vs L2 mob (level advantage) ═══\n');
for (const role of ROLES) row(role, () => makeFighter(3), 3, 2, role);
console.log();

console.log('═══ Step 4: geared (iron sword + iron set), level parity ═══\n');
for (const level of [5, 10]) {
  console.log(`── Level ${level} ──`);
  for (const role of ROLES) row(role, () => makeGearedFighter(level), level, level, role);
  console.log();
}
