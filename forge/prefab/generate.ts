// The prefab generate → lint → repair loop. One-shot grid generation is blind:
// the model never sees its 2D output, so it ships hollow boxes. We make it a loop
// where deterministic lint (lint.ts) is the reviewer — its defects are fed back
// as text alongside the model's own rendered grid until the prefab is clean or we
// hit the iteration cap. Text-only, so it works with local (Ollama) models too.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLlm, parseYaml } from '../../pipeline/lib/llm.ts';
import { BLOCKING_TILES } from '../../shared/constants.ts';
import { lintPrefab } from './lint.ts';
import { startPrefabRun, appendPrefabEvent, finishPrefabRun, type StepSummary } from './persist.ts';
import type { LintResult, PrefabBrief, PrefabCandidate, PrefabEmit } from './types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface TilesetFile {
  tiles: Record<string, { color: string; blocking?: boolean }>;
}

function loadTileset(name: string): TilesetFile {
  return JSON.parse(readFileSync(join(ROOT, 'world', 'tilesets', `${name}.json`), 'utf8'));
}

/** Blocking set = global blockers ∪ tileset-flagged ∪ anything named like a wall. */
function blockingFor(ts: TilesetFile): Set<string> {
  const set = new Set<string>(BLOCKING_TILES);
  for (const [name, t] of Object.entries(ts.tiles)) {
    if (t.blocking || name.endsWith('wall')) set.add(name);
  }
  return set;
}

const prefabModel = () =>
  process.env.FORGE_PREFAB_MODEL ?? process.env.PIPELINE_MODEL ?? 'claude-sonnet-4-6';

function systemPrompt(brief: PrefabBrief, ts: TilesetFile): string {
  const tileList = Object.keys(ts.tiles).map((t) => `  - ${t}`).join('\n');
  return [
    'You design hand-scale PREFAB set-pieces for a top-down grid MMO. A prefab is',
    'an ASCII grid plus a legend mapping each character to a tile, plus optional',
    'anchors mapping a character to a gameplay tag (portal, spawn, loot, boss…).',
    '',
    `TILESET '${brief.tileset}' — legend tiles MUST be one of these names:`,
    tileList,
    '',
    'HARD RULES (a deterministic linter rejects violations and you will be asked to fix them):',
    `  - The grid is EXACTLY ${brief.width} wide × ${brief.height} tall. Every row is ${brief.width} characters.`,
    '  - Every character used in the grid has a legend entry.',
    '  - All walkable (non-wall) tiles form ONE connected region — no sealed-off pockets.',
    '  - NOT a hollow box: include internal walls, pillars, doorways, or sub-rooms.',
    '  - Every declared anchor character appears in the grid and sits on a walkable tile.',
    '',
    'OUTPUT — respond with ONE ```yaml fenced block and nothing else:',
    '```yaml',
    'id: snake_case_id',
    'name: "Display Name"',
    'description: "one line"',
    'data: |',
    '  #####',
    '  #...#',
    '  #.P.#',
    '  #####',
    'legend:',
    '  "#": wall',
    '  ".": stone_floor',
    '  "P": portal',
    'anchors:',
    '  "P": descend',
    '```',
    'Use a YAML block scalar (data: |) for the grid; quote every legend/anchor key.',
  ].join('\n');
}

function briefPrompt(brief: PrefabBrief): string {
  return [
    '# Brief',
    `Name: ${brief.name}`,
    `Size: ${brief.width}×${brief.height} (width×height)`,
    brief.notes ? `Notes: ${brief.notes}` : '',
    '',
    'Produce the prefab.',
  ].filter(Boolean).join('\n');
}

