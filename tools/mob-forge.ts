// CLI for the mob one-shot. Dry-run + offline stub by default.
//   npx tsx tools/mob-forge.ts --theme "sunken bog cult" --level 8 --count 3
//   FORGE_LIVE=1 npx tsx tools/mob-forge.ts --theme "..." --live        # real call
//   ... --commit                                                        # write files
import yaml from 'js-yaml';
import { forgeMobs, commitForge, type MobBrief } from '../forge/lib/mob-forge.ts';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const brief: MobBrief = {
  theme: arg('theme', 'a nameless dread') ?? 'a nameless dread',
  biome: arg('biome'),
  level: Number(arg('level', '5')),
  count: Number(arg('count', '3')),
};
const live = has('live');
const commit = has('commit');

const res = await forgeMobs(brief, { live });

console.log(`# ${live ? 'LIVE' : 'STUB'} — ${res.mobs.length} mob(s), ${res.minted.length} minted, ${res.reused.length} reused\n`);
console.log(yaml.dump({ mobs: res.mobs }, { lineWidth: 120, noRefs: true }));
if (res.minted.length) {
  console.log('# minted abilities');
  console.log(yaml.dump(res.minted, { lineWidth: 120, noRefs: true }));
}
console.log(`reused: ${[...new Set(res.reused)].join(', ') || '(none)'}`);
if (res.problems.length) {
  console.log('\nproblems:');
  for (const p of res.problems) console.log(`  ${p.startsWith('warn:') || p.includes('warn:') ? '⚠' : '✗'} ${p.replace('warn: ', '')}`);
}

const blocking = res.problems.filter((p) => !p.includes('warn:'));
if (commit) {
  if (blocking.length) { console.error(`\nrefusing to commit: ${blocking.length} blocking problem(s)`); process.exit(1); }
  const files = commitForge(res);
  console.log(`\nwrote ${files.length} file(s):`);
  for (const f of files) console.log(`  ${f.replace(process.cwd() + '/', '')}`);
} else {
  console.log(`\n(dry run — pass --commit to write ${res.mobs.length} mob + ${res.minted.length} ability file(s))`);
}
