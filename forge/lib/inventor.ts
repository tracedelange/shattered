// The inventor — the "slow clock" that mints NEW grammar (the doc's Phase 3).
//
// Grow recombines the frozen library deterministically; the inventor is how the
// library itself grows. Given a theme (and optional biome), it proposes one new
// faction plus the archetypes it fields, validated against the engine's
// primitives (combat roles, the sprite atlas) and the grammar invariants
// (validateGrammar: refs resolve, no id collisions). Novelty enters the LIBRARY,
// validated once and FROZEN — instancing stays deterministic.
//
// Two steps, mirroring the prefab architect's propose→green-light flow:
//   inventGrammar(req)  — propose + validate (no writes); returns problems.
//   commitGrammar(prop) — re-validate against the live library, then append to
//                         world/grammar/{archetypes,factions}.yaml (the single
//                         canonical source) and reset the grammar cache.

import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import { callAndValidate } from '../../pipeline/lib/validate.ts';
import {
  loadGrammar, validateGrammar, ArchetypeSchema, FactionSchema,
  type Archetype, type Faction, type Grammar,
} from '../../pipeline/lib/grammar.ts';
import { FACTIONS_FILE, ARCHETYPES_FILE } from '../../pipeline/lib/io.ts';
import { MOB_ROLES, BRAND_KEYS } from '../../shared/constants.ts';
import { resetGrammarKit } from './engine.ts';
import { validSprites } from './wire-zones.ts';
import { tierModel } from './models.ts';
import { sleep } from './util.ts';
import { outputContract } from './yamlContract.ts';

// Combat roles only — npc/passive are fixtures, not faction threats.
const COMBAT_ROLES = (Object.keys(MOB_ROLES) as string[]).filter((r) => r !== 'npc' && r !== 'passive');
// Loot-affinity vocab the seed grammar uses (advisory; biases loot, not enforced).
const LOOT_TAGS = ['light_armor', 'heavy_armor', 'weapon', 'trinket', 'wand', 'gem', 'reagent', 'hide', 'coin', 'relic'];

export interface InventRequest { theme: string; biome?: string }
export interface InventProposal { faction: Faction; archetypes: Archetype[] }
export interface InventResult {
  proposal: InventProposal;
  /** Human-readable problems; entries prefixed `warn:` are non-blocking. */
  problems: string[];
  /** True when there are no blocking problems — safe to green-light. */
  ok: boolean;
}

// The LLM proposes both at once so the faction's archetype refs resolve locally.
const ProposalSchema = z.object({
  archetypes: z.array(ArchetypeSchema).min(1).max(5),
  faction: FactionSchema,
});

export async function inventGrammar(
  req: InventRequest,
  opts: { live: boolean; signal?: AbortSignal },
): Promise<InventResult> {
  const existing = loadGrammar();
  let proposal: InventProposal;

  if (opts.live) {
    const { value } = await callAndValidate({
      label: 'forge-inventor',
      model: tierModel('tier1'),
      signal: opts.signal,
      system: [inventorSystem()],
      user: inventorUser(req, existing),
      schema: ProposalSchema,
    });
    proposal = value;
  } else {
    await sleep(300, opts.signal);
    proposal = stubProposal(req, existing);
  }

  const problems = validateProposal(proposal, existing);
  return { proposal, problems, ok: problems.every((p) => p.startsWith('warn:')) };
}

/** Validate against the engine primitives + the merged grammar. Mutates the
 *  proposal in place to strip off-atlas sprites (role-derived fallback renders
 *  them), so a committed entry is always engine-safe. */
