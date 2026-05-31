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
import { callLlm, parseYaml } from './lib/llm.ts';
import { GARDENER_SYSTEM } from './lib/prompts.ts';
import { OPPS_FILE, writeYaml } from './lib/io.ts';
import { loadWorldBundle, formatWorldContext, formatPipelineState } from './lib/worldSummary.ts';
import type { OpportunitiesFile } from './lib/types.ts';

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

function buildUserMessage(focus: string | null): string {
  const base = [
    'Analyze the world above and produce an updated opportunities.yaml.',
    '',
    'Carry forward still-relevant pending opportunities unchanged.',
    'Mark stale ones as status: superseded.',
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
  const userMessage = buildUserMessage(args.focus);

  if (args.focus) {
    console.error(`[gardener] focus: ${args.focus.slice(0, 120)}${args.focus.length > 120 ? '…' : ''}`);
  }
  console.error('[gardener] calling LLM...');
  const raw = await callLlm({
    system: [GARDENER_SYSTEM, worldContext, pipelineState],
    user: userMessage,
  });

  let parsed: OpportunitiesFile;
  try {
    parsed = parseYaml<OpportunitiesFile>(raw);
  } catch (err) {
    console.error('[gardener] failed to parse LLM YAML output:\n', raw);
    throw err;
  }

  if (!parsed || !Array.isArray(parsed.opportunities)) {
    console.error('[gardener] LLM output missing opportunities[]. Raw:\n', raw);
    process.exit(1);
  }

  parsed.generated_at = parsed.generated_at ?? new Date().toISOString();

  if (args.dryRun) {
    console.log('--- DRY RUN — would write to', OPPS_FILE, '---');
    console.log(raw);
    return;
  }

  writeYaml(OPPS_FILE, parsed);
  const pending = parsed.opportunities.filter((o) => o.status === 'pending').length;
  console.error(
    `[gardener] wrote ${parsed.opportunities.length} opportunities (${pending} pending) to ${OPPS_FILE}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
