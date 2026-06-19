// The prefab generate → lint → repair loop. One-shot grid generation is blind:
// the model never sees its 2D output, so it ships hollow boxes. We make it a loop
// where deterministic lint (lint.ts) is the reviewer — its defects are fed back
// as text alongside the model's own rendered grid until the prefab is clean or we
// hit the iteration cap. Text-only, so it works with local (Ollama) models too.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { callLlm, parseYaml } from '../../pipeline/lib/llm.ts';
import { callAndValidate } from '../../pipeline/lib/validate.ts';
import { BLOCKING_TILES } from '../../shared/constants.ts';
import { lintPrefab } from './lint.ts';
import { stampShape, deriveRoles, rolesToGrid } from './shapes.ts';
import { applyOps, roleTilesFor, type PrefabOp } from './ops.ts';
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

const prefabModel = (brief: PrefabBrief) =>
  brief.model?.trim() || process.env.FORGE_PREFAB_MODEL || process.env.PIPELINE_MODEL || 'claude-sonnet-4-6';

function systemPrompt(brief: PrefabBrief, ts: TilesetFile): string {
  const blocking = blockingFor(ts);
  const tileList = Object.entries(ts.tiles)
    .map(([t, v]) => `  - ${t} (${v.color}${blocking.has(t) ? ', blocking' : ''})`)
    .join('\n');
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
    'READABILITY — the prefab is rendered as flat colored cells, so structure must',
    'show through COLOR CONTRAST. Build internal structure from blocking tiles',
    "(walls/pillars) — they're dark and read clearly. Do NOT rely on floor variants",
    '(e.g. cracked vs plain floor) to convey structure: their colors are nearly',
    'identical and render as one flat surface. Use floor variants only for flavor.',
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
    brief.purpose ? `Function: ${brief.purpose}` : '',
    brief.theme ? `Theme: ${brief.theme}` : '',
    brief.required_anchors?.length ? `Required anchors (must appear, on walkable tiles): ${brief.required_anchors.join(', ')}` : '',
    brief.notes ? `Notes: ${brief.notes}` : '',
    '',
    'Produce the prefab.',
  ].filter(Boolean).join('\n');
}

/** Re-render the model's own grid + concrete defects so it can repair what it can't "see". */
function repairPrompt(prefab: PrefabCandidate, lint: LintResult): string {
  return [
    `Your prefab "${prefab.id}" failed validation. Here is the grid you produced:`,
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
    'Revise SURGICALLY. Keep the same id, dimensions, theme, and overall layout —',
    'this is an edit, not a redesign. Make the SMALLEST change that fixes each',
    'defect: to connect disconnected regions, replace a wall tile on the boundary',
    'between two areas with a door/floor tile; to fix a hollow box, add a few',
    'interior walls/pillars. Do NOT rename the prefab or start over.',
    'Output the corrected prefab as one ```yaml block, same format.',
  ].join('\n');
}

// ─── Pass 2: staged op-selection path ─────────────────────────────────────────

const PositionSchema = z.enum(['center', 'north', 'south', 'east', 'west']);
const OpsSchema = z.object({
  ops: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('punch_door'), side: z.enum(['north', 'south', 'east', 'west']) }),
    z.object({ op: z.literal('place_portal'), at: PositionSchema, tag: z.enum(['descend', 'ascend']).optional() }),
    z.object({ op: z.literal('place_anchor'), at: PositionSchema, tag: z.string() }),
    z.object({ op: z.literal('add_pillars'), count: z.number().int().min(1).max(20) }),
    z.object({ op: z.literal('erode_walls'), amount: z.number().int().min(1).max(20) }),
  ])),
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'prefab';
const seedOf = (s: string) => [...s].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7);

