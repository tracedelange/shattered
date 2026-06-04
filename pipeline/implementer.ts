// Implementer — picks the top pending opportunity, asks the LLM to build it,
// writes the resulting YAML files, updates the lore bible and history.
//
// Usage:
//   npx tsx pipeline/implementer.ts                          # top pending
//   npx tsx pipeline/implementer.ts --opportunity opp_008    # specific id
//   npx tsx pipeline/implementer.ts --dry-run                # don't write
//   npx tsx pipeline/implementer.ts --require-approved       # only "approved"

import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { IMPLEMENTER_SYSTEM } from './lib/prompts.ts';
import {
  HISTORY_FILE, LORE_FILE, OPPS_FILE, REPO_ROOT, TILESETS_DIR,
  readText, readYaml, writeText, writeYaml, fileExists, listJsonFiles,
} from './lib/io.ts';
import { loadWorldBundle, formatWorldContext } from './lib/worldSummary.ts';
import { callAndValidate } from './lib/validate.ts';
import { renderZoneToFile } from './lib/renderZone.ts';
import { loadWorld } from '../server/world/loader.ts';
import {
  ImplementerOutputSchema,
  type LoreUpdate,
  type TilesetUpdate,
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

// Find the tileset JSON whose `name` field matches `name`. Returns the absolute
// path or null if no file claims that name. We resolve by `name`, not filename,
// because the loader keys tilesets by their declared name.
function resolveTilesetPath(name: string): string | null {
  if (!/^[a-z0-9_]+$/i.test(name)) {
    throw new Error(`tileset_update.tileset has unsafe characters: ${name}`);
  }
  for (const path of listJsonFiles(TILESETS_DIR)) {
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as { name?: string };
      if (doc.name === name) return path;
    } catch {
      // skip unparseable file
    }
  }
  return null;
}

interface TilesetDoc {
  name?: string;
  tile_size?: number;
  tiles?: Record<string, { color: string } & Record<string, unknown>>;
  sprites?: Record<string, { color: string } & Record<string, unknown>>;
  [k: string]: unknown;
}

// Returns { added_tiles, added_sprites } so we can log what changed.
function applyTilesetUpdate(update: TilesetUpdate): {
  path: string;
  rel: string;
  added_tiles: string[];
  added_sprites: string[];
} {
  const path = resolveTilesetPath(update.tileset);
  if (!path) throw new Error(`tileset_update target not found: ${update.tileset}`);
  const doc = JSON.parse(readFileSync(path, 'utf8')) as TilesetDoc;
  doc.tiles = doc.tiles ?? {};
  doc.sprites = doc.sprites ?? {};

  const addedTiles: string[] = [];
  const addedSprites: string[] = [];
  for (const [k, v] of Object.entries(update.tiles_add ?? {})) {
    if (k in doc.tiles) continue; // skip existing — never overwrite by mistake
    doc.tiles[k] = v;
    addedTiles.push(k);
  }
  for (const [k, v] of Object.entries(update.sprites_add ?? {})) {
    if (k in doc.sprites) continue;
    doc.sprites[k] = v;
    addedSprites.push(k);
  }

  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const rel = path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path;
  return { path, rel, added_tiles: addedTiles, added_sprites: addedSprites };
}

