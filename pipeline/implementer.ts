// Implementer — picks the top pending opportunity, asks the LLM to build it,
// writes the resulting YAML files, updates the lore bible and history.
//
// Usage:
//   npx tsx pipeline/implementer.ts                          # top pending
//   npx tsx pipeline/implementer.ts --opportunity opp_008    # specific id
//   npx tsx pipeline/implementer.ts --dry-run                # don't write
//   npx tsx pipeline/implementer.ts --require-approved       # only "approved"

import { join } from 'node:path';
import yaml from 'js-yaml';
import { IMPLEMENTER_SYSTEM } from './lib/prompts.ts';
import {
  HISTORY_FILE, LORE_FILE, OPPS_FILE, REPO_ROOT,
  readText, readYaml, writeText, writeYaml, fileExists,
} from './lib/io.ts';
import { loadWorldBundle, formatWorldContext } from './lib/worldSummary.ts';
import { callAndValidate } from './lib/validate.ts';
import {
  ImplementerOutputSchema,
  type LoreUpdate,
  type Opportunity,
  type OpportunitiesFile,
} from './lib/schemas.ts';
import type { HistoryFile, OpportunityStatus } from './lib/types.ts';

interface Args {
  dryRun: boolean;
  opportunityId: string | null;
  requireApproved: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, opportunityId: null, requireApproved: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--require-approved') args.requireApproved = true;
    else if (a === '--opportunity') args.opportunityId = argv[++i] ?? null;
  }
  return args;
}

interface LoreBible {
  [key: string]: unknown;
  factions?: unknown[];
  geography?: unknown[];
  zones?: unknown[];
  unresolved?: string[];
}

// Pull leading comment block (the file header) out of bible.yaml so we can
// re-attach it after re-dumping the parsed YAML. js-yaml drops comments on
// round-trip, but the header is the only one worth preserving.
function splitLoreHeader(text: string): { header: string; body: string } {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trimStart().startsWith('#'))) {
    i++;
  }
  return {
    header: lines.slice(0, i).join('\n'),
    body: lines.slice(i).join('\n'),
  };
}

function mergeLore(bible: LoreBible, update: LoreUpdate): void {
  const appendInto = (key: 'zones' | 'factions' | 'geography', items?: unknown[]) => {
    if (!items || items.length === 0) return;
    bible[key] = [...(bible[key] ?? []), ...items];
  };
  appendInto('zones', update.zones_append);
  appendInto('factions', update.factions_append);
  appendInto('geography', update.geography_append);

  if (update.unresolved_resolve?.length) {
    const remaining = (bible.unresolved ?? []).filter((entry) => {
      const e = String(entry);
      return !update.unresolved_resolve!.some((needle) => e.includes(needle));
    });
    bible.unresolved = remaining;
  }
  if (update.unresolved_append?.length) {
    bible.unresolved = [...(bible.unresolved ?? []), ...update.unresolved_append];
  }
}

function pickOpportunity(file: OpportunitiesFile, args: Args): Opportunity {
  const pool = file.opportunities ?? [];
  if (args.opportunityId) {
    const found = pool.find((o) => o.id === args.opportunityId);
    if (!found) throw new Error(`Opportunity ${args.opportunityId} not found.`);
    return found;
  }
  const eligibleStatus: OpportunityStatus = args.requireApproved ? 'approved' : 'pending';
  const eligible = pool
    .filter((o) => o.status === eligibleStatus)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  if (eligible.length === 0) {
    throw new Error(`No opportunities with status="${eligibleStatus}" found.`);
  }
  return eligible[0];
}

