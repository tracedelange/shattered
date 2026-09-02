// Grammar — the frozen, ID-addressable vocabulary that downstream generation
// recombines instead of reinventing (see docs/v2-top-down-generation.md §4).
//
// Two composite-layer kinds live here, both pure data, both generated-once and
// human-curated, then FROZEN:
//
//   archetype — a reusable monster CHASSIS minus the skin. It fixes the knobs
//     (role, speed, behavior, aggro, loot affinity) so an instance only fills
//     id/name/sprite/level. Maps 1:1 onto create_mob fields; the engine never
//     reads archetypes — they constrain what the Implementer emits.
//
//   faction — THE coherence primitive. A bundle of references (archetype ids +
//     a loot/affix flavor + vault tags + a lore hook) that pins a zone's whole
//     identity in one pointer. A zone draws from one or two factions, so its
//     mobs + loot + structures + flavor are guaranteed to cohere.
//
// The discipline that makes this work (and makes the judge's job easy): the
// design pass may only reference grammar ids that already exist. `validateGrammar`
// enforces that invariant WITHIN the grammar — every faction's archetype refs
// must resolve — so a frozen kit is internally consistent before anything is
// built from it.
//
// Like sagas, grammar is a pipeline concern. The runtime engine never reads
// these files; a faction/archetype is realized entirely as ordinary mobs, loot,
// and prefabs.

import { z } from 'zod';
import { FACTIONS_FILE, ARCHETYPES_FILE, fileExists, readYaml } from './io.ts';
import { MOB_ROLES, BRAND_KEYS } from '../../shared/constants.ts';

const ID_RE = /^[a-z0-9_]+$/;
// Re-derived from MOB_ROLES (not imported from mutations.ts) to avoid pulling
// that heavy module's transitive deps into the grammar loader.
const MobRoleSchema = z.enum(Object.keys(MOB_ROLES) as [string, ...string[]]);

// ── Archetype ───────────────────────────────────────────────────────────────
// Every field here is a knob an instance would otherwise reinvent. They map
// directly onto MOB_BODY (see mutations.ts), so instancing is mechanical:
// create_mob from these defaults + a theme skin (name/sprite) + a level.
export const ArchetypeSchema = z.object({
  id: z.string().regex(ID_RE),
  // The reusable concept in one line ("a fragile glass figure that kites and
  // shatters"). This is the thematic identity the instance skins, not flavor
  // for any single mob.
  identity: z.string().min(1),
  role: MobRoleSchema,            // drives stats/HP/dmg via mobStats() — the chassis
  // Atlas sprite id the instance renders as. Pinned in the frozen grammar so the
  // deterministic Tier-3 translator never invents one (the client colors a mob
  // by this id; an off-atlas id renders white). Validated against the tileset at
  // grammar load. Optional for back-compat; a role-derived sprite fills the gap.
  sprite: z.string().optional(),
  speed: z.number().nonnegative(),
  behavior: z.string().min(1),    // aggressive | kiting | territorial | ...
  aggro_range: z.number().nonnegative(),
  // Item tags an instance's loot should lean toward (advisory; biases the
  // Implementer's loot_table, not engine-enforced). e.g. ['light_armor','trinket'].
  loot_affinity: z.array(z.string()).default([]),
}).strict();

// ── Faction ───────────────────────────────────────────────────────────────
export const FactionSchema = z.object({
  id: z.string().regex(ID_RE),
  name: z.string().min(1),
  // The one-line cause/identity a zone inherits. The cohesion engine: every
  // mob, drop, and structure in a faction's zone reads as one idea.
  lore_hook: z.string().min(1),
  // Archetype ids this faction fields. Cross-checked by validateGrammar — a
  // faction may not reference an archetype that doesn't exist.
  archetypes: z.array(z.string().regex(ID_RE)).min(1),
  // Affix/brand keys the faction's loot leans on (advisory theme). Warned, not
  // rejected, against BRAND_KEYS — the loot pipeline owns the final roll.
  loot_flavor: z.array(z.string()).default([]),
  // Prefab tags the Implementer stamps from for this faction's structures.
  // Forward-looking: prefabs aren't tagged yet (vault_index is a later phase).
  vault_tags: z.array(z.string()).default([]),
  // Biome ids where this faction appears (advisory placement hint).
  biomes: z.array(z.string()).default([]),
}).strict();

export const ArchetypesFileSchema = z.object({
  generated_at: z.string().nullable().optional(),
  archetypes: z.array(ArchetypeSchema).default([]),
}).passthrough();

export const FactionsFileSchema = z.object({
  generated_at: z.string().nullable().optional(),
  factions: z.array(FactionSchema).default([]),
}).passthrough();

export type Archetype = z.infer<typeof ArchetypeSchema>;
export type Faction = z.infer<typeof FactionSchema>;
export interface Grammar {
  archetypes: Archetype[];
  factions: Faction[];
}

// ---------------------------------------------------------------------------
// Loading + queries
// ---------------------------------------------------------------------------

/** Load and validate both grammar files. Returns empty arrays when absent. */
export function loadGrammar(): Grammar {
  const archetypes = fileExists(ARCHETYPES_FILE)
    ? ArchetypesFileSchema.parse(readYaml<unknown>(ARCHETYPES_FILE) ?? {}).archetypes
    : [];
  const factions = fileExists(FACTIONS_FILE)
    ? FactionsFileSchema.parse(readYaml<unknown>(FACTIONS_FILE) ?? {}).factions
    : [];
  return { archetypes, factions };
}

export function getArchetype(g: Grammar, id: string): Archetype | undefined {
  return g.archetypes.find((a) => a.id === id);
}