function mergeLore(bible: LoreBible, update: LoreUpdate): void {
  const u = update as LoreUpdate & {
    zones_replace?: unknown[];
    factions_replace?: unknown[];
    geography_replace?: unknown[];
    unresolved_replace?: string[];
  };

  for (const key of ['zones', 'factions', 'geography'] as const) {
    const replace = u[`${key}_replace`];
    if (replace !== undefined) {
      bible[key] = replace;
    } else {
      const append = update[`${key}_append`];
      if (append && append.length > 0) bible[key] = [...(bible[key] ?? []), ...append];
    }
  }

  if (u.unresolved_replace !== undefined) {
    bible.unresolved = u.unresolved_replace;
  } else {
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

  // A response is a no-op only if it writes no files AND has no lore /
  // tileset side-effects. A tileset-only or lore-only response is real work.
  const isNoOp =
    out.files.length === 0 && !out.lore_update && !out.tileset_update;

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
    if (out.tileset_update) {
      console.log(`\n# merge into tileset ${out.tileset_update.tileset}\n${JSON.stringify(out.tileset_update, null, 2)}`);
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

  let tilesetAbsPath: string | null = null;
  if (out.tileset_update) {
    const r = applyTilesetUpdate(out.tileset_update);
    if (r.added_tiles.length + r.added_sprites.length === 0) {
      console.error(`[implementer] tileset_update on ${out.tileset_update.tileset}: no new entries (all already present)`);
    } else {
      console.error(
        `[implementer] tileset_update on ${out.tileset_update.tileset}: ` +
        `+${r.added_tiles.length} tiles [${r.added_tiles.join(', ')}], ` +
        `+${r.added_sprites.length} sprites [${r.added_sprites.join(', ')}]`,
      );
      tilesetAbsPath = r.path;
      modified.push(r.rel);
    }
  }

  // Resolve the opportunity's final status. Default is 'implemented' when we
  // wrote files; for a no-op we default to 'superseded'. The LLM can override.
  const finalStatus: OpportunityStatus = out.status ?? (isNoOp ? 'superseded' : 'implemented');
  opportunity.status = finalStatus;
  (opportunity as Record<string, unknown>).implemented_at = new Date().toISOString();
  writeYaml(OPPS_FILE, opps);

  // Force-render every zone YAML touched in this run. This is the "be honest"
  // mechanism — the LLM may have rendered during its session, but we render
  // again here so the artifact always reflects the final canonical YAML.
  const touchedZoneIds = Array.from(new Set(
    resolved
      .filter(f => f.rel.startsWith('world/zones/') && f.rel.endsWith('.yaml'))
      .map(f => f.rel.replace(/^world\/zones\//, '').replace(/\.yaml$/, '')),
  ));
  const renders: string[] = [];
  if (touchedZoneIds.length > 0) {
    const fresh = loadWorld(join(REPO_ROOT, 'world'));
    for (const zoneId of touchedZoneIds) {
      const zoneDef = fresh.zones[zoneId];
      if (!zoneDef) {
        console.error(`[implementer] render skipped: ${zoneId} not found post-write`);
        continue;
      }
      const tilesetName = (zoneDef as { tileset?: string }).tileset || 'overworld';
      const tileset = fresh.tilesets[tilesetName];
      if (!tileset) {
        console.error(`[implementer] render skipped: tileset '${tilesetName}' missing for ${zoneId}`);
        continue;
      }
      const outRel = `world/renders/${zoneId}.png`;
      const outAbs = join(REPO_ROOT, outRel);
      try {
        renderZoneToFile(zoneDef, tileset, outAbs, { mobs: fresh.mobs });
        renders.push(outRel);
        console.error(`[implementer] rendered ${outRel}`);
      } catch (err) {
        console.error(`[implementer] render failed for ${zoneId}: ${(err as Error).message}`);
      }
    }
  }

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
    ...(renders.length > 0 ? { renders } : {}),
  });
  writeYaml(HISTORY_FILE, history);

  if (isNoOp) {
    console.error(`[implementer] no-op: ${opportunity.id} → ${finalStatus}. ${out.notes}`);
  } else {
    console.error(`[implementer] done. ${written.length} written, ${modified.length} modified. status=${finalStatus}`);

    const stagedFiles = [
      ...resolved.map(f => f.abs),
      OPPS_FILE,
      HISTORY_FILE,
      ...(out.lore_update && Object.keys(out.lore_update).length > 0 ? [LORE_FILE] : []),
      ...(tilesetAbsPath ? [tilesetAbsPath] : []),
    ];

    try {
      execSync(`git add ${stagedFiles.map(p => `"${p}"`).join(' ')}`, { cwd: REPO_ROOT });
      execSync(
        `git commit -m "Implement ${opportunity.id} (${opportunity.type})\n\n${out.notes ?? ''}"`,
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );
      execSync('git push', { cwd: REPO_ROOT, stdio: 'pipe' });
      console.error(`[implementer] committed and pushed ${opportunity.id}`);
    } catch (err) {
      console.error('[implementer] git commit/push failed:', (err as Error).message);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