function validatePath(rel: string): string {
  // Refuse anything that tries to escape the repo or touch unrelated files.
  const cleaned = rel.replace(/^\.\/+/, '');
  if (cleaned.startsWith('/') || cleaned.includes('..')) {
    throw new Error(`Unsafe path from LLM: ${rel}`);
  }
  const allowedPrefixes = ['world/zones/', 'world/entities/', 'world/quests/'];
  if (!allowedPrefixes.some((p) => cleaned.startsWith(p))) {
    throw new Error(`LLM tried to write outside allowed dirs: ${rel}`);
  }
  if (!cleaned.endsWith('.yaml')) {
    throw new Error(`LLM tried to write non-yaml file: ${rel}`);
  }
  return join(REPO_ROOT, cleaned);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!fileExists(OPPS_FILE)) {
    throw new Error(`No opportunities file at ${OPPS_FILE}. Run gardener first.`);
  }
  const opps = readYaml<OpportunitiesFile>(OPPS_FILE);
  const opportunity = pickOpportunity(opps, args);
  console.error(
    `[implementer] picked ${opportunity.id} (${opportunity.type}, priority=${opportunity.priority})`,
  );

  const bundle = loadWorldBundle();
  const worldContext = formatWorldContext(bundle);
  const oppYaml = yaml.dump(opportunity, { lineWidth: -1, noRefs: true });

  const userMessage = [
    'Implement the opportunity below. Respond with the fenced YAML described',
    'in your system prompt.',
    '',
    '```yaml',
    oppYaml.trim(),
    '```',
  ].join('\n');

  console.error('[implementer] calling LLM...');
  const { value: out, raw } = await callAndValidate({
    label: 'implementer',
    system: [IMPLEMENTER_SYSTEM, worldContext],
    user: userMessage,
    schema: ImplementerOutputSchema,
  });

  // No-op outcome: empty files[] + notes means the LLM concluded nothing
  // needs to be written (e.g. the entity already exists). The schema
  // already enforces "notes required when files[] is empty".
  const isNoOp = out.files.length === 0;

  // Resolve and check every path before writing anything.
  const resolved = out.files.map((f) => ({
    abs: validatePath(f.path),
    rel: f.path,
    op: f.op,
    body: f.body,
  }));

  if (args.dryRun) {
    console.log('--- DRY RUN — would write the following ---');
    for (const f of resolved) {
      console.log(`\n# ${f.op} ${f.rel}\n${f.body}`);
    }
    if (out.lore_update) {
      console.log(`\n# merge into ${LORE_FILE}\n${yaml.dump(out.lore_update)}`);
    }
    if (out.notes) console.log(`\n# history note: ${out.notes}`);
    return;
  }

  const written: string[] = [];
  const modified: string[] = [];
  for (const f of resolved) {
    const exists = fileExists(f.abs);
    writeText(f.abs, f.body.endsWith('\n') ? f.body : f.body + '\n');
    (exists ? modified : written).push(f.rel);
    console.error(`[implementer] ${f.op === 'modify' || exists ? 'modified' : 'wrote'} ${f.rel}`);
  }

  if (out.lore_update && Object.keys(out.lore_update).length > 0) {
    const raw = readText(LORE_FILE);
    const { header, body } = splitLoreHeader(raw);
    const bible = (yaml.load(body) ?? {}) as LoreBible;
    mergeLore(bible, out.lore_update);
    const dumped = yaml.dump(bible, { lineWidth: -1, noRefs: true });
    writeText(LORE_FILE, (header ? header.replace(/\s*$/, '\n\n') : '') + dumped);
    modified.push('world/lore/bible.yaml');
  }

  // Resolve the opportunity's final status. Default is 'implemented' when we
  // wrote files; for a no-op we default to 'superseded'. The LLM can override.
  const finalStatus: OpportunityStatus = out.status ?? (isNoOp ? 'superseded' : 'implemented');
  opportunity.status = finalStatus;
  (opportunity as Record<string, unknown>).implemented_at = new Date().toISOString();
  writeYaml(OPPS_FILE, opps);

  // Append to history.yaml.
  const history = fileExists(HISTORY_FILE)
    ? readYaml<HistoryFile>(HISTORY_FILE)
    : { entries: [] };
  history.entries = history.entries ?? [];
  history.entries.push({
    opportunity_id: opportunity.id,
    implemented_at: new Date().toISOString(),
    files_written: written,
    files_modified: modified,
    notes: out.notes ?? '',
  });
  writeYaml(HISTORY_FILE, history);

  if (isNoOp) {
    console.error(`[implementer] no-op: ${opportunity.id} → ${finalStatus}. ${out.notes}`);
  } else {
    console.error(`[implementer] done. ${written.length} written, ${modified.length} modified. status=${finalStatus}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
