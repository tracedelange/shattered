// Tier 3 — the translator. Takes ONE hyper-specific task and emits engine-schema
// YAML (a mob/item/quest/zone body). Cheapest model: this is mechanical
// translation, not design. Output is staged to runs/, not loaded into the engine.

import yaml from 'js-yaml';
import { callAndValidate } from '../../pipeline/lib/validate.ts';
import { loadGrammar, getArchetype, type Grammar } from '../../pipeline/lib/grammar.ts';
import { ArtifactSchema, type Artifact, type Task } from '../lib/schemas.ts';
import { sleep } from '../lib/util.ts';
import type { TierResult } from '../lib/trace.ts';
import { validateEngineBody, ENGINE_DIR } from '../lib/engine.ts';
import { zoneById, type Seed } from '../lib/seeds.ts';
import { tierModel } from '../lib/models.ts';
import type { TierOpts } from './opts.ts';

export async function runTier3(seed: Seed, task: Task, opts: TierOpts): Promise<TierResult<Artifact>> {
  const grammar = loadGrammar();
  const prompt = { system: tier3System(), user: tier3User(task, grammar) };
  const input = { task, refs: task.library_refs };
  // Validate the BODY against the engine's own schema — "valid against our writes".
  // No repair: report where it goes wrong and move on.
  const check = (out: Artifact) => validateEngineBody(out.artifact_type, out.content);
  if (opts.live) {
    const { value } = await callAndValidate({
      label: `forge-tier3-${task.id}`,
      model: tierModel('tier3'),
      signal: opts.signal,
      system: [prompt.system],
      user: prompt.user,
      schema: ArtifactSchema,
    });
    return { prompt, input, output: value, validation: check(value) };
  }
  await sleep(400, opts.signal);
  const output = stubTier3(seed, task, grammar);
  return { prompt, input, output, validation: check(output) };
}

function tier3System(): string {
  return [
    'You are the Tier 3 translator for a grimdark fantasy MMO content pipeline.',
    'Translate ONE implementation task into a single engine-schema YAML body.',
    'For a mob: id, name, sprite, level, role, speed, behavior, aggro_range, xp, loot_table, stats.',
    'For a quest: id, name, giver, zone, description, stages (with objective kinds), rewards.',
    'Honor the archetype/template referenced in library_refs exactly. Do not invent new mechanics.',
    'Output ONLY a single ```yaml block matching the Artifact schema (task_id, artifact_type, filename, content).',
  ].join('\n');
}

function tier3User(task: Task, grammar: Grammar): string {
  const refs = task.library_refs
    .map((id) => grammar.archetypes.find((a) => a.id === id) ?? grammar.quest_templates.find((t) => t.id === id))
    .filter(Boolean);
  return [
    '# Task', '```yaml', yaml.dump(task, { lineWidth: -1 }).trim(), '```',
    '', '# Referenced library entries', '```yaml', yaml.dump(refs, { lineWidth: -1 }).trim(), '```',
    '', 'Produce the Artifact.',
  ].join('\n');
}

// ── Stub: build a plausible engine body derived from the task + archetype ───────
function stubTier3(seed: Seed, task: Task, grammar: Grammar): Artifact {
  const z = zoneById(seed, task.zone);
  const level = z ? Math.round((z.level_band.minLevel + z.level_band.maxLevel) / 2) : 1;

  if (task.kind === 'mob') {
    const arch = getArchetype(grammar, task.library_refs[0] ?? '') ?? grammar.archetypes[0]!;
    const content = {
      id: `${arch.id}_${task.zone}`,
      name: `${task.zone.replace(/_/g, ' ')} ${arch.name}`.replace(/\b\w/g, (c) => c.toUpperCase()),
      sprite: `${arch.id}_01`,
      level,
      role: arch.role,
      speed: arch.speed,
      behavior: arch.behavior,
      aggro_range: arch.aggro_range,
      xp: level * 15,
      loot_table: [{ item: 'glass_scrap', chance: 0.5 }],
      stats: { [arch.primary_stat]: level + 2 },
    };
    return { task_id: task.id, artifact_type: 'mob', filename: `${ENGINE_DIR.mob}/${content.id}.yaml`, content };
  }

  if (task.kind === 'quest') {
    const template = task.library_refs[0] ?? 'bounty';
    const isHunt = template === 'hunt_named';
    const content = {
      id: task.id,
      name: isHunt ? 'The Thing in the Glass' : 'Cull the Fringe',
      giver: task.library_refs[1] ?? 'oasis_settler',
      zone: task.zone,
      description: task.requirement,
      stages: [
        { id: 'accept', text: 'Take the work.', on_complete: 'act' },
        {
          id: 'act',
          text: isHunt ? 'Hunt the named threat.' : 'Thin the threat near the settlement.',
          objective: isHunt
            ? { kind: 'kill_specific', target_id: `${task.zone}_boss` }
            : { kind: 'kill_count', target: 5, zone: task.zone },
          on_complete: 'done',
        },
        { id: 'done', text: 'Return for your reward.' },
      ],
      rewards: [{ gold: level * 20, xp: level * 50 }],
    };
    return { task_id: task.id, artifact_type: 'quest', filename: `${ENGINE_DIR.quest}/${content.id}.yaml`, content };
  }

  // item / zone fallthrough: a minimal stub body
  const content = { id: task.id, note: task.requirement, level };
  return { task_id: task.id, artifact_type: task.kind, filename: `${ENGINE_DIR[task.kind] ?? task.kind}/${task.id}.yaml`, content };
}
