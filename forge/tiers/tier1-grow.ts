// Tier 1 in grow mode — proposes ONE new region from the story-so-far.
//
// Receives: the running blueprint (storyline + lore history), the current
// frontier zones (open-edge zones with biome/band context), and the grammar
// library (faction ids available to assign). Produces a RegionSpec that the
// region-synthesis primitive turns into real GrownZoneNodes + a Region for Tier 2.
//
// The stub (non-live) picks the deepest frontier zone as seam and produces a
// plausible 5-zone approach→gate→dungeon→dungeon→reward arc.

import yaml from 'js-yaml';
import { callAndValidate } from '../../pipeline/lib/validate.ts';
import { RegionSpecSchema, type RegionSpec } from '../lib/schemas.ts';
import { sleep } from '../lib/util.ts';
import { validateAgainst, type TierResult } from '../lib/trace.ts';
import { outputContract } from '../lib/yamlContract.ts';
import { grammarKit } from '../lib/engine.ts';
import { tierModel } from '../lib/models.ts';
import { frontierZones } from '../grow/worldState.ts';
import type { GrownGraph, GrownBlueprint, GrownZoneNode } from '../grow/worldState.ts';
import type { TierOpts } from './opts.ts';

export async function runTier1Grow(
  blueprint: GrownBlueprint,
  graph: GrownGraph,
  opts: TierOpts,
): Promise<TierResult<RegionSpec>> {
  const frontier = frontierZones(graph);
  const grammar = grammarKit();
  const prompt = { system: TIER1_GROW_SYSTEM, user: tier1GrowUser(blueprint, frontier, grammar) };
  const input = { storyline: blueprint.storyline, frontierZones: frontier.map((z) => z.id) };

  const check = (out: RegionSpec) => validateAgainst(
    RegionSpecSchema, 'RegionSpecSchema', out,
    'seam_zone must be a frontier zone; 5–8 zones; faction_ids must reference existing grammar.',
  );

  if (opts.live) {
    const { value } = await callAndValidate({
      label: 'forge-tier1-grow',
      model: tierModel('tier1'),
      signal: opts.signal,
      system: [prompt.system],
      user: prompt.user,
      schema: RegionSpecSchema,
    });
    return { prompt, input, output: value, validation: check(value) };
  }

  await sleep(400, opts.signal);
  const output = stubTier1Grow(blueprint, frontier, grammar);
  return { prompt, input, output, validation: check(output) };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const SPEC_SKELETON = `
purpose: "<one or two sentences: what this region is for in the story arc>"
motif: "<the through-line a player feels walking through here>"
lore_continuation: "<one paragraph continuing the running storyline>"
seam_zone: <id of a frontier zone to attach to>
zones:
  - role: approach
    biome: <biome>
    note: "<optional one-liner>"
  - role: gate
    biome: <biome>
  - role: dungeon
    biome: <biome>
  - role: dungeon
    biome: <biome>
  - role: reward
    biome: <biome>
faction_ids: [<faction_id>]
quest_beat: "<one sentence: what the player accomplishes here>"
`;

const TIER1_GROW_SYSTEM = [
  'You are the grow-mode Tier 1 world architect for a grimdark fantasy MMO.',
  'The world is grown region by region from an origin village outward. Each step you',
  'receive the story-so-far and the current frontier (open-edge zones at the world\'s',
  'leading edge), then propose ONE new region that continues the narrative.',
  '',
  'Rules:',
  '- seam_zone MUST be one of the frontier zone ids listed below.',
  '- Zone roles follow an arc: approach (near seam, lighter) → gate → dungeon(s) → reward.',
  '- Biomes should fit the faction(s) you choose; vary them for texture.',
  '- faction_ids MUST be ids from the GRAMMAR LIBRARY below — never invent new ids.',
  '- lore_continuation is one paragraph that gets appended to the world\'s running story.',
  '',
  outputContract(SPEC_SKELETON),
].join('\n');

function tier1GrowUser(
  blueprint: GrownBlueprint,
  frontier: GrownZoneNode[],
  grammar: ReturnType<typeof grammarKit>,
): string {
  const storyLines = blueprint.storyline
    ? ['# Story so far', blueprint.storyline]
    : ['# Story so far', '(no regions grown yet — you are opening the first chapter)'];

  const frontierLines = [
    '# Frontier zones (valid seam_zone values)',
    '```yaml',
    yaml.dump(frontier.map((z) => ({
      id: z.id, biome: z.biome,
      level_band: { tier: z.level_band.tier, minLevel: z.level_band.minLevel, maxLevel: z.level_band.maxLevel },
    })), { lineWidth: -1 }).trim(),
    '```',
  ];

  const grammarLines = [
    '# Grammar library — faction ids you may assign',
    '```yaml',
    yaml.dump(grammar.factions.map((f) => ({
      id: f.id, name: f.name, biomes: f.biomes, lore_hook: f.lore_hook,
    })), { lineWidth: -1 }).trim(),
    '```',
  ];

  return [...storyLines, '', ...frontierLines, '', ...grammarLines, '', 'Propose the next region.'].join('\n');
}

// ── Stub ─────────────────────────────────────────────────────────────────────

function stubTier1Grow(
  blueprint: GrownBlueprint,
  frontier: GrownZoneNode[],
  grammar: ReturnType<typeof grammarKit>,
): RegionSpec {
  const seam = [...frontier].sort(
    (a, b) => b.level_band.tier - a.level_band.tier || b.level_band.maxLevel - a.level_band.maxLevel,
  )[0] ?? frontier[0];

  if (!seam) throw new Error('no frontier zones — has forge:init-world been run?');

  const faction = grammar.factions.find((f) => f.biomes.includes(seam.biome))
    ?? grammar.factions[0];
  const factionId = faction?.id ?? 'iron_reavers';
  const biome = seam.biome;
  const step = blueprint.regions.length + 1;

  return {
    purpose: `Region ${step}: the frontier hardens — the forces beyond the known world press inward.`,
    motif: 'Every step forward is earned. The world does not welcome intruders.',
    lore_continuation:
      `Beyond the frontier, the ${biome} stretches further than the villagers dared map. ` +
      `${faction?.name ?? 'Unknown forces'} hold this ground, and what they guard is worth dying for.`,
    seam_zone: seam.id,
    zones: [
      { role: 'approach', biome, note: 'First contact — skirmishes and patrols.' },
      { role: 'approach', biome, note: 'The threat densifies. Patrols, not scouts.' },
      { role: 'gate',     biome, note: 'A fortified chokepoint — passage costs.' },
      { role: 'dungeon',  biome, note: 'The heart of the enemy presence.' },
      { role: 'reward',   biome, note: 'Past the main force — something worth the blood.' },
    ],
    faction_ids: [factionId],
    quest_beat: 'Clear the vanguard and claim what the enemy was holding.',
  };
}