export function getFaction(g: Grammar, id: string): Faction | undefined {
  return g.factions.find((f) => f.id === id);
}

/**
 * Enforce the load-bearing invariant: every faction's archetype refs resolve.
 * Returns a list of human-readable problems ([] when the grammar is internally
 * consistent). Unknown loot_flavor keys are surfaced as warnings prefixed
 * `warn:` — they don't break the kit, the loot pipeline owns the final roll.
 */
export function validateGrammar(g: Grammar): string[] {
  const problems: string[] = [];
  const archIds = new Set(g.archetypes.map((a) => a.id));
  const brand = new Set(BRAND_KEYS);

  const seenArch = new Set<string>();
  for (const a of g.archetypes) {
    if (seenArch.has(a.id)) problems.push(`duplicate archetype id '${a.id}'`);
    seenArch.add(a.id);
  }

  const seenFac = new Set<string>();
  for (const f of g.factions) {
    if (seenFac.has(f.id)) problems.push(`duplicate faction id '${f.id}'`);
    seenFac.add(f.id);
    for (const ref of f.archetypes) {
      if (!archIds.has(ref)) {
        problems.push(`faction '${f.id}' references unknown archetype '${ref}'`);
      }
    }
    for (const key of f.loot_flavor) {
      if (!brand.has(key)) {
        problems.push(`warn: faction '${f.id}' loot_flavor '${key}' is not a known brand key`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Implementer-facing brief
// ---------------------------------------------------------------------------

/**
 * The brief shown to the Implementer when a zone is assigned a faction: the
 * lore hook plus every archetype expanded inline, so the model knows exactly
 * which mob chassis to instance (and from what knobs) without guessing. Mirrors
 * formatSagaBrief — context, not enforcement. Returns '' for an unknown faction.
 */
export function formatFactionBrief(g: Grammar, factionId: string): string {
  const f = getFaction(g, factionId);
  if (!f) return '';

  const lines = [
    '# Faction brief — this zone draws from a frozen faction',
    '',
    `Faction: **${f.name}** (${f.id})`,
    `Lore hook: ${f.lore_hook.replace(/\s+/g, ' ').trim()}`,
    'Build every mob, drop, and structure here so it reads as ONE idea — this faction.',
    '',
    'Field these archetypes (instance each = archetype defaults + a themed name/sprite + a level in band):',
  ];
  for (const ref of f.archetypes) {
    const a = getArchetype(g, ref);
    if (!a) {
      lines.push(`  - ${ref} — MISSING from grammar (do not instance)`);
      continue;
    }
    const loot = a.loot_affinity.length ? ` · loot→${a.loot_affinity.join('/')}` : '';
    lines.push(
      `  - ${a.id}: ${a.identity.replace(/\s+/g, ' ').trim()}`,
      `      role=${a.role} speed=${a.speed} behavior=${a.behavior} aggro=${a.aggro_range}${loot}`,
    );
  }
  if (f.loot_flavor.length) {
    lines.push('', `Loot flavor (lean affixes toward): ${f.loot_flavor.join(', ')}.`);
  }
  if (f.vault_tags.length) {
    lines.push(`Structures: stamp prefabs tagged ${f.vault_tags.join(', ')}.`);
  }
  return lines.join('\n');
}

/**
 * The Tier-2 faction kit: each faction with its archetype ids and loot flavor
 * spelled out, so the regional designer can assign a faction + pick an archetype
 * per mob task and put those ids in library_refs. Returns '' for an empty kit.
 */
export function formatFactionKit(g: Grammar): string {
  if (g.factions.length === 0) return '';
  const lines = ['# Faction kit — assign a faction + one of its archetypes per mob task'];
  for (const f of g.factions) {
    const biomes = f.biomes.length ? ` [${f.biomes.join(',')}]` : '';
    lines.push(`  - ${f.id} (${f.name})${biomes}: ${f.lore_hook.replace(/\s+/g, ' ').trim()}`);
    lines.push(`      archetypes: ${f.archetypes.join(', ')}`);
    if (f.loot_flavor.length) lines.push(`      loot flavor: ${f.loot_flavor.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * The Tier-3 chassis block: the archetype(s) named in a task's library_refs,
 * expanded into the knobs the instance must inherit. Returns '' when no ref
 * resolves to an archetype (e.g. an item/quest task, or ability-only refs).
 */
export function formatArchetypeChassis(g: Grammar, refs: string[]): string {
  const archs = refs.map((r) => getArchetype(g, r)).filter((a): a is Archetype => !!a);
  if (archs.length === 0) return '';
  const lines = [
    '# Archetype chassis — instance THIS frozen template (inherit its knobs):',
  ];
  for (const a of archs) {
    const loot = a.loot_affinity.length ? ` loot→${a.loot_affinity.join('/')}` : '';
    lines.push(
      `  ${a.id}: ${a.identity.replace(/\s+/g, ' ').trim()}`,
      `    role=${a.role} speed=${a.speed} behavior=${a.behavior} aggro_range=${a.aggro_range}${loot}`,
    );
  }
  lines.push('Keep role/speed/behavior/aggro_range from the chassis; fill only id/name/sprite/level + themed flavor.');
  return lines.join('\n');
}

/** One-line-per-faction roster for Gardener context (which kits exist to assign). */
export function formatGrammarContext(g: Grammar): string {
  if (g.factions.length === 0) return '';
  const rows = g.factions.map((f) => {
    const biomes = f.biomes.length ? ` [${f.biomes.join(',')}]` : '';
    return `  - ${f.id} (${f.name}): ${f.lore_hook.replace(/\s+/g, ' ').trim()}${biomes}`;
  });
  return '# Factions available to assign (the frozen kit)\n\n' + rows.join('\n');
}
