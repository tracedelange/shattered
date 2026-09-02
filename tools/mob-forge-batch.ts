// Batch runner over tools/mob-forge.ts — loops forgeMobs/commitForge across a
// list of briefs read from a JSON config. Commits after each brief (not just
// at the end) so later briefs' loadAbilityPool() sees earlier briefs' minted
// abilities and reuses them instead of re-minting near-duplicates.
//
// Built for unattended runs: a brief whose forgeMobs() call throws (network
// blip, API error) is logged and skipped rather than aborting the rest of the
// run, and all output is teed to a log file since nobody's watching the
// terminal.
//   npx tsx tools/mob-forge-batch.ts tools/mob-forge-batch.example.json
//   FORGE_LIVE=1 npx tsx tools/mob-forge-batch.ts batch.json --live --commit
import { readFileSync, appendFileSync } from 'node:fs';
import { forgeMobs, commitForge, type MobBrief } from '../forge/lib/mob-forge.ts';

const has = (name: string) => process.argv.includes(`--${name}`);
const live = has('live');
const commit = has('commit');

const configPath = process.argv[2];
if (!configPath || configPath.startsWith('--')) {
  console.error('Usage: mob-forge-batch <briefs.json> [--live] [--commit]');
  process.exit(1);
}

const briefs = JSON.parse(readFileSync(configPath, 'utf8')) as MobBrief[];
if (!Array.isArray(briefs) || !briefs.length) {
  console.error(`${configPath} must contain a non-empty JSON array of briefs`);
  process.exit(1);
}

const logPath = `${configPath.replace(/\.json$/, '')}.${Date.now()}.log`;
function log(line: string): void {
  console.log(line);
  appendFileSync(logPath, `${line}\n`, 'utf8');
}

log(`# mob-forge-batch — ${briefs.length} brief(s), ${live ? 'LIVE' : 'STUB'}, ${commit ? 'commit' : 'dry run'}`);
log(`# log: ${logPath}`);

let totalMobs = 0, totalMinted = 0, totalWritten = 0, totalBlocked = 0;
const failed: { i: number; theme: string; error: string }[] = [];

for (const [i, brief] of briefs.entries()) {
  log(`\n=== [${i + 1}/${briefs.length}] ${brief.theme} (level ${brief.level}, count ${brief.count}) ===`);
  let res;
  try {
    res = await forgeMobs(brief, { live });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`  ✗ forgeMobs threw, skipping this brief: ${message}`);
    failed.push({ i, theme: brief.theme ?? '(untitled)', error: message });
    continue;
  }
  log(`${live ? 'LIVE' : 'STUB'} — ${res.mobs.length} mob(s), ${res.minted.length} minted, ${res.reused.length} reused`);
  for (const p of res.problems) log(`  ${p.includes('warn:') ? '⚠' : '✗'} ${p.replace('warn: ', '')}`);

  totalMobs += res.mobs.length;
  totalMinted += res.minted.length;

  const blocking = res.problems.filter((p) => !p.includes('warn:'));
  if (blocking.length) {
    totalBlocked += blocking.length;
    log(`  refusing to commit this brief: ${blocking.length} blocking problem(s)`);
    continue;
  }
  if (commit) {
    const files = commitForge(res);
    totalWritten += files.length;
    log(`  wrote ${files.length} file(s)`);
  }
}

log(`\n=== Done: ${totalMobs} mob(s) across ${briefs.length} brief(s), ${totalMinted} ability(ies) minted, ${totalWritten} file(s) written, ${totalBlocked} blocked, ${failed.length} brief(s) failed ===`);
if (failed.length) {
  log('# failed briefs (re-run these individually):');
  for (const f of failed) log(`  [${f.i + 1}] ${f.theme} — ${f.error}`);
}
if (!commit) log('(dry run — pass --commit to write files)');
