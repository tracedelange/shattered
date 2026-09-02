// Self-directed niche-mob exploration — NO operator-authored theme/biome list.
// Each call sees the ENTIRE existing mob roster (live world/entities/mobs plus
// every candidate already proposed earlier in this run) and a level/role gap
// breakdown, and is told to invent a concept that doesn't overlap any of it —
// the model decides what fits this world's established weave, not an input
// file. Output is staged to CANDIDATE files under forge/out/mob-candidates/ —
// this never writes to world/entities/mobs or world/abilities. Review the
// candidates and promote the ones you like by hand.
//
//   npx tsx tools/mob-forge-explore.ts --target 100                 # stub, dry
//   FORGE_LIVE=1 npx tsx tools/mob-forge-explore.ts --target 100 --live
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgeMobs, writeCandidates, type MobBrief, type RosterEntry } from '../forge/lib/mob-forge.ts';
import { WILD_BIOMES } from '../shared/worldgen/field.ts';
import type { AbilityDef } from '../shared/types.ts';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const target = Number(arg('target', '100'));
// At most this many candidates may share one concept_axis before the loop bans
// that axis from further calls (and re-rolls if the model returns it anyway) —
// the repulsion mechanism that stops the run collapsing into a single biome.
const maxPerAxis = Number(arg('max-per-axis', '2'));
const maxRerolls = Number(arg('max-rerolls', '2'));
// Restrict the run to a subset of biomes with --biomes swamp,forest (default: all).
const biomeFilter = arg('biomes', '').split(',').map((s) => s.trim()).filter(Boolean);
const biomes = biomeFilter.length ? WILD_BIOMES.filter((b) => biomeFilter.includes(b)) : [...WILD_BIOMES];
const bands = arg('bands', '0-5,5-10,10-15,15-20,20-25')
  .split(',')
  .map((b) => { const [lo, hi] = b.split('-').map(Number); return { lo: lo!, hi: hi! }; });
const outDir = arg('out', join('forge', 'out', 'mob-candidates'));
const live = has('live');

mkdirSync(outDir, { recursive: true });
const logPath = join(outDir, `run.${Date.now()}.log`);
function log(line: string): void {
  console.log(line);
  appendFileSync(logPath, `${line}\n`, 'utf8');
}

log(`# mob-forge-explore — target ${target} concept(s), ${live ? 'LIVE' : 'STUB'}, bands: ${bands.map((b) => `${b.lo}-${b.hi}`).join(', ')}`);
log(`# biomes (loop-assigned, rotated): ${biomes.join(', ')}`);
log(`# candidates dir: ${outDir}`);
log(`# log: ${logPath}`);

// Threaded across the whole run (not just within one forgeMobs call) so
// concept #47 knows what concepts #1-46 already were, even though none of
// them are committed to disk yet.
const extraRoster: RosterEntry[] = [];
const extraPool: AbilityDef[] = [];
// (biome, concept_axis) -> how many candidates already claim that niche within
// that biome. A niche at/over maxPerAxis is "over-represented" FOR ITS BIOME:
// it's banned from later prompts in that biome and any mob that still returns it
// is re-rolled. Scoped per-biome so "bog-amphibian" being full in swamp doesn't
// ban an unrelated niche elsewhere.
const axisCounts = new Map<string, number>();
const axisKey = (biome: string, axis: string) => `${biome}\t${axis}`;
const overRepresented = (biome: string): string[] =>
  [...axisCounts].filter(([k, n]) => k.startsWith(`${biome}\t`) && n >= maxPerAxis).map(([k]) => k.split('\t')[1]!);
let written = 0, failed = 0;

for (let i = 0; i < target; i++) {
  const band = bands[i % bands.length]!;
  // Biome and band rotate at different periods (8 vs 5) so their combinations
  // desync and the run covers biome×band pairs rather than locking in phase.
  const biome = biomes[i % biomes.length]!;
  const level = band.lo + Math.floor(Math.random() * (band.hi - band.lo + 1));
  const brief: MobBrief = { biome, level, level_min: band.lo, level_max: band.hi, count: 1 };

  log(`\n=== [${i + 1}/${target}] ${biome}, band ${band.lo}-${band.hi}, level ${level} ===`);

  // Try up to maxRerolls+1 times to get a mob whose niche isn't over-represented
  // in this biome.
  let res: Awaited<ReturnType<typeof forgeMobs>> | undefined;
  let accepted = false;
  for (let attempt = 0; attempt <= maxRerolls; attempt++) {
    const avoidAxes = overRepresented(biome);
    if (attempt === 0 && avoidAxes.length) log(`  ${biome} niches already covered: ${avoidAxes.join(', ')}`);
    try {
      res = await forgeMobs(brief, { live, extraRoster, extraPool, fullRoster: true, assignSprite: false, avoidAxes });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`  ✗ forgeMobs threw, skipping: ${message}`);
      break;
    }
    const banned = new Set(avoidAxes);
    const clash = res.axes.filter((a) => banned.has(a));
    if (clash.length && attempt < maxRerolls) {
      log(`  ↻ re-roll ${attempt + 1}/${maxRerolls}: model returned covered ${biome} niche (${clash.join(', ')})`);
      continue;
    }
    if (clash.length) log(`  ⚠ accepting covered niche after ${maxRerolls} re-rolls: ${clash.join(', ')}`);
    accepted = true;
    break;
  }
  if (!res || !accepted) { failed++; continue; }

  for (const p of res.problems) log(`  ${p.includes('warn:') ? '⚠' : '✗'} ${p.replace('warn: ', '')}`);

  const blocking = res.problems.filter((p) => !p.includes('warn:'));
  if (blocking.length) {
    log(`  skipping candidate write: ${blocking.length} blocking problem(s)`);
    failed++;
    continue;
  }

  const files = writeCandidates(res, outDir);
  written += res.mobs.length;
  log(`  wrote ${files.length} file(s): ${files.map((f) => f.split('/').pop()).join(', ')}${res.axes.length ? ` [${biome}: ${res.axes.join(', ')}]` : ` [${biome}, no niche declared]`}`);

  for (const a of res.axes) axisCounts.set(axisKey(biome, a), (axisCounts.get(axisKey(biome, a)) ?? 0) + 1);
  extraPool.push(...res.minted);
  for (const mob of res.mobs) {
    extraRoster.push({
      id: String(mob.id), name: String(mob.name), role: String(mob.role),
      behavior: String(mob.behavior), level: Number(mob.level),
    });
  }
}

// Per-biome breakdown: how many candidates and which niches landed in each.
const byBiome = new Map<string, { total: number; niches: string[] }>();
for (const [k, n] of axisCounts) {
  const [biome, axis] = k.split('\t') as [string, string];
  const e = byBiome.get(biome) ?? { total: 0, niches: [] };
  e.total += n;
  e.niches.push(`${axis}×${n}`);
  byBiome.set(biome, e);
}
log(`\n=== Done: ${written} concept(s) written, ${failed} skipped, ${target} attempted ===`);
log(`Biome spread (${byBiome.size} biome(s), ${axisCounts.size} distinct niches):`);
for (const [biome, e] of [...byBiome].sort((a, b) => b[1].total - a[1].total)) {
  log(`  ${biome} (${e.total}): ${e.niches.join(', ')}`);
}
log(`Review candidates in ${outDir}, then promote the ones you like.`);
