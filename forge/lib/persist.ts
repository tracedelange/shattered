// Run persistence. The event stream IS the full run state, so we append every
// event (successes AND failures, all tiers) to runs/<id>/events.jsonl as it
// happens. meta.json is written at start, summary.json at the end. A run can be
// re-loaded by replaying its events.jsonl through the same UI handler.
//
// Layout per run:
//   runs/<id>/events.jsonl     every emitted event, one per line (replay source)
//   runs/<id>/meta.json        { runId, startedAt, live, concurrency, zones }
//   runs/<id>/summary.json     { status, counts, endedAt } (terminal)
//   runs/<id>/entities/...     VALID tier-3 bodies, engine layout (transferable)
//   runs/<id>/_invalid/...     INVALID tier-3 bodies (inspect, don't transfer)

import { appendFileSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgeEvent } from './events.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR = join(__dirname, '..', 'runs');

export const isRunId = (id: string): boolean => /^run_\d+$/.test(id);

export function appendEvent(outDir: string, e: ForgeEvent): void {
  appendFileSync(join(outDir, 'events.jsonl'), JSON.stringify(e) + '\n');
}

export function writeJson(outDir: string, name: string, data: unknown): void {
  writeFileSync(join(outDir, name), JSON.stringify(data, null, 2));
}

function readJsonSafe<T>(p: string): T | null {
  try { return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null; } catch { return null; }
}

export interface RunSummary {
  runId: string;
  startedAt: number;
  endedAt?: number;
  live?: boolean;
  status: string;
  regions?: number;
  artifacts?: number;
  valid?: number;
  invalid?: number;
  errors?: number;
}

/** All runs on disk, newest first, with meta + summary merged in. */
export function listRuns(): RunSummary[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter(isRunId)
    .map((id) => {
      const dir = join(RUNS_DIR, id);
      const meta = readJsonSafe<Record<string, unknown>>(join(dir, 'meta.json')) ?? {};
      const summary = readJsonSafe<Record<string, unknown>>(join(dir, 'summary.json')) ?? {};
      return { runId: id, startedAt: 0, status: 'incomplete', ...meta, ...summary } as RunSummary;
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Replay source: the recorded events for a run, in order. */
export function readEvents(id: string): ForgeEvent[] {
  if (!isRunId(id)) return [];
  const f = join(RUNS_DIR, id, 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ForgeEvent);
}
