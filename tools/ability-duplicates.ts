// Reports functional duplicates in world/abilities/ (same effect, different
// name) using the dedup signature the generator will use to reuse-vs-mint.
// Run: npx tsx tools/ability-duplicates.ts [--sigs]  (--sigs lists every sig)

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { validateAbilityDef } from '../server/world/ability_schema.ts';
import { abilitySignature, duplicateGroups } from '../forge/lib/ability-dedup.ts';

const DIR = join(process.cwd(), 'world', 'abilities');
const defs = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => validateAbilityDef(yaml.load(readFileSync(join(DIR, f), 'utf8')), f));

if (process.argv.includes('--sigs')) {
  for (const d of defs.sort((a, b) => abilitySignature(a).localeCompare(abilitySignature(b)))) {
    console.log(`${abilitySignature(d).padEnd(48)} ${d.id}`);
  }
  console.log('');
}

const dupes = duplicateGroups(defs);
if (dupes.length === 0) {
  console.log(`${defs.length} abilities · no functional duplicates`);
} else {
  console.log(`${defs.length} abilities · ${dupes.length} duplicate group(s):\n`);
  for (const g of dupes) console.log(`  [${g.ids.join(', ')}]\n    ${g.signature}`);
}
