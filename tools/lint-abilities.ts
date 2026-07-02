// Runs the ability semantic gate (forge/lib/lint-ability.ts) over every authored
// ability in world/abilities/. Doubles as the regression fixture: the whole
// hand-authored library must pass clean (no blocking problems), so a future
// generator can be held to the same bar. Run: npx tsx tools/lint-abilities.ts
//
// Exit code is non-zero if any BLOCKING problem is found (warn: entries don't
// fail the run) so it can gate CI / a generation loop.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { lintAbilityRaw } from '../forge/lib/lint-ability.ts';

const DIR = join(process.cwd(), 'world', 'abilities');
const files = readdirSync(DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

let blocking = 0;
let warnings = 0;

for (const file of files.sort()) {
  const raw = yaml.load(readFileSync(join(DIR, file), 'utf8'));
  try {
    const { problems } = lintAbilityRaw(raw, file);
    const blockers = problems.filter((p) => !p.startsWith('warn:'));
    const warns = problems.filter((p) => p.startsWith('warn:'));
    blocking += blockers.length;
    warnings += warns.length;
    if (problems.length === 0) continue;
    console.log(`\n${file}`);
    for (const p of blockers) console.log(`  ✗ ${p}`);
    for (const p of warns) console.log(`  ⚠ ${p.replace(/^warn:\s*/, '')}`);
  } catch (err) {
    // A schema failure (thrown by validateAbilityDef) — treat as blocking.
    blocking++;
    console.log(`\n${file}`);
    console.log(`  ✗ ${(err as Error).message.split('\n').slice(1).join(' ').trim() || (err as Error).message}`);
  }
}

console.log(`\n${files.length} abilities · ${blocking} blocking · ${warnings} warnings`);
process.exit(blocking > 0 ? 1 : 0);
