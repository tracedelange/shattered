// The orchestrator. Runs the fan-out cascade and emits a stream of events so the
// UI can render the tree filling in left-to-right:
//
//   Tier 1 (1 node)  →  Tier 2 (one per region)  →  Tier 3 (one per task)
//
// EVERY event is recorded to runs/<id>/events.jsonl (successes AND failures, all
// tiers) so a run is fully reconstructable by replay. Each node_done carries the
// full trace (prompt, input, output, validation). Tier 3 VALID bodies stage to
// the engine's directory layout (transferable); INVALID bodies go to _invalid/.
//
// Concurrency: Tier 2 and Tier 3 fan out through a pool capped at CONCURRENCY,
// default 1 (one request at a time) so local/Ollama providers aren't hit with
// concurrent requests. Raise FORGE_CONCURRENCY on providers that allow it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import yaml from 'js-yaml';
import { loadSeed } from './lib/seeds.ts';
import { runTier1 } from './tiers/tier1.ts';
import { runTier2 } from './tiers/tier2.ts';
import { runTier3 } from './tiers/tier3.ts';
import { isAbortError, mapPool } from './lib/util.ts';
import { RUNS_DIR, appendEvent, writeJson } from './lib/persist.ts';
import type { Emit, ForgeEvent } from './lib/events.ts';

const LIVE = !!process.env.FORGE_LIVE;
const CONCURRENCY = Math.max(1, Number(process.env.FORGE_CONCURRENCY ?? 1));

export async function runCascade(emit: Emit, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  const runId = `run_${startedAt}`;
  const outDir = join(RUNS_DIR, runId);
  mkdirSync(outDir, { recursive: true });

  const seed = loadSeed();
  writeJson(outDir, 'meta.json', { runId, startedAt, live: LIVE, concurrency: CONCURRENCY, zones: seed.graph.zones.length });

  // Record-then-emit: persist every event, then forward to the live UI.
  const events: ForgeEvent[] = [];
  const record = (e: ForgeEvent) => {
    events.push(e);
    try { appendEvent(outDir, e); } catch { /* disk best-effort; never break a run */ }
    emit(e);
  };

  const aborted = () => !!signal?.aborted;
  const stop = () => record({ type: 'run_stopped', runId });
  const opts = { live: LIVE, signal };

  try {
    record({ type: 'run_start', runId, zones: seed.graph.zones.map((z) => z.id), live: LIVE });

    // ── Tier 1 ────────────────────────────────────────────────────────────────
    record({ type: 'node_start', tier: 1, id: 'world', label: 'World Blueprint' });
    let blueprint;
    try {
      const r = await runTier1(seed, opts);
      blueprint = r.output;
      record({ type: 'node_done', tier: 1, id: 'world', label: 'World Blueprint', detail: r });
    } catch (err) {
      if (isAbortError(err) || aborted()) return stop();
      record({ type: 'node_error', tier: 1, id: 'world', message: msg(err) });
      return;
    }
    if (aborted()) return stop();

    // ── Tier 2 — fan out per region (pooled) ────────────────────────────────────
    const plans = await mapPool(blueprint.regions, CONCURRENCY, async (region) => {
      if (aborted()) return null;
      record({ type: 'node_start', tier: 2, id: region.id, parentId: 'world', label: region.name });
      try {
        const r = await runTier2(seed, blueprint!, region, opts);
        record({ type: 'node_done', tier: 2, id: region.id, parentId: 'world', label: region.name, detail: r });
        return { region, plan: r.output };
      } catch (err) {
        if (isAbortError(err) || aborted()) return null;
        record({ type: 'node_error', tier: 2, id: region.id, parentId: 'world', message: msg(err) });
        return null;
      }
    });
    if (aborted()) return stop();

    // ── Tier 3 — fan out per task (pooled) ──────────────────────────────────────
    const allTasks = plans
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .flatMap(({ region, plan }) => plan.tasks.map((task) => ({ region, task })));

    await mapPool(allTasks, CONCURRENCY, async ({ region, task }) => {
      if (aborted()) return;
      const label = `${task.kind}: ${task.id}`;
      record({ type: 'node_start', tier: 3, id: task.id, parentId: region.id, label });
      try {
        const r = await runTier3(seed, task, opts);
        // valid bodies → engine layout (transferable); invalid → _invalid/ (inspect only)
        const rel = r.validation.ok ? r.output.filename : join('_invalid', r.output.filename);
        const path = join(outDir, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, yaml.dump(r.output.content, { lineWidth: -1, noRefs: true }), 'utf8');
        record({ type: 'node_done', tier: 3, id: task.id, parentId: region.id, label, detail: r, artifactPath: path });
      } catch (err) {
        if (isAbortError(err) || aborted()) return;
        record({ type: 'node_error', tier: 3, id: task.id, parentId: region.id, message: msg(err) });
      }
    });
    if (aborted()) return stop();

    record({ type: 'run_done', runId, regions: plans.filter(Boolean).length, artifacts: allTasks.length });
  } finally {
    writeJson(outDir, 'summary.json', summarize(events, startedAt));
  }
}

function summarize(events: ForgeEvent[], startedAt: number) {
  const done = (tier: number) => events.filter((e) => e.type === 'node_done' && e.tier === tier);
  const t3 = done(3) as Array<{ detail?: { validation?: { ok?: boolean } } }>;
  const valid = t3.filter((e) => e.detail?.validation?.ok === true).length;
  const stopped = events.some((e) => e.type === 'run_stopped');
  const finished = events.some((e) => e.type === 'run_done');
  return {
    startedAt,
    endedAt: Date.now(),
    status: stopped ? 'stopped' : finished ? 'done' : 'incomplete',
    regions: done(2).length,
    artifacts: t3.length,
    valid,
    invalid: t3.length - valid,
    errors: events.filter((e) => e.type === 'node_error').length,
  };
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
