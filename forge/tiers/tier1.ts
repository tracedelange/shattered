// Tier 1 — the 10,000-ft pass. Ingests the lore seed + zone graph and produces
// the World Blueprint: storyline, lore, per-zone broad strokes, the division
// into regions, and the constraints handed down to Tier 2. Strongest model.

import yaml from 'js-yaml';
import { callAndValidate } from '../../pipeline/lib/validate.ts';
import { WorldBlueprintSchema, type WorldBlueprint } from '../lib/schemas.ts';
import { sleep } from '../lib/util.ts';
import { validateAgainst, type TierResult } from '../lib/trace.ts';
import { outputContract } from '../lib/yamlContract.ts';
import type { Seed, ZoneNode } from '../lib/seeds.ts';
import { tierModel } from '../lib/models.ts';
import type { TierOpts } from './opts.ts';

export async function runTier1(seed: Seed, opts: TierOpts): Promise<TierResult<WorldBlueprint>> {
  const prompt = { system: TIER1_SYSTEM, user: tier1User(seed) };
  const input = { bible: seed.bible, zones: seed.graph.zones.map((z) => z.id) };
  const check = (out: WorldBlueprint) => validateAgainst(
    WorldBlueprintSchema, 'WorldBlueprintSchema', out,
    'regions ≥ 1; every region + zone-sketch field non-empty.',
  );
  if (opts.live) {
    const { value } = await callAndValidate({
      label: 'forge-tier1',
      model: tierModel('tier1'),
      signal: opts.signal,
      system: [prompt.system],
      user: prompt.user,
      schema: WorldBlueprintSchema,
    });
    return { prompt, input, output: value, validation: check(value) };
  }
  await sleep(600, opts.signal);
  const output = stubTier1(seed);
  return { prompt, input, output, validation: check(output) };
}

const TIER1_SKELETON = `
storyline: "<one paragraph: the overarching arc>"
lore_additions: "<one paragraph of lore to add to the bible>"
regions:
  - id: <region_id>
    name: "<Region Name>"
    overview: "<one or two sentences>"
    motif: "<the through-line a player feels>"
    zones: [<zone_id>, <zone_id>]
    constraints: ["<rule Tier 2 must honor>", "<rule>"]
zone_sketches:
  - zone: <zone_id>
    region: <region_id>
    summary: "<one line: what this zone contains>"
    role: "<hub | on-ramp | fringe | gate | capstone | wilderness>"
`;

const TIER1_SYSTEM = [
  'You are the Tier 1 world architect for a grimdark fantasy MMO.',
  'You are given a lore seed and a zone graph (each zone has a biome, level band, and links).',
  'Produce the broad strokes: an overarching storyline, lore to add to the bible,',
  'a one-line sketch of what each zone contains and its role in the arc, and a',
  'division of the zones into coherent REGIONS (grouped by adjacency + level band).',
  'For each region, write constraints that Tier 2 must honor (tone, threats, what belongs).',
  'Do NOT design individual mobs/items/quests — that is downstream. Stay at altitude.',
  'Every zone in the graph must appear in exactly one region and one zone_sketch.',
  '',
  outputContract(TIER1_SKELETON),
].join('\n');

function tier1User(seed: Seed): string {
  return [
    '# Lore seed', '```yaml', yaml.dump(seed.bible, { lineWidth: -1 }).trim(), '```',
    '', '# Zone graph', '```yaml', yaml.dump(seed.graph, { lineWidth: -1 }).trim(), '```',
    '', 'Produce the World Blueprint.',
  ].join('\n');
}

// ── Stub: derive regions by level tier so the board reflects the real input ─────
const REGION_NAMES: Record<number, { name: string; motif: string }> = {
  1: { name: 'The Oasis Reach', motif: 'Fragile safety at the desert\'s edge; the last normal place.' },
  2: { name: 'The Glass Fringe', motif: 'The crystalline tide, spreading. The land turning wrong.' },
  3: { name: 'The Spire Descent', motif: 'The shard\'s heart. The source. The point of no return.' },
};
const ZONE_ROLE: Record<string, string> = {
  oasis_hub: 'hub', dune_flats: 'on-ramp', glass_fringe: 'fringe',
  scoured_waste: 'escalation', spire_approach: 'gate', prism_spire: 'capstone',
};

function stubTier1(seed: Seed): WorldBlueprint {
  const byTier = new Map<number, ZoneNode[]>();
  for (const z of seed.graph.zones) {
    const arr = byTier.get(z.level_band.tier) ?? [];
    arr.push(z);
    byTier.set(z.level_band.tier, arr);
  }
  const regions = [...byTier.entries()].sort((a, b) => a[0] - b[0]).map(([tier, zones]) => {
    const meta = REGION_NAMES[tier] ?? { name: `Region T${tier}`, motif: '' };
    return {
      id: `region_t${tier}`,
      name: meta.name,
      overview: `Tier ${tier} zones (L${Math.min(...zones.map((z) => z.level_band.minLevel))}-${Math.max(...zones.map((z) => z.level_band.maxLevel))}). ${meta.motif}`,
      motif: meta.motif,
      zones: zones.map((z) => z.id),
      constraints: [
        `Threats and loot must sit within L${Math.min(...zones.map((z) => z.level_band.minLevel))}-${Math.max(...zones.map((z) => z.level_band.maxLevel))}.`,
        tier === 1 ? 'Keep the hub safe; introduce the glass corruption only as rumor.'
          : tier === 3 ? 'Pay off the shard mystery here — the boss and the real loot.'
          : 'Show the corruption spreading; escalate threat from the previous tier.',
      ],
    };
  });
  return {
    storyline:
      'A buried shard-god bleeds glass into the desert, hollowing the living. From a last oasis, ' +
      'the player pushes north through a spreading crystalline frontier toward the spire at its source.',
    lore_additions:
      'The glass is not a disease but a god\'s broken intent: the shard is trying to remake what it touches in its own image, and failing.',
    regions,
    zone_sketches: seed.graph.zones.map((z) => ({
      zone: z.id,
      region: `region_t${z.level_band.tier}`,
      summary: `${z.biome} zone, L${z.level_band.minLevel}-${z.level_band.maxLevel}.`,
      role: ZONE_ROLE[z.id] ?? 'wilderness',
    })),
  };
}
