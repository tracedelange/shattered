// Gardener — reads the world, calls the LLM, writes opportunities.yaml.
//
// Usage:
//   npx tsx pipeline/gardener.ts                          # broad sweep
//   npx tsx pipeline/gardener.ts --dry-run                # print; don't write
//   npx tsx pipeline/gardener.ts --prompt "<focus>"       # focused investigation
//   npx tsx pipeline/gardener.ts --prompt-file <path>     # focus from file
//   echo "<focus>" | npx tsx pipeline/gardener.ts --prompt-stdin
//
// A focus prompt steers the Gardener toward a specific concern ("the tavern
// feels sparse", "audit the goblin faction's reach", etc.) while still
// producing the same opportunities.yaml format. The coherence rules in the
// system prompt still apply.

import { readFileSync } from 'node:fs';
import { GARDENER_SYSTEM } from './lib/prompts.ts';
import { HISTORY_FILE, OPPS_FILE, fileExists, readYaml, writeYaml } from './lib/io.ts';
import { loadWorldBundle, formatWorldContext, formatPipelineState } from './lib/worldSummary.ts';
import { callAndValidate } from './lib/validate.ts';
import { OpportunitiesFileSchema, type Opportunity, type OpportunitiesFile } from './lib/schemas.ts';
import type { HistoryFile } from './lib/types.ts';

interface Args {
  dryRun: boolean;
  focus: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, focus: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--prompt') args.focus = argv[++i] ?? null;
    else if (a === '--prompt-file') {
      const path = argv[++i];
      if (!path) throw new Error('--prompt-file requires a path');
      args.focus = readFileSync(path, 'utf8').trim();
    } else if (a === '--prompt-stdin') {
      args.focus = readFileSync(0, 'utf8').trim();
    }
  }
  if (args.focus !== null && args.focus.length === 0) args.focus = null;
  return args;
}

// Returns the highest numeric suffix used by any known opportunity ID,
// across both opportunities.yaml and history.yaml. New opps must use IDs
// strictly above this value so the global ID sequence stays monotonic.
function collectKnownIds(): { ids: Set<string>; maxNum: number } {
  const ids = new Set<string>();
  let maxNum = 0;
  const consume = (id: unknown) => {
    if (typeof id !== 'string') return;
    ids.add(id);
    const m = id.match(/(\d+)\s*$/);
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  };
  if (fileExists(OPPS_FILE)) {
    const opps = readYaml<OpportunitiesFile>(OPPS_FILE);
    for (const o of opps.opportunities ?? []) consume(o.id);
  }
  if (fileExists(HISTORY_FILE)) {
    const hist = readYaml<HistoryFile>(HISTORY_FILE);
    for (const e of hist.entries ?? []) consume(e.opportunity_id);
  }
  return { ids, maxNum };
}

// Belt-and-suspenders enforcement: rewrite any "new" ID (one not present in
// the prior known set) to a fresh, strictly-increasing slot. Existing IDs
// (carry-forwards) keep their numbers. Returns the list of {old, new}
// rewrites for logging.
function enforceMonotonicIds(
  opps: Opportunity[],
  known: { ids: Set<string>; maxNum: number },
): { from: string; to: string }[] {
  const rewrites: { from: string; to: string }[] = [];
  let next = known.maxNum + 1;
  const pad = (n: number) => `opp_${String(n).padStart(3, '0')}`;
  for (const op of opps) {
    if (known.ids.has(op.id)) continue;
    const fresh = pad(next++);
    if (fresh !== op.id) rewrites.push({ from: op.id, to: fresh });
    op.id = fresh;
  }
  return rewrites;
}

function buildUserMessage(focus: string | null, nextId: string): string {
  const base = [
    'Analyze the world above and produce an updated opportunities.yaml.',
    '',
    'Carry forward still-relevant pending opportunities unchanged (keep',
    'their existing IDs). Mark stale ones as status: superseded.',
    `Any NEW opportunity you add must use an ID of ${nextId} or higher`,
    '(monotonically increasing). NEVER reuse an ID from this file or from',
    'history.yaml — even if that opportunity is now superseded.',
    'Add new opportunities to fill gaps you identify.',
  ];

  if (focus) {
    base.push(
      '',
      '# Focus for this run',
      '',
      'A human operator has asked you to concentrate on the following.',
      'Weight opportunities that address it more heavily, but do not abandon',
      'global coherence — if the focus conflicts with the lore bible or the',
      'standing coherence rules, surface that as a refactor_lore or',
      'refactor_zone opportunity rather than violating the rules.',
      '',
      focus,
      '',
      'Aim for 3–6 opportunities, most of them addressing the focus directly.',
    );
  } else {
    base.push(
      'Aim for a balanced mix of types (not just new_zone).',
      'Aim for 4–8 total opportunities in the final list.',
    );
  }
  return base.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bundle = loadWorldBundle();
  const worldContext = formatWorldContext(bundle);
  const pipelineState = formatPipelineState(bundle);
  const known = collectKnownIds();
  const nextId = `opp_${String(known.maxNum + 1).padStart(3, '0')}`;
  const userMessage = buildUserMessage(args.focus, nextId);

  if (args.focus) {
    console.error(`[gardener] focus: ${args.focus.slice(0, 120)}${args.focus.length > 120 ? '…' : ''}`);
  }
  console.error('[gardener] calling LLM...');
  const { value: out, raw } = await callAndValidate({
    label: 'gardener',
    system: [GARDENER_SYSTEM, worldContext, pipelineState],
    user: userMessage,
    schema: OpportunitiesFileSchema,
  });

  out.generated_at = out.generated_at ?? new Date().toISOString();

  const rewrites = enforceMonotonicIds(out.opportunities, known);
  for (const r of rewrites) {
    console.error(`[gardener] rewrote ID ${r.from} → ${r.to} (collision with known IDs)`);
  }

  if (args.dryRun) {
    console.log('--- DRY RUN — would write to', OPPS_FILE, '---');
    console.log(raw);
    return;
  }

  writeYaml(OPPS_FILE, out);
  const pending = out.opportunities.filter((o) => o.status === 'pending').length;
  console.error(
    `[gardener] wrote ${out.opportunities.length} opportunities (${pending} pending) to ${OPPS_FILE}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
