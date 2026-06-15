// The orchestrator. Runs the fan-out cascade and emits a stream of events so the
// UI can render the tree filling in left-to-right:
//
//   Tier 1 (1 node)  →  Tier 2 (one per region)  →  Tier 3 (one per task)
//
// Each node_done carries the full trace (prompt, input, output, validation) so
// the UI can show exactly what happened at each step. Tier 3 artifacts are
// staged to forge/runs/<runId>/ as YAML — no engine integration. The run is
// cancellable via the AbortSignal (UI stop button): in-flight live LLM calls
// abort, stub sleeps cancel, and no further tiers are scheduled.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadSeed } from './lib/seeds.ts';
import { runTier1 } from './tiers/tier1.ts';
import { runTier2 } from './tiers/tier2.ts';
import { runTier3 } from './tiers/tier3.ts';
import { isAbortError } from './lib/util.ts';
import type { Emit } from './lib/events.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(__dirname, 'runs');
const LIVE = !!process.env.FORGE_LIVE;

export async function runCascade(emit: Emit, signal?: AbortSignal): Promise<void> {
  const runId = `run_${Date.now()}`;
  const outDir = join(RUNS_DIR, runId);
  mkdirSync(outDir, { recursive: true });

  const seed = loadSeed();
  emit({ type: 'run_start', runId, zones: seed.graph.zones.map((z) => z.id), live: LIVE });

  const aborted = () => !!signal?.aborted;
  const stop = () => emit({ type: 'run_stopped', runId });
  const opts = { live: LIVE, signal };

  // ── Tier 1 ──────────────────────────────────────────────────────────────────
  emit({ type: 'node_start', tier: 1, id: 'world', label: 'World Blueprint' });
  let blueprint;
  try {
    const r = await runTier1(seed, opts);
    blueprint = r.output;
    emit({ type: 'node_done', tier: 1, id: 'world', label: 'World Blueprint', detail: r });
  } catch (err) {
    if (isAbortError(err) || aborted()) return stop();
    emit({ type: 'node_error', tier: 1, id: 'world', message: msg(err) });
    return;
  }
  if (aborted()) return stop();

  // ── Tier 2 — fan out per region ───────────────────────────────────────────────
  const plans = await Promise.all(
    blueprint.regions.map(async (region) => {
      if (aborted()) return null;
      emit({ type: 'node_start', tier: 2, id: region.id, parentId: 'world', label: region.name });
      try {
        const r = await runTier2(seed, blueprint!, region, opts);
        emit({ type: 'node_done', tier: 2, id: region.id, parentId: 'world', label: region.name, detail: r });
        return { region, plan: r.output };
      } catch (err) {
        if (isAbortError(err) || aborted()) return null;
        emit({ type: 'node_error', tier: 2, id: region.id, parentId: 'world', message: msg(err) });
        return null;
      }
    }),
  );
  if (aborted()) return stop();

  // ── Tier 3 — fan out per task ─────────────────────────────────────────────────
  const allTasks = plans
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .flatMap(({ region, plan }) => plan.tasks.map((task) => ({ region, task })));

  await Promise.all(
    allTasks.map(async ({ region, task }) => {
      if (aborted()) return;
      const label = `${task.kind}: ${task.id}`;
      emit({ type: 'node_start', tier: 3, id: task.id, parentId: region.id, label });
      try {
        const r = await runTier3(seed, task, opts);
        const path = join(outDir, r.output.filename);
        mkdirSync(dirname(path), { recursive: true }); // engine-mirroring layout (entities/mobs, quests, ...)
        writeFileSync(path, yaml.dump(r.output.content, { lineWidth: -1, noRefs: true }), 'utf8');
        emit({ type: 'node_done', tier: 3, id: task.id, parentId: region.id, label, detail: r, artifactPath: path });
      } catch (err) {
        if (isAbortError(err) || aborted()) return;
        emit({ type: 'node_error', tier: 3, id: task.id, parentId: region.id, message: msg(err) });
      }
    }),
  );
  if (aborted()) return stop();

  emit({ type: 'run_done', runId, regions: plans.filter(Boolean).length, artifacts: allTasks.length });
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
