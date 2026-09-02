// Offline proof of the co-mint resolver — no API, no writes. Feeds a kit that
// hits all three paths and prints the resolution. Run: npx tsx tools/test-ability-mint.ts
import { loadAbilityPool, resolveAbilityKit, type KitEntry } from '../forge/lib/ability-mint.ts';
import type { AbilityDef } from '../shared/types.ts';

const pool = loadAbilityPool();

// A near-duplicate of the existing ember_spit (single-target-ish fire projectile);
// should be REUSED, not minted, even though its numbers/name differ.
const fireNukeDup: AbilityDef = {
  id: 'flame_lance', name: 'Flame Lance', actor: 'mob',
  targeting: { shape: 'projectile', range: 6 },
  cast: { cost: {}, cooldown_ticks: 12 },
  effects: [{ kind: 'damage', base: [30, 44], brand: 'fire_damage' }],
};

// A genuinely-new function: an electricity projectile that also stuns — nothing
// in the library does this (fills a design-space gap). Should be MINTED.
const shockBolt: AbilityDef = {
  id: 'shock_bolt', name: 'Shock Bolt', actor: 'mob',
  targeting: { shape: 'projectile', range: 7 },
  cast: { cost: {}, cooldown_ticks: 18 },
  effects: [
    { kind: 'damage', base: [6, 10], brand: 'electricity_damage' },
    { kind: 'modifier', stats: {}, duration_ticks: 6, cc: ['stun'] },
  ],
};

const kit: KitEntry[] = ['web_shot', fireNukeDup, shockBolt, 'not_a_real_ability'];
const res = resolveAbilityKit(kit, pool);

console.log(`pool: ${pool.length} abilities\n`);
console.log('refs   :', res.refs.join(', '));
console.log('reused :', res.reused.join(', ') || '(none)');
console.log('minted :', res.minted.map((m) => m.id).join(', ') || '(none)');
console.log('\nproblems:');
for (const p of res.problems) console.log(`  ${p.startsWith('warn:') ? '⚠' : '✗'} ${p.replace(/^warn:\s*/, '')}`);