export function validateProposal(proposal: InventProposal, existing: Grammar): string[] {
  const problems: string[] = [];
  const atlas = validSprites();
  const existingArchIds = new Set(existing.archetypes.map((a) => a.id));
  const existingFacIds = new Set(existing.factions.map((f) => f.id));

  for (const a of proposal.archetypes) {
    if (existingArchIds.has(a.id)) problems.push(`archetype id '${a.id}' already exists in the library`);
    if (!COMBAT_ROLES.includes(a.role)) problems.push(`archetype '${a.id}' role '${a.role}' is not a combat role (${COMBAT_ROLES.join('/')})`);
    if (a.sprite && !atlas.has(a.sprite)) {
      problems.push(`warn: archetype '${a.id}' sprite '${a.sprite}' is not in the atlas — dropped (a role sprite will be used)`);
      delete (a as { sprite?: string }).sprite;
    }
  }
  if (existingFacIds.has(proposal.faction.id)) problems.push(`faction id '${proposal.faction.id}' already exists in the library`);
  for (const key of proposal.faction.loot_flavor) {
    if (!BRAND_KEYS.includes(key)) problems.push(`warn: faction loot_flavor '${key}' is not a known brand key (${BRAND_KEYS.join('/')})`);
  }

  // The load-bearing invariant: refs resolve, no dups — check the MERGED library.
  const merged: Grammar = {
    archetypes: [...existing.archetypes, ...proposal.archetypes],
    factions: [...existing.factions, proposal.faction],
  };
  problems.push(...validateGrammar(merged));
  return problems;
}

export interface CommitResult { ok: boolean; problems: string[]; added?: { archetypes: number; factions: number } }

/** Re-validate against the live library and, if clean, freeze into the canonical
 *  grammar files. Idempotency is the caller's concern; this rejects id clashes. */
export function commitGrammar(proposal: InventProposal): CommitResult {
  const existing = loadGrammar();
  const problems = validateProposal(proposal, existing);
  const blocking = problems.filter((p) => !p.startsWith('warn:'));
  if (blocking.length) return { ok: false, problems };

  appendToGrammarFile(ARCHETYPES_FILE, 'archetypes', proposal.archetypes);
  appendToGrammarFile(FACTIONS_FILE, 'factions', [proposal.faction]);
  resetGrammarKit();
  return { ok: true, problems, added: { archetypes: proposal.archetypes.length, factions: 1 } };
}

// ── File writing ───────────────────────────────────────────────────────────

