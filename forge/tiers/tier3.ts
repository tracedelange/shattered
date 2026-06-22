// Tier 3 — the translator. Takes ONE hyper-specific task and emits engine-schema
// YAML (a mob/item/quest body, or a zone_enhance patch). Cheapest model: this is
// mechanical translation, not design. Output is staged to runs/, not loaded into
// the engine.
//
// The system prompt carries an EXPLICIT skeleton per artifact_type — the run that
// validated 28/28 mobs but 0/19 quests, 0/7 items, 0/16 zones showed failure rate
// tracks skeleton coverage exactly. The skeletons below bake in the observed
// failure modes (numeric stage ids, on_complete sentinels, kill_count.target
// misuse, missing item slot/tags, hallucinated zone fields).

import yaml from 'js-yaml';
import { callAndValidate } from '../../pipeline/lib/validate.ts';
import { ArtifactSchema, type Artifact, type Task } from '../lib/schemas.ts';
import { sleep } from '../lib/util.ts';
import type { TierResult } from '../lib/trace.ts';
import { validateEngineBody, ENGINE_DIR, abilityCatalog, abilityIds, grammarKit } from '../lib/engine.ts';
import { getArchetype, formatArchetypeChassis } from '../../pipeline/lib/grammar.ts';
import { STRICT_YAML_RULES } from '../lib/yamlContract.ts';
import { zoneById, type Seed } from '../lib/seeds.ts';
import { tierModel } from '../lib/models.ts';
import type { TierOpts } from './opts.ts';

export async function runTier3(seed: Seed, task: Task, opts: TierOpts): Promise<TierResult<Artifact>> {
  const prompt = { system: tier3System(), user: tier3User(task) };
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
  const output = stubTier3(seed, task);
  return { prompt, input, output, validation: check(output) };
}

// ── Per-type content skeletons (emit ONLY the keys shown — schemas are strict) ──
const T3_MOB = `# MOB content:
id: <snake_case>
name: "<Display Name>"
sprite: <sprite_id>
level: <int>
role: <skirmisher | brute | tank | pest | soldier | npc | passive>
speed: <number>
behavior: <patrol | idle | wander>
aggro_range: <number>
xp: <int>
loot_table: [{ item: <item_id>, chance: <0..1> }]
stats: { strength: <int> }   # any of strength|dexterity|intelligence|constitution
abilities: [{ ability: <ability_id>, hp_below: <0..1?> }]   # OPTIONAL; ids ONLY from the ABILITY POOL below`;

const T3_ITEM = `# ITEM content (required: id, name, slot, tags):
id: <snake_case>
name: "<Display Name>"
slot: <mainhand | helmet | chest | gloves | leggings | boots | ring1 | ring2 | amulet | ring | currency | quest | consumable>
tags: [<tag>, <tag>]                  # e.g. [weapon, blade] / [armor, heavy] / [consumable]
sprite: <sprite_id>                   # optional
base_damage: [<min>, <max>]           # weapons only
base_defense: [<min>, <max>]          # armor only
value: <int>                          # optional
use_effect: { heal: [<min>, <max>] }  # consumables only`;

const T3_QUEST = `# QUEST content — stage ids and on_complete are STRING ids (never numbers):
id: <snake_case>
name: "<Display Name>"
giver: <npc_id>
zone: <zone_id>
description: "<one or two sentences>"
stages:
  - id: "accept"                 # quoted string
    text: "<line>"
    on_complete: "slay"          # MUST equal another stage's id, or the literal "done"
  - id: "slay"
    text: "<line>"
    objective: { kind: kill_count, target: <int COUNT>, template_id: <mob_id>, zone: <zone_id> }
    # target is a NUMBER (how many). The mob id goes in template_id, NOT target.
    # other kinds:
    #   { kind: kill_specific, target_id: <unique_mob_id> }   # a named, one-off mob
    #   { kind: collect_count, item_base: <item_id>, target: <int> }
    #   { kind: talk, target_template: <npc_id> }
    #   { kind: reach, radius: <num>, zone: <zone_id> }
    on_complete: "done"          # final objective stage points to the literal: done
  - id: "done"
    text: "<wrap-up line>"
rewards: [{ gold: <int>, xp: <int> }]`;

const T3_ZONE_ENHANCE = `# ZONE_ENHANCE content — adjust an EXISTING zone (never create one):
zone: <existing_zone_id>
add_features: [<prefab_or_feature_id>, { id: <prefab_id>, in_region: <region> }]
atmosphere: { light_level: <0..1>, tint: "<#rrggbb>", fog: <0..1>, weather: <none|rain|snow|sandstorm|ash|fog>, ambient_sound: "<name>" }
lore_summary: "<one line on the change>"`;

const T3_ENVELOPE = `task_id: <task_id>
artifact_type: <mob | item | quest | zone_enhance>
filename: <mob: entities/mobs/<id>.yaml | item: entities/items/bases/<id>.yaml | quest: quests/<id>.yaml | zone_enhance: zone_enhancements/<zone>.yaml>
content: { ...the body for that artifact_type (see above)... }`;

