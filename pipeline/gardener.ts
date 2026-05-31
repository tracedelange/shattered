// Gardener — reads the world, calls the LLM, writes opportunities.yaml.
//
// Usage:
//   npx tsx pipeline/gardener.ts            # produce/update opportunities
//   npx tsx pipeline/gardener.ts --dry-run  # print result; do not write

import { callLlm, parseYaml } from './lib/llm.ts';
import { GARDENER_SYSTEM } from './lib/prompts.ts';
import { OPPS_FILE, writeYaml } from './lib/io.ts';
import { loadWorldBundle, formatWorldContext, formatPipelineState } from './lib/worldSummary.ts';
import type { OpportunitiesFile } from './lib/types.ts';

interface Args {
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  return { dryRun: argv.includes('--dry-run') };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bundle = loadWorldBundle();
  const worldContext = formatWorldContext(bundle);
  const pipelineState = formatPipelineState(bundle);

  const userMessage = [
    'Analyze the world above and produce an updated opportunities.yaml.',
    '',
    'Carry forward still-relevant pending opportunities unchanged.',
    'Mark stale ones as status: superseded.',
    'Add new opportunities to fill gaps you identify.',
    'Aim for a balanced mix of types (not just new_zone).',
    'Aim for 4–8 total opportunities in the final list.',
  ].join('\n');

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
