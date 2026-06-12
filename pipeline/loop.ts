// Loop driver — runs implementer until no pending opportunities remain, then
// runs gardener to produce a fresh batch, and repeats. Stops cleanly when
// the LLM reports a session/usage limit, when the gardener produces no
// new pending items, or when a max-cycle safety cap is hit.
//
// Usage:
//   npx tsx pipeline/loop.ts                          # broad expansion
//   npx tsx pipeline/loop.ts --sticky                 # rotate region-by-region (recommended)
//   npx tsx pipeline/loop.ts --anchor village_3_8     # region-scoped loop (one region)
//   npx tsx pipeline/loop.ts --anchor village_3_8 --radius 2
//   npx tsx pipeline/loop.ts --prompt "<focus>"       # pass focus to gardener
//   LOOP_MAX_CYCLES=10 npx tsx pipeline/loop.ts       # cap cycles
//   LOOP_MAX_CYCLES_PER_ANCHOR=6 npx tsx pipeline/loop.ts --sticky
//
// --anchor/--radius forward to the gardener so its metrics + opportunity scope
// stay bounded to the region neighborhood (the documented anchor workflow).
// Without --anchor the gardener runs broad: its metrics context is still
// bounded, but it computes grid metrics for every zone in the world.
//
// --sticky turns the loop into deliberate region-by-region buildout: it pins
// one zone's neighborhood as the anchor and keeps developing it until the
// region saturates (the gardener finds no new work for it, or a per-anchor
// cycle cap is hit), then advances to the next region. Advancement is outward
// world fill: the next anchor is the nearest UNDEVELOPED zone (dev-score 0) to
// the center — wilderness or an undeveloped settlement — so content grows
// ring-by-ring from spawn and the wilderness between settlements gets filled,
// rather than hopping town to town. The center defaults to
// PREFERRED_STARTING_ZONE; override with --center <zone> (or --anchor, which
// also seeds the center in sticky mode). Stops when no reachable undeveloped
// zone remains.
//
// Each cycle: drain implementer, then one gardener pass. A cycle counts each
// gardener pass; implementer runs within a cycle are unbounded but bounded
// indirectly by the opportunity count the gardener produces.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { OPPS_FILE, REPO_ROOT, readYaml, fileExists } from './lib/io.ts';
import { USAGE_LIMIT_EXIT_CODE } from './lib/llm.ts';
import { loadWorld } from '../server/world/loader.ts';
import { computeWorldMetrics } from './lib/worldMetrics.ts';
import { pickFrontierAnchor } from './lib/anchor.ts';
import { loadSagas, isSagaOpen } from './lib/sagas.ts';
import { PREFERRED_STARTING_ZONE } from '../shared/constants.ts';
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
  sticky: boolean;
  center: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    focus: null,
    maxCycles: Number(process.env.LOOP_MAX_CYCLES ?? 3),
    requireApproved: false,
    noCommit: false,
    anchor: null,
    radius: null,
    sticky: false,
    center: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prompt') args.focus = argv[++i] ?? null;
    else if (a === '--max-cycles') args.maxCycles = Number(argv[++i]);
    else if (a === '--require-approved') args.requireApproved = true;
    else if (a === '--no-commit' || a === '--skip-commit') args.noCommit = true;
    else if (a === '--anchor') args.anchor = argv[++i] ?? null;
    else if (a === '--radius') args.radius = Number(argv[++i]);
    else if (a === '--sticky') args.sticky = true;
    else if (a === '--center') args.center = argv[++i] ?? null;
  }
  return args;
}

// Default neighborhood radius when --sticky must select/score anchors itself.
const DEFAULT_RADIUS = 3;
// A region is force-advanced after this many cycles even if the gardener keeps
// finding work, so one region can't monopolize the loop. Override via env.
const MAX_CYCLES_PER_ANCHOR = Number(process.env.LOOP_MAX_CYCLES_PER_ANCHOR ?? 4);

// Next region to develop: the nearest undeveloped zone (dev-score 0) to the
// center — wilderness or undeveloped settlement — so content fills outward
// ring-by-ring from spawn. Returns null when no reachable undeveloped zone
// remains. Loads the world fresh so dev scores reflect content added this run.
function selectNextAnchor(
  saturated: Set<string>,
  center: string,
): { anchorId: string; score: number; distance: number; saga?: string } | null {
  const defs = loadWorld(join(REPO_ROOT, 'world'));
  const sagas = loadSagas().sagas;

  // Sagas drive selection: an open arc's region keeps the loop until the arc
  // completes (or its anchor was force-retired into `saturated`). This is what
  // makes the loop finish a story instead of fanning out uniformly.
  const openSaga = sagas.find(
    (s) => isSagaOpen(s) && !saturated.has(s.anchor_zone) && !!defs.zones[s.anchor_zone],
  );
  if (openSaga) {
    return { anchorId: openSaga.anchor_zone, score: 0, distance: 0, saga: openSaga.id };
  }

  const metrics = computeWorldMetrics(defs, undefined, sagas);
  return pickFrontierAnchor(defs, metrics, center, saturated);
}