function tier3System(): string {
  return [
    'You are the Tier 3 translator for a grimdark fantasy MMO content pipeline.',
    'Translate ONE implementation task into a single engine-schema YAML body.',
    'Honor the requirement exactly. Do not invent new mechanics.',
    '',
    'The `content` body depends on artifact_type — use EXACTLY the matching shape:',
    '```yaml', T3_MOB, '```',
    '```yaml', T3_ITEM, '```',
    '```yaml', T3_QUEST, '```',
    '```yaml', T3_ZONE_ENHANCE, '```',
    '',
    'Wrap the body in the artifact envelope:',
    '```yaml', T3_ENVELOPE, '```',
    '',
    'ABILITY POOL — mob `abilities[].ability` MUST be one of these exact ids (or omit abilities):',
    abilityPoolText(),
    '',
    'CLOSED SET: emit ONLY the keys shown for the artifact_type — every engine schema',
    'is strict and rejects any other key. Stage ids and on_complete are quoted strings;',
    'counts, targets, levels, and damage values are bare numbers.',
    '',
    STRICT_YAML_RULES,
  ].join('\n');
}

// The closed set of valid ability ids, with shape/effects so the model picks
// thematically (e.g. a ranged caster → a projectile ability).
function abilityPoolText(): string {
  const lines = abilityCatalog().map((a) => `  - ${a.id}  (${a.shape}, ${a.effects})`);
  return lines.length ? lines.join('\n') : '  (no abilities available)';
}

function tier3User(task: Task): string {
  // When the task names an archetype (mob tasks, via Tier 2), spell out the
  // chassis the instance must inherit so the mob isn't reinvented from scratch.
  const chassis = formatArchetypeChassis(grammarKit(), task.library_refs);
  return [
    '# Task', '```yaml', yaml.dump(task, { lineWidth: -1 }).trim(), '```',
    ...(chassis ? ['', '```yaml', chassis, '```'] : []),
    '', 'Produce the Artifact.',
  ].join('\n');
}

// ── Stub: build a plausible engine body derived from the task + zone ────────────
const ROLE_BY_TIER: Record<number, string> = { 1: 'pest', 2: 'skirmisher', 3: 'brute', 4: 'soldier', 5: 'tank' };
const title = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function stubTier3(seed: Seed, task: Task): Artifact {
  const z = zoneById(seed, task.zone);
  const level = z ? Math.round((z.level_band.minLevel + z.level_band.maxLevel) / 2) : 1;

  if (task.kind === 'mob') {
    // Inherit the frozen chassis if the task names an archetype; else fall back
    // to a tier-derived role. Honor any ability ids too (abilities and archetype
    // ids live in the same library_refs but resolve against different registries).
    const arch = task.library_refs.map((r) => getArchetype(grammarKit(), r)).find(Boolean);
    const role = arch?.role ?? ROLE_BY_TIER[z?.level_band.tier ?? 1] ?? 'skirmisher';
    const valid = abilityIds();
    const abilities = task.library_refs.filter((r) => valid.has(r)).map((ability) => ({ ability }));
    const content = {
      id: `${task.zone}_threat`,
      name: `${title(task.zone)} Marauder`,
      sprite: `${task.zone}_threat_01`,
      level, role,
      speed: arch?.speed ?? 1.2,
      behavior: arch?.behavior ?? 'patrol',
      aggro_range: arch?.aggro_range ?? 7,
      xp: level * 15,
      loot_table: [{ item: 'crude_trophy', chance: 0.5 }],
      stats: { strength: level + 1 },
      ...(abilities.length ? { abilities } : {}),
    };
    return { task_id: task.id, artifact_type: 'mob', filename: `${ENGINE_DIR.mob}/${content.id}.yaml`, content };
  }

  if (task.kind === 'item') {
    const content = {
      id: `${task.zone}_relic`,
      name: `${title(task.zone)} Relic`,
      slot: 'mainhand',
      tags: ['weapon', 'blade'],
      base_damage: [Math.max(1, level - 1), level + 2],
      value: level * 10,
    };
    return { task_id: task.id, artifact_type: 'item', filename: `${ENGINE_DIR.item}/${content.id}.yaml`, content };
  }

  if (task.kind === 'quest') {
    const template = task.library_refs[0] ?? 'bounty';
    const isHunt = template === 'hunt_named';
    const content = {
      id: task.id,
      name: isHunt ? 'Hunt the Named Threat' : 'Cull the Threat',
      giver: task.library_refs[1] ?? 'local_settler',
      zone: task.zone,
      description: task.requirement,
      stages: [
        { id: 'accept', text: 'Take the work.', on_complete: 'act' },
        {
          id: 'act',
          text: isHunt ? 'Hunt the named threat.' : 'Thin the threat near the settlement.',
          objective: isHunt
            ? { kind: 'kill_specific', target_id: `${task.zone}_boss` }
            : { kind: 'kill_count', target: 5, template_id: `${task.zone}_threat`, zone: task.zone },
          on_complete: 'done',
        },
        { id: 'done', text: 'Return for your reward.' },
      ],
      rewards: [{ gold: level * 20, xp: level * 50 }],
    };
    return { task_id: task.id, artifact_type: 'quest', filename: `${ENGINE_DIR.quest}/${content.id}.yaml`, content };
  }

  // zone_enhance: adjust an existing zone
  const content = {
    zone: task.zone,
    add_features: ['campfire'],
    atmosphere: { light_level: 0.6, weather: 'none' },
    lore_summary: `Atmosphere pass for ${title(task.zone)}.`,
  };
  return { task_id: task.id, artifact_type: 'zone_enhance', filename: `${ENGINE_DIR.zone_enhance}/${task.zone}.yaml`, content };
}