function stagedSystem(): string {
  return [
    'You are decorating a prefab room whose GEOMETRY IS ALREADY FIXED and valid.',
    'You do NOT draw or edit the grid. You SELECT OPS; the engine applies them',
    'deterministically and guarantees the room stays connected.',
    '',
    'Positions are SEMANTIC (the engine resolves the cell): center, north, south, east, west.',
    '',
    'OPS:',
    '  - punch_door {side: north|south|east|west}        — open an entrance through that wall',
    '  - place_portal {at, tag: descend|ascend}          — a portal anchor (dungeon link)',
    '  - place_anchor {at, tag}                           — a gameplay anchor (loot, boss, npc, entrance)',
    '  - add_pillars {count}                              — interior pillars (auto-skips any that would block the room)',
    '  - erode_walls {amount}                            — knock gaps in walls for a ruined look',
    '',
    'Choose ops that fit the brief: satisfy every required anchor, add an entrance',
    'door, and use pillars/erosion to match the theme. Prefer a handful of purposeful',
    'ops over many.',
    '',
    'OUTPUT — one ```yaml block, an object with an `ops` array, nothing else:',
    '```yaml',
    'ops:',
    '  - { op: place_portal, at: center, tag: descend }',
    '  - { op: punch_door, side: south }',
    '  - { op: add_pillars, count: 4 }',
    '```',
  ].join('\n');
}

function stagedUser(brief: PrefabBrief, baseGrid: string): string {
  return [
    '# Base room (geometry fixed — select ops to add features/character)',
    '```',
    baseGrid,
    '```',
    `Name: ${brief.name}`,
    brief.purpose ? `Function: ${brief.purpose}` : '',
    brief.theme ? `Theme: ${brief.theme}` : '',
    brief.required_anchors?.length ? `Required anchors: ${brief.required_anchors.join(', ')}` : '',
    brief.notes ? `Notes: ${brief.notes}` : '',
    '',
    'Select the ops.',
  ].filter(Boolean).join('\n');
}

interface BuildCtx {
  brief: PrefabBrief;
  ts: TilesetFile;
  blocking: Set<string>;
  validTiles: Set<string>;
  model: string;
  maxIterations: number;
  signal?: AbortSignal;
  record: PrefabEmit;
  steps: StepSummary[];
}

interface BuildResult { ok: boolean; lastPrefab?: PrefabCandidate; lastLint?: LintResult }