/** Re-render the model's own grid + concrete defects so it can repair what it can't "see". */
function repairPrompt(prefab: PrefabCandidate, lint: LintResult): string {
  return [
    'Your prefab failed validation. Here is the grid you produced:',
    '```',
    prefab.data,
    '```',
    `Stats: ${lint.stats.cols}×${lint.stats.rows}, ` +
      `${lint.stats.walkable} walkable / ${lint.stats.blocked} blocked, ` +
      `${lint.stats.walkableRegions} region(s), ${(lint.stats.wallFraction * 100).toFixed(0)}% solid.`,
    '',
    'DEFECTS to fix:',
    ...lint.defects.map((d) => `  - ${d}`),
    '',
    'Output the corrected prefab as one ```yaml block, same format. Fix every defect.',
  ].join('\n');
}

export async function generatePrefab(
  brief: PrefabBrief,
  emit: PrefabEmit,
  signal?: AbortSignal,
): Promise<void> {
  let ts: TilesetFile;
  try {
    ts = loadTileset(brief.tileset);
  } catch {
    emit({ type: 'prefab_error', message: `Unknown tileset '${brief.tileset}' (world/tilesets/).` });
    return;
  }
  const blocking = blockingFor(ts);
  const tileColors = Object.fromEntries(Object.entries(ts.tiles).map(([k, v]) => [k, v.color]));
  const maxIterations = Math.max(1, Number(process.env.FORGE_PREFAB_ITERS ?? 3));
  const model = prefabModel();

  // Persist every run to its own dir; `record` both streams and saves each event.
  const run = startPrefabRun(brief, model, Date.now());
  const record: PrefabEmit = (e) => { try { appendPrefabEvent(run.dir, e); } catch { /* disk best-effort */ } emit(e); };
  const steps: StepSummary[] = [];

  record({ type: 'prefab_start', brief, tileColors, maxIterations });

  const system = systemPrompt(brief, ts);
  let user = briefPrompt(brief);
  let lastPrefab: PrefabCandidate | undefined;
  let lastLint: LintResult | undefined;

  for (let iter = 1; iter <= maxIterations; iter++) {
    const phase: 'generate' | 'repair' = iter === 1 ? 'generate' : 'repair';
    let raw: string;
    try {
      raw = await callLlm({ label: `prefab-${phase}-${iter}`, model, signal, system: [system], user });
    } catch (err) {
      record({ type: 'prefab_error', message: err instanceof Error ? err.message : String(err) });
      finishPrefabRun(run, brief, model, false, iter - 1, steps, lastPrefab, lastLint);
      return;
    }

    let prefab: PrefabCandidate | undefined;
    let parseError: string | undefined;
    try {
      prefab = parseYaml<PrefabCandidate>(raw);
      if (!prefab || typeof prefab.data !== 'string' || typeof prefab.legend !== 'object') {
        throw new Error('missing data/legend');
      }
    } catch (err) {
      parseError = `Could not parse prefab: ${err instanceof Error ? err.message : String(err)}`;
    }

    const lint = prefab ? lintPrefab(prefab, brief, { blockingTiles: blocking }) : undefined;
    record({ type: 'prefab_step', iteration: iter, phase, prompt: user, raw, prefab, lint, parseError });
    steps.push({ iteration: iter, phase, ok: !!lint?.ok, defects: lint?.defects ?? [], parseError });

    if (prefab) lastPrefab = prefab;
    if (lint) lastLint = lint;

    if (lint?.ok) {
      finishPrefabRun(run, brief, model, true, iter, steps, prefab, lint);
      record({ type: 'prefab_done', iterations: iter, ok: true, prefab, lint, savedTo: run.dir });
      return;
    }
    if (parseError) {
      user = `Your previous reply was not valid: ${parseError}\n\n${briefPrompt(brief)}`;
    } else if (prefab && lint) {
      user = repairPrompt(prefab, lint);
    }
  }

  finishPrefabRun(run, brief, model, false, maxIterations, steps, lastPrefab, lastLint);
  record({ type: 'prefab_done', iterations: maxIterations, ok: false, prefab: lastPrefab, lint: lastLint, savedTo: run.dir });
}
