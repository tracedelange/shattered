// TTK combat sim — tunes mob HP / unarmed damage against the TTK anchor in
// docs/plan-combat-retune.md. Run: npx tsx tools/combat-sim.ts
//
// Swings are driven straight through combat's damage core, so this uses the
// actual rollDamage / totalDefense / dodge code paths — no formula duplication.
// Reach is deliberately not modelled: the sim is a damage-per-swing harness, and
// who can reach whom is the ability executor's business (see attackAbilityFor).

import { applyResolvedDamage, rollDamage } from '../server/game/systems/combat.ts';
import { makeMob } from '../server/game/entities.ts';
import type { MobRole, PlayerEntity, MobTemplate } from '../shared/types.ts';

/** One unmitigated swing from att into tgt, through the real mitigation path. */
function swing(att: Parameters<typeof rollDamage>[0], tgt: Parameters<typeof rollDamage>[0]): void {
  applyResolvedDamage(att, tgt, rollDamage(att));
}

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
      knownAbilities: {},
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
      swing(att, tgt);
      hits++;
    }
    total += hits;
  }
  return total / runs;
}

const ROLES: MobRole[] = ['pest', 'soldier', 'ranged', 'support', 'tank'];

function row(label: string, makeP: () => any, pLvl: number, mLvl: number, role: MobRole): void {
  const mob = makeSimMob(mLvl, role);
  const hp = mob.components.health.max;
  const killsIn = avgHitsToKill(makeP, () => makeSimMob(mLvl, role));
  const dmg = mob.components.stats.damage;
  const maxDmg = Array.isArray(dmg) ? dmg[1] : dmg;
  const mobDmgZero = maxDmg === 0;
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

console.log('═══ Unarmed vs mobs 3 levels BELOW (should WIN comfortably) ═══\n');
for (const pLvl of [5, 8, 10]) {
  console.log(`── Player L${pLvl} vs L${pLvl - 3} mobs ──`);
  for (const role of ROLES) row(role, () => makeFighter(pLvl), pLvl, pLvl - 3, role);
  console.log();
}

console.log('═══ +3-level gap: mob HP vs player HP (should be WELL above) ═══\n');
for (const pLvl of [2, 5, 7]) {
  const p = makeFighter(pLvl);
  console.log(`── Player L${pLvl} (HP ${p.components.health.max}) vs L${pLvl + 3} mobs ──`);
  for (const role of ROLES) {
    const mob = makeSimMob(pLvl + 3, role);
    const mhp = mob.components.health.max;
    const ratio = (mhp / p.components.health.max).toFixed(2);
    console.log(`  ${role.padEnd(11)} mobHP=${String(mhp).padStart(3)}  ${ratio}× player HP`);
  }
  console.log();
}

console.log('═══ Step 4: geared (iron sword + iron set), level parity ═══\n');
for (const level of [5, 10]) {
  console.log(`── Level ${level} ──`);
  for (const role of ROLES) row(role, () => makeGearedFighter(level), level, level, role);
  console.log();
}
