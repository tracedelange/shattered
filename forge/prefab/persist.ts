// Prefab-run persistence. Each generate→lint→repair run gets its own directory
// so outputs are inspectable and shareable after the fact:
//   prefab-runs/<id>/meta.json      { runId, startedAt, model, brief }
//   prefab-runs/<id>/events.jsonl   every emitted event (full IO replay)
//   prefab-runs/<id>/final.json     the final candidate in engine prefab format
//   prefab-runs/<id>/report.md      human/AI-readable summary (grid, legend, defects)

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LintResult, PrefabBrief, PrefabCandidate, PrefabEvent } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PREFAB_RUNS_DIR = join(__dirname, '..', 'prefab-runs');

export interface PrefabRun {
  runId: string;
  dir: string;
}

export interface StepSummary {
  iteration: number;
  phase: 'generate' | 'repair';
  ok: boolean;
  defects: string[];
  parseError?: string;
}

export function startPrefabRun(brief: PrefabBrief, model: string, startedAt: number): PrefabRun {
  const runId = `prefab_${startedAt}`;
  const dir = join(PREFAB_RUNS_DIR, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ runId, startedAt, model, brief }, null, 2));
  return { runId, dir };
}

export function appendPrefabEvent(dir: string, e: PrefabEvent): void {
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(e) + '\n');
}

/** The engine loads prefabs as JSON with exactly these keys. */
function toEnginePrefab(c: PrefabCandidate): PrefabCandidate {
  return { id: c.id, description: c.description, data: c.data, legend: c.legend, anchors: c.anchors };
}

function buildReport(
  brief: PrefabBrief,
  model: string,
  ok: boolean,
  iterations: number,
  steps: StepSummary[],
  candidate?: PrefabCandidate,
  lint?: LintResult,
): string {
  const lines: string[] = [];
  lines.push(`# Prefab run — ${brief.name}`);
  lines.push('');
  lines.push(`- **Outcome:** ${ok ? `✓ clean in ${iterations} iteration(s)` : `✗ unresolved after ${iterations} iteration(s)`}`);
  lines.push(`- **Model:** ${model}`);
  lines.push(`- **Brief:** ${brief.width}×${brief.height}, tileset \`${brief.tileset}\``);
  if (brief.notes) lines.push(`- **Notes:** ${brief.notes}`);
  lines.push('');
  lines.push('## Iterations');
  for (const s of steps) {
    const verdict = s.parseError ? `parse error: ${s.parseError}` : s.ok ? 'clean' : `${s.defects.length} defect(s)`;
    lines.push(`- #${s.iteration} (${s.phase}): ${verdict}`);
    for (const d of s.defects) lines.push(`    - ${d}`);
  }
  lines.push('');
  if (candidate) {
    lines.push('## Final candidate');
    lines.push(`\`${candidate.id ?? '(no id)'}\` — ${candidate.description ?? ''}`);
    lines.push('');
    lines.push('```');
    lines.push(candidate.data ?? '');
    lines.push('```');
    lines.push('');
    lines.push('Legend: ' + Object.entries(candidate.legend ?? {}).map(([k, v]) => `\`${k}\`→${v}`).join(', '));
    if (candidate.anchors && Object.keys(candidate.anchors).length) {
      lines.push('Anchors: ' + Object.entries(candidate.anchors).map(([k, v]) => `\`${k}\`→${v}`).join(', '));
    }
    if (lint && !lint.ok) {
      lines.push('');
      lines.push('Remaining defects:');
      for (const d of lint.defects) lines.push(`- ${d}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function finishPrefabRun(
  run: PrefabRun,
  brief: PrefabBrief,
  model: string,
  ok: boolean,
  iterations: number,
  steps: StepSummary[],
  candidate?: PrefabCandidate,
  lint?: LintResult,
): void {
  writeFileSync(
    join(run.dir, 'summary.json'),
    JSON.stringify({ runId: run.runId, model, ok, iterations, defects: lint?.defects ?? [], stats: lint?.stats }, null, 2),
  );
  if (candidate) writeFileSync(join(run.dir, 'final.json'), JSON.stringify(toEnginePrefab(candidate), null, 2));
  writeFileSync(join(run.dir, 'report.md'), buildReport(brief, model, ok, iterations, steps, candidate, lint));
}