/** Append entries to a grammar file, preserving its { generated_at, <key>: [] } shape. */
function appendToGrammarFile(file: string, key: 'archetypes' | 'factions', entries: unknown[]): void {
  let doc: Record<string, unknown> = {};
  try { doc = (yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>) ?? {}; } catch { /* fresh file */ }
  const list = Array.isArray(doc[key]) ? (doc[key] as unknown[]) : [];
  doc[key] = [...list, ...entries];
  writeFileSync(file, yaml.dump(doc, { lineWidth: 120, noRefs: true }), 'utf8');
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function inventorSystem(): string {
  return [
    'You are the INVENTOR for a grimdark fantasy MMO — you mint NEW reusable grammar',
    'that the world-builder recombines. You output ONE faction and the archetypes it',
    'fields. Everything you mint is frozen into a shared library, so it must be',
    'general (a reusable chassis/cause), not a one-off mob.',
    '',
    'Hard rules:',
    `- ids: lowercase letters, digits, underscores only. Must be NEW (not in the library below).`,
    `- archetype.role MUST be one of: ${COMBAT_ROLES.join(', ')}.`,
    `- archetype.sprite MUST be an id from the SPRITE ATLAS below (or omit it).`,
    `- archetype.behavior is a short word (aggressive, kiting, territorial, ambush, ...).`,
    `- archetype.loot_affinity: 1-2 of ${LOOT_TAGS.join(', ')}.`,
    `- faction.archetypes MUST list the ids of the archetypes you mint here.`,
    `- faction.loot_flavor: 1-2 of ${BRAND_KEYS.join(', ')}.`,
    '- Mint 2-4 archetypes that cohere as one faction (a soldier + a tank + a ranged caster, say).',
    '',
    outputContract(SPEC_SKELETON),
  ].join('\n');
}

// The exact YAML shape the inventor must emit (parsed by extractYaml + yaml.load).
const SPEC_SKELETON = `
archetypes:
  - id: <new_lowercase_id>
    identity: "<one line: the reusable concept this chassis embodies>"
    role: <tank | pest | soldier | ranged | support>
    sprite: <atlas sprite id from the list, or omit this line>
    speed: 1.2
    behavior: <aggressive | kiting | ambush | territorial>
    aggro_range: 6
    loot_affinity: [<tag>, <tag>]
faction:
  id: <new_lowercase_id>
  name: "<the faction's name>"
  lore_hook: "<one line: the cause/identity every mob here shares>"
  archetypes: [<the archetype ids you minted above>]
  loot_flavor: [<brand_key>]
  vault_tags: [<tag>, <tag>]
  biomes: [<biome>]
`;

function inventorUser(req: InventRequest, existing: Grammar): string {
  const atlas = [...validSprites()].filter((s) => !s.startsWith('item_') && s !== 'player');
  return [
    `# Theme to invent\n${req.theme}${req.biome ? `\nBiome: ${req.biome}` : ''}`,
    '',
    `# Sprite atlas (pick archetype sprites from these)\n${atlas.join(', ')}`,
    '',
    `# Existing library ids (do NOT reuse)`,
    `archetypes: ${existing.archetypes.map((a) => a.id).join(', ') || '(none)'}`,
    `factions: ${existing.factions.map((f) => f.id).join(', ') || '(none)'}`,
    '',
    'Mint a faction + its archetypes for this theme.',
  ].join('\n');
}

// ── Offline stub ───────────────────────────────────────────────────────────

/** A deterministic, plausible proposal so the flow works without an API key.
 *  Themes the ids/identities off the request so successive invents differ. */
function stubProposal(req: InventRequest, existing: Grammar): InventProposal {
  const slug = (req.theme || 'wraith').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) || 'wraith';
  const biome = req.biome || 'tundra';
  // Disambiguate against existing ids with a numeric suffix if needed.
  const uniq = (base: string): string => {
    const ids = new Set([...existing.archetypes.map((a) => a.id), ...existing.factions.map((f) => f.id)]);
    if (!ids.has(base)) return base;
    let i = 2; while (ids.has(`${base}_${i}`)) i++; return `${base}_${i}`;
  };
  const skId = uniq(`${slug}_stalker`);
  const brId = uniq(`${slug}_juggernaut`);
  const csId = uniq(`${slug}_oracle`);
  const archetypes: Archetype[] = [
    { id: skId, identity: `A swift ${slug} that darts in, strikes, and melts back into the ${biome}.`, role: 'soldier', sprite: 'wolf_01', speed: 1.4, behavior: 'ambush', aggro_range: 7, loot_affinity: ['light_armor', 'trinket'] },
    { id: brId, identity: `A hulking ${slug} that wades through blows and crushes anything cornered.`, role: 'tank', sprite: 'hobgoblin_warlord_01', speed: 0.8, behavior: 'aggressive', aggro_range: 6, loot_affinity: ['heavy_armor', 'weapon'] },
    { id: csId, identity: `A frail ${slug} seer that hangs back and unmakes its foes from range.`, role: 'ranged', sprite: 'goblin_shaman_01', speed: 0.9, behavior: 'kiting', aggro_range: 9, loot_affinity: ['reagent', 'gem'] },
  ];
  const faction: Faction = {
    id: uniq(`${slug}_clade`),
    name: `The ${slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} Clade`,
    lore_hook: `${req.theme || 'A nameless dread'} — a cohering threat that took the ${biome} for its own.`,
    archetypes: [skId, brId, csId],
    loot_flavor: ['cold_damage'],
    vault_tags: [`${slug}_ruin`, 'shrine', 'landmark'],
    biomes: [biome],
  };
  return { faction, archetypes };
}