async function runStaged(ctx: BuildCtx): Promise<BuildResult> {
  const { brief, ts, blocking, validTiles, model, maxIterations, signal, record, steps } = ctx;
  const tiles = roleTilesFor(Object.keys(ts.tiles));
  const base = deriveRoles(stampShape(brief.shape!, brief.width, brief.height, { seed: seedOf(brief.name) }));
  const baseGrid = rolesToGrid(base, { floor: tiles.floor, wall: tiles.wall }).data;
  const system = stagedSystem();
  let user = stagedUser(brief, baseGrid);

  let ok = false;
  let lastPrefab: PrefabCandidate | undefined;
  let lastLint: LintResult | undefined;

  for (let iter = 1; iter <= maxIterations; iter++) {
    const phase: 'generate' | 'repair' = iter === 1 ? 'generate' : 'repair';
    let ops: PrefabOp[] = [];
    let raw = '';
    let parseError: string | undefined;
    try {
      const r = await callAndValidate({ label: `prefab-ops-${iter}`, model, signal, system: [system], user, schema: OpsSchema });
      ops = r.value.ops as PrefabOp[];
      raw = r.raw;
    } catch (err) {
      if (signal?.aborted) throw err; // let abort end the run (report still written)
      parseError = `Op selection failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    let prefab: PrefabCandidate | undefined;
    let lint: LintResult | undefined;
    let note: string | undefined;
    if (!parseError) {
      const result = applyOps(base, ops, tiles, { seed: seedOf(brief.name), requireAnchors: brief.required_anchors });
      prefab = { id: slug(brief.name), description: brief.notes ?? brief.theme, data: result.data, legend: result.legend, anchors: result.anchors };
      lint = lintPrefab(prefab, brief, { blockingTiles: blocking, validTiles, checkHollow: false });
      note = `applied: ${result.applied.join(', ') || 'none'}${result.skipped.length ? ' | skipped: ' + result.skipped.join(', ') : ''}`;
    }

    record({ type: 'prefab_step', iteration: iter, phase, prompt: user, raw, prefab, lint, parseError, note });
    steps.push({ iteration: iter, phase, ok: !!lint?.ok, defects: lint?.defects ?? [], parseError });
    if (prefab) lastPrefab = prefab;
    if (lint) lastLint = lint;
    if (lint?.ok) { ok = true; break; }

    user = parseError
      ? `${parseError}\n\n${stagedUser(brief, baseGrid)}`
      : `The result still has defects: ${lint?.defects.join('; ')}. Adjust your ops.\n\n${stagedUser(brief, baseGrid)}`;
  }
  return { ok, lastPrefab, lastLint };
}

async function runDirect(ctx: BuildCtx): Promise<BuildResult> {
  const { brief, ts, blocking, validTiles, model, maxIterations, signal, record, steps } = ctx;
  const system = systemPrompt(brief, ts);
  let user = briefPrompt(brief);

  let ok = false;
  let lastPrefab: PrefabCandidate | undefined;
  let lastLint: LintResult | undefined;

  for (let iter = 1; iter <= maxIterations; iter++) {
    const phase: 'generate' | 'repair' = iter === 1 ? 'generate' : 'repair';
    const raw = await callLlm({ label: `prefab-${phase}-${iter}`, model, signal, system: [system], user });

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

    const lint = prefab ? lintPrefab(prefab, brief, { blockingTiles: blocking, validTiles }) : undefined;
    record({ type: 'prefab_step', iteration: iter, phase, prompt: user, raw, prefab, lint, parseError });
    steps.push({ iteration: iter, phase, ok: !!lint?.ok, defects: lint?.defects ?? [], parseError });
    if (prefab) lastPrefab = prefab;
    if (lint) lastLint = lint;
    if (lint?.ok) { ok = true; break; }

    user = parseError
      ? `Your previous reply was not valid: ${parseError}\n\n${briefPrompt(brief)}`
      : prefab && lint ? repairPrompt(prefab, lint) : user;
  }
  return { ok, lastPrefab, lastLint };
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
  const validTiles = new Set(Object.keys(ts.tiles));
  const tileColors = Object.fromEntries(Object.entries(ts.tiles).map(([k, v]) => [k, v.color]));
  const maxIterations = Math.max(1, Number(process.env.FORGE_PREFAB_ITERS ?? 3));
  const model = prefabModel(brief);

  // Persist every run to its own dir; `record` both streams and saves each event.
  // Both legs are guarded so a disk or socket error can never skip the `finally`.
  const run = startPrefabRun(brief, model, Date.now());
  const record: PrefabEmit = (e) => {
    try { appendPrefabEvent(run.dir, e); } catch { /* disk best-effort */ }
    try { emit(e); } catch { /* socket best-effort */ }
  };
  const steps: StepSummary[] = [];

  let ok = false;
  let lastPrefab: PrefabCandidate | undefined;
  let lastLint: LintResult | undefined;

  try {
    record({ type: 'prefab_start', brief, model, tileColors, maxIterations });

    // Staged pipeline (Pass 1 shape + Pass 2 ops) when the brief names a shape;
    // otherwise the legacy direct-paint loop.
    const ctx: BuildCtx = { brief, ts, blocking, validTiles, model, maxIterations, signal, record, steps };
    const result = brief.shape ? await runStaged(ctx) : await runDirect(ctx);
    ok = result.ok;
    lastPrefab = result.lastPrefab;
    lastLint = result.lastLint;

    record({ type: 'prefab_done', iterations: steps.length, ok, prefab: lastPrefab, lint: lastLint, savedTo: run.dir });
  } catch (err) {
    record({ type: 'prefab_error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    finishPrefabRun(run, brief, model, ok, steps.length, steps, lastPrefab, lastLint);
  }
}