/** True when an open saga is anchored on this zone — used to let the loop run a
 *  saga region past the per-anchor cycle cap so an arc isn't abandoned mid-way. */
function hasOpenSagaAt(anchor: string): boolean {
  return loadSagas().sagas.some((s) => s.anchor_zone === anchor && isSagaOpen(s));
}

// Delay between successive pipeline calls (implementer/gardener), to avoid
// hammering the LLM endpoint / rate limits. Skipped before the very first call.
const CALL_DELAY_MS = Number(process.env.LOOP_CALL_DELAY_MS ?? 60_000);
let hasRunCall = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnPipeline(script: string, scriptArgs: string[]): Promise<RunResult> {
  if (hasRunCall && CALL_DELAY_MS > 0) {
    console.error(`[loop] waiting ${Math.round(CALL_DELAY_MS / 1000)}s before next call...`);
    await sleep(CALL_DELAY_MS);
  }
  hasRunCall = true;
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
  const radius = args.radius ?? DEFAULT_RADIUS;
  // Expansion origin: explicit --center, else --anchor as a starting point,
  // else the player spawn village. Sticky growth radiates outward from here.
  const center = args.center ?? args.anchor ?? PREFERRED_STARTING_ZONE;

  // Sticky-rotation state. In sticky mode the anchor is always chosen by
  // outward-from-center selection, so it starts unset; non-sticky pins --anchor.
  const saturated = new Set<string>();
  let currentAnchor: string | null = args.sticky ? null : args.anchor;
  let cyclesOnAnchor = 0;

  console.error(
    `[loop] starting. max-cycles=${args.maxCycles}` +
    (args.sticky ? ` (sticky, filling undeveloped zones outward from ${center}, ${MAX_CYCLES_PER_ANCHOR} cycles/region, radius ${radius})` : '') +
    (!args.sticky && args.anchor ? ` anchor=${args.anchor}${args.radius != null ? ` radius=${args.radius}` : ''}` : '') +
    (!args.sticky && !args.anchor ? ' (broad)' : '') +
    (args.focus ? ` focus="${args.focus.slice(0, 80)}"` : ''),
  );

  for (let cycle = 1; cycle <= args.maxCycles; cycle++) {
    // Sticky: make sure we have a region to work on this cycle. Selection is
    // the nearest undeveloped zone to the center, reflecting content added so
    // far — the frontier moves outward as the developed blob grows.
    if (args.sticky && !currentAnchor) {
      const picked = selectNextAnchor(saturated, center);
      if (!picked) {
        console.error('[loop] no undeveloped zones reachable from center remain — world filled. Stopping.');
        return;
      }
      currentAnchor = picked.anchorId;
      cyclesOnAnchor = 0;
      console.error(
        picked.saga
          ? `[loop] saga anchor → ${currentAnchor} (open saga '${picked.saga}'; ${saturated.size} region(s) done)`
          : `[loop] frontier anchor → ${currentAnchor} ` +
            `(${picked.distance} hop(s) from ${center}; ${saturated.size} region(s) done)`,
      );
    }

    console.error(
      `\n[loop] === cycle ${cycle}/${args.maxCycles} ===` +
      (args.sticky && currentAnchor ? ` region=${currentAnchor} (${cyclesOnAnchor + 1}/${MAX_CYCLES_PER_ANCHOR})` : ''),
    );

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
    const activeAnchor = args.sticky ? currentAnchor : args.anchor;
    if (activeAnchor) { gardArgs.push('--anchor', activeAnchor); }
    if (args.radius != null) { gardArgs.push('--radius', String(args.radius)); }
    else if (args.sticky) { gardArgs.push('--radius', String(radius)); }
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

    // Sticky: decide whether the current region is done. Because the drain
    // above cleared all pending, pending===0 here means the anchored gardener
    // found no new work for this region → saturated. Otherwise keep developing
    // it until the per-anchor cycle cap forces a move.
    if (args.sticky && currentAnchor) {
      if (pending === 0) {
        saturated.add(currentAnchor);
        console.error(`[loop] region '${currentAnchor}' saturated — no new work. Advancing.`);
        currentAnchor = null;
        continue;
      }
      cyclesOnAnchor++;
      console.error(`[loop] gardener produced ${pending} pending for '${currentAnchor}'. Continuing.`);
      // The per-anchor cap stops a region monopolizing the loop — but a region
      // with an open saga is SUPPOSED to monopolize it until the arc finishes,
      // so the cap doesn't retire it (the 0-pending stall above still does).
      if (cyclesOnAnchor >= MAX_CYCLES_PER_ANCHOR) {
        if (hasOpenSagaAt(currentAnchor)) {
          console.error(`[loop] region '${currentAnchor}' hit cycle cap but its saga is unfinished — staying.`);
        } else {
          saturated.add(currentAnchor);
          console.error(`[loop] region '${currentAnchor}' hit cycle cap (${MAX_CYCLES_PER_ANCHOR}). Advancing.`);
          currentAnchor = null;
        }
      }
      continue;
    }

    // Non-sticky: original behavior — stop when the world has no more work.
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
