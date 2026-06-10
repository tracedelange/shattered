// Loop driver — runs implementer until no pending opportunities remain, then
// runs gardener to produce a fresh batch, and repeats. Stops cleanly when
// the LLM reports a session/usage limit, when the gardener produces no
// new pending items, or when a max-cycle safety cap is hit.
//
// Usage:
//   npx tsx pipeline/loop.ts                          # broad expansion
//   npx tsx pipeline/loop.ts --anchor village_3_8     # region-scoped loop (recommended)
//   npx tsx pipeline/loop.ts --anchor village_3_8 --radius 2
//   npx tsx pipeline/loop.ts --prompt "<focus>"       # pass focus to gardener
//   LOOP_MAX_CYCLES=10 npx tsx pipeline/loop.ts       # cap cycles
//
// --anchor/--radius forward to the gardener so its metrics + opportunity scope
// stay bounded to the region neighborhood (the documented anchor workflow).
// Without --anchor the gardener runs broad: its metrics context is still
// bounded, but it computes grid metrics for every zone in the world.
//
// Each cycle: drain implementer, then one gardener pass. A cycle counts each
// gardener pass; implementer runs within a cycle are unbounded but bounded
// indirectly by the opportunity count the gardener produces.

import { spawn } from 'node:child_process';
import { OPPS_FILE, readYaml, fileExists } from './lib/io.ts';
import { USAGE_LIMIT_EXIT_CODE } from './lib/llm.ts';
import type { OpportunitiesFile } from './lib/types.ts';

// Matched against implementer stderr to know when to trigger a gardener pass.
const NO_PENDING_PATTERN = /No opportunities with status="pending"/;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Args {
  focus: string | null;
  maxCycles: number;
  requireApproved: boolean;
  noCommit: boolean;
  anchor: string | null;
  radius: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    focus: null,
    maxCycles: Number(process.env.LOOP_MAX_CYCLES ?? 20),
    requireApproved: false,
    noCommit: false,
    anchor: null,
    radius: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prompt') args.focus = argv[++i] ?? null;
    else if (a === '--max-cycles') args.maxCycles = Number(argv[++i]);
    else if (a === '--require-approved') args.requireApproved = true;
    else if (a === '--no-commit' || a === '--skip-commit') args.noCommit = true;
    else if (a === '--anchor') args.anchor = argv[++i] ?? null;
    else if (a === '--radius') args.radius = Number(argv[++i]);
  }
  return args;
}

function spawnPipeline(script: string, scriptArgs: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', script, ...scriptArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b) => { out.push(b); process.stdout.write(b); });
    child.stderr.on('data', (b) => { err.push(b); process.stderr.write(b); });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

// Pipelines exit with USAGE_LIMIT_EXIT_CODE when the model stops on a usage /
// rate limit (see UsageLimitError in lib/llm.ts).
function isSessionLimit(r: RunResult): boolean {
  return r.code === USAGE_LIMIT_EXIT_CODE;
}

function countPending(): number {
  if (!fileExists(OPPS_FILE)) return 0;
  const opps = readYaml<OpportunitiesFile>(OPPS_FILE);
  return (opps?.opportunities ?? []).filter((o) => o.status === 'pending').length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.error(
    `[loop] starting. max-cycles=${args.maxCycles}` +
    (args.anchor ? ` anchor=${args.anchor}${args.radius != null ? ` radius=${args.radius}` : ''}` : ' (broad)') +
    (args.focus ? ` focus="${args.focus.slice(0, 80)}"` : ''),
  );

  for (let cycle = 1; cycle <= args.maxCycles; cycle++) {
    console.error(`\n[loop] === cycle ${cycle}/${args.maxCycles} ===`);

    // Drain implementer until no pending remain (or until something stops us).
    let implementerRuns = 0;
    while (true) {
      const implArgs: string[] = [];
      if (args.requireApproved) implArgs.push('--require-approved');
      if (args.noCommit) implArgs.push('--no-commit');
      console.error(`[loop] implementer run #${++implementerRuns}`);
      const r = await spawnPipeline('pipeline/implementer.ts', implArgs);
      const combined = r.stdout + '\n' + r.stderr;

      if (isSessionLimit(r)) {
        console.error('\n[loop] session limit reached during implementer. Stopping cleanly.');
        return;
      }
      if (NO_PENDING_PATTERN.test(combined)) {
        console.error('[loop] implementer reports no more pending. Moving to gardener.');
        break;
      }
      if (r.code !== 0) {
        console.error(`[loop] implementer exited with code ${r.code}. Stopping.`);
        return;
      }
    }

    // One gardener pass to refresh opportunities. When anchored, the gardener
    // scopes its metrics + opportunity set to the region neighborhood, keeping
    // the loop runnable on a large world.
    console.error('[loop] running gardener...');
    const gardArgs: string[] = [];
    if (args.anchor) { gardArgs.push('--anchor', args.anchor); }
    if (args.radius != null) { gardArgs.push('--radius', String(args.radius)); }
    if (args.focus) { gardArgs.push('--prompt', args.focus); }
    const g = await spawnPipeline('pipeline/gardener.ts', gardArgs);

    if (isSessionLimit(g)) {
      console.error('\n[loop] session limit reached during gardener. Stopping cleanly.');
      return;
    }
    if (g.code !== 0) {
      console.error(`[loop] gardener exited with code ${g.code}. Stopping.`);
      return;
    }

    const pending = countPending();
    if (pending === 0) {
      console.error('[loop] gardener produced no new pending opportunities. Nothing left to do.');
      return;
    }
    console.error(`[loop] gardener produced ${pending} pending opportunities. Continuing.`);
  }

  console.error(`\n[loop] reached max cycles (${args.maxCycles}). Stopping.`);
}

// Handle Ctrl-C so children get killed and we print a clean stop line.
let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.error('\n[loop] SIGINT — finishing in-flight child, then stopping.');
});

main().catch((err) => {
  console.error('[loop] fatal:', err);
  process.exit(1);
});
