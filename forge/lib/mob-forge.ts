// The one-shot: direct mob-template generation with co-minted ability kits.
// A mob is only as interesting as its actions, so a mob and its ability KIT are
// proposed together in one call. Each kit entry is either an existing ability id
// (explicit reuse) or a new inline definition; the resolver (ability-mint.ts)
// then reuses an equivalent if one exists, else lints and mints. Output is the
// LIVE data model — world/entities/mobs/*.yaml (role + abilities) plus any newly
// minted world/abilities/*.yaml — with no dependency on the (dormant) grammar
// cascade.
//
// Runs offline (stub) by default so the whole flow is testable without an API
// key; FORGE_LIVE=1 makes the real call. Dry-run by default; --commit writes.

import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { z } from 'zod';
import { callAndValidate } from '../../pipeline/lib/validate.ts';
import { AbilityDefSchema } from '../../server/world/ability_schema.ts';
import { MOB_ROLES, BRAND_KEYS } from '../../shared/constants.ts';
import { loadAbilityPool, resolveAbilityKit, writeMintedAbilities, type KitEntry } from './ability-mint.ts';
import { validSprites, spriteForRole } from './sprites.ts';
import { tierModel } from './models.ts';
import { sleep } from './util.ts';
import { outputContract } from './yamlContract.ts';
import type { AbilityDef, AbilityEffect, MobAbilityEntry, CcKind } from '../../shared/types.ts';

const MOBS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'world', 'entities', 'mobs');
const ID_RE = /^[a-z][a-z0-9_]*$/;
// The generator only mints threats — npc/passive are fixtures placed by hand.
const COMBAT_ROLES = (Object.keys(MOB_ROLES) as string[]).filter((r) => r !== 'npc' && r !== 'passive') as [string, ...string[]];
const ALL_CC: CcKind[] = ['stun', 'root', 'silence', 'confuse', 'fear', 'antagonize'];
const ALL_SHAPES = ['self', 'target', 'projectile', 'area'];
const ALL_MOTIONS = ['charge', 'leap', 'knockback', 'blink'];

// theme/biome are optional — omit both for self-directed exploration mode,
// where the model picks its own concept from the roster + gap analysis rather
// than following an operator-authored brief. level_min/level_max scope the
// role-gap histogram shown in that mode; level remains the per-call target.
export interface MobBrief { theme?: string; biome?: string; level: number; level_min?: number; level_max?: number; count: number }

// ── Output schema (what the model emits) ─────────────────────────────────────
// A kit entry is EITHER a reuse-by-id or an inline new definition; weight/hp_below
// are the mob-side usage knobs (see MobAbilityEntry), carried through resolution.
const kitEntrySchema = z.union([
  z.object({ ability: z.string(), weight: z.number().positive().optional(), hp_below: z.number().min(0).max(1).optional() }).strict(),
  z.object({ define: AbilityDefSchema, weight: z.number().positive().optional(), hp_below: z.number().min(0).max(1).optional() }).strict(),
]);

const genMobSchema = z.object({
  id: z.string().regex(ID_RE),
  name: z.string().min(1),
  // Short kebab tag naming the mob's dominant concept space (biome/culture/
  // creature-family), e.g. frostpeak-mountains, sunken-clockwork, ashfall-nomads.
  // Used by exploration mode to enforce spread across the run; never persisted.
  concept_axis: z.string().optional(),
  sprite: z.string().optional(),
  level: z.number().int().positive(),
  level_range: z.tuple([z.number().int(), z.number().int()]).optional(),
  role: z.enum(COMBAT_ROLES),
  speed: z.number().positive(),
  behavior: z.string().min(1),
  aggro_range: z.number().nonnegative(),
  preferred_range: z.number().positive().optional(),
  xp: z.number().int().nonnegative().optional(),
  resistances: z.record(z.string(), z.number()).optional(),
  abilities: z.array(kitEntrySchema).default([]),
}).strict();

const batchSchema = z.object({ mobs: z.array(genMobSchema).min(1) });
type GenMob = z.infer<typeof genMobSchema>;

// ── Design-space gaps, computed LIVE from the pool (never a stale doc) ────────
interface Gaps { brands: string[]; cc: string[]; shapes: string[]; motions: string[] }
function computeGaps(pool: AbilityDef[]): Gaps {
  const seen = { brands: new Set<string>(), cc: new Set<string>(), shapes: new Set<string>(), motions: new Set<string>() };
  for (const a of pool) {
    seen.shapes.add(a.targeting.shape);
    for (const e of a.effects) scanEffect(e, seen);
  }
  return {
    brands: BRAND_KEYS.filter((b) => !seen.brands.has(b)),
    cc: ALL_CC.filter((c) => !seen.cc.has(c)),
    shapes: ALL_SHAPES.filter((s) => !seen.shapes.has(s)),
    motions: ALL_MOTIONS.filter((m) => !seen.motions.has(m)),
  };
}
function scanEffect(e: AbilityEffect, seen: { brands: Set<string>; cc: Set<string>; motions: Set<string> }): void {
  if (e.kind === 'damage' && e.brand) seen.brands.add(e.brand);
  if (e.kind === 'modifier') { for (const c of e.cc ?? []) seen.cc.add(c); if (e.tick_effect) scanEffect(e.tick_effect, seen); }
  if (e.kind === 'move') seen.motions.add(e.motion);
  if (e.kind === 'zone') { if (e.effect.kind === 'damage' && e.effect.brand) seen.brands.add(e.effect.brand); }
}

// ── Existing mob roster (so the model doesn't reinvent the same archetype
// under a new name every call — the ability pool already gets this treatment
// via loadAbilityPool, mob CONCEPTS didn't) ──────────────────────────────────
export interface RosterEntry { id: string; name: string; role: string; behavior: string; level: number }
export function loadMobRoster(): RosterEntry[] {
  return readdirSync(MOBS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => yaml.load(readFileSync(join(MOBS_DIR, f), 'utf8')) as Record<string, unknown>)
    .filter((m) => m?.id && m.role && m.role !== 'npc' && m.role !== 'passive')
    .map((m) => ({
      id: String(m.id), name: String(m.name ?? m.id), role: String(m.role),
      behavior: String(m.behavior ?? ''), level: typeof m.level === 'number' ? m.level : 1,
    }));
}
function rosterSummary(r: RosterEntry): string {
  return `${r.id} (Lv${r.level} ${r.role}, ${r.behavior}) — ${r.name}`;
}

// Role coverage within a level band, so exploration mode can point the model
// at the thinnest niches instead of it guessing blind.
function roleHistogram(roster: RosterEntry[], lo: number, hi: number): string {
  const counts = Object.fromEntries(COMBAT_ROLES.map((r) => [r, 0])) as Record<string, number>;
  for (const r of roster) if (r.level >= lo && r.level <= hi) counts[r.role] = (counts[r.role] ?? 0) + 1;
  const parts = COMBAT_ROLES.map((r) => `${r}=${counts[r]}`);
  const thin = COMBAT_ROLES.filter((r) => (counts[r] ?? 0) <= 1);
  return `role counts in level ${lo}-${hi}: ${parts.join(', ')}` + (thin.length ? ` — thin/absent: ${thin.join(', ')}` : '');
}

// One-line functional summary of an existing ability, for the reuse menu.
function abilitySummary(a: AbilityDef): string {
  const t = a.targeting;
  const eff = a.effects.map((e) => {
    if (e.kind === 'damage') return `damage${e.brand ? `/${e.brand.replace('_damage', '')}` : ''}`;
    if (e.kind === 'heal') return 'heal';
    if (e.kind === 'modifier') return e.cc?.length ? `cc:${e.cc.join('+')}` : (e.tick_effect ? 'dot/hot' : 'buff/debuff');
    if (e.kind === 'move') return `move:${e.motion}`;
    return `zone:${e.effect.kind}`;
  }).join('+');
  return `${a.id} — ${t.shape}${t.side && t.side !== 'enemy' ? `/${t.side}` : ''}, ${eff}`;
}

// ── Prompt ────────────────────────────────────────────────────────────────────
function forgeSystem(pool: AbilityDef[], gaps: Gaps): string {
  const mobPool = pool.filter((a) => a.actor !== 'player');
  const gapLine = (label: string, vals: string[]) => vals.length ? `${label}: ${vals.join(', ')}` : `${label}: (all covered)`;
  return [
    'You are the MOB FORGE for a grimdark fantasy MMO. You generate combat mobs — a',
    'mob is only as interesting as its ACTIONS, so you design each mob together with',
    'its ability kit (1-3 abilities). Stats/HP/damage derive from role + level; never',
    'set them.',
    '',
    'Roles (pick one per mob):',
    '- tank: high HP, closes to melee, a real threat if ignored.',
    '- soldier: the stock all-around melee mob.',
    '- pest: weak, swarms; cheap kit.',
    '- ranged: keeps distance (set preferred_range), archer/caster damage.',
    '- support: buffs/heals allies (needs ally-side abilities), light damage.',
    '',
    'Ability kit rules — REUSE FIRST:',
    '- For each ability a mob wants, PREFER an existing one: put { ability: <id> }.',
    '- Only DEFINE a new ability when nothing existing does that function. NEVER define',
    '  a near-duplicate of an existing ability under a new name — the library must stay',
    '  lean in function. (A resolver will auto-reject duplicates, so reuse is free.)',
    '- When you do define, bias toward the UNCOVERED design space below.',
    '- Heals/buffs for allies MUST set targeting.side: ally (a support that heals the',
    '  enemy is a bug). shape: area MUST set a radius.',
    '- Mob abilities are flat: actor: mob, no class, no ranks, cost: {}.',
    '',
    `# Existing abilities you can reuse (id — function)\n${mobPool.map(abilitySummary).map((s) => `  ${s}`).join('\n')}`,
    '',
    '# Uncovered design space — bias NEW definitions here so the grid fills',
    `  ${gapLine('brands', gaps.brands.map((b) => b.replace('_damage', '')))}`,
    `  ${gapLine('crowd-control', gaps.cc)}`,
    `  ${gapLine('targeting shapes', gaps.shapes)}`,
    `  ${gapLine('move motions', gaps.motions)}`,
    '',
    outputContract(SPEC_SKELETON),
  ].join('\n');
}

const SPEC_SKELETON = `
mobs:
  - id: <new_lowercase_id>
    name: "<Display Name>"
    concept_axis: <short-kebab-tag naming biome/culture/family; exploration mode only, else omit>
    sprite: <atlas sprite id, or omit for a role default>
    level: <int>
    role: <tank | soldier | pest | ranged | support>
    speed: 1.0
    behavior: <aggressive | kiting | patrol | ambush | territorial>
    aggro_range: 6
    preferred_range: <tiles, ranged/support only; omit for melee>
    resistances: { <brand_damage>: <0=immune|1=normal|>1=vulnerable> }   # optional
    abilities:
      - { ability: <existing_id>, weight: 3 }        # REUSE an existing ability
      - define:                                       # or MINT a new one
          id: <new_lowercase_id>
          name: "<Display Name>"
          actor: mob
          targeting: { shape: <self|target|projectile|area>, range: <int>, radius: <int, area only>, side: <ally|enemy, omit=enemy> }
          cast: { cost: {}, cooldown_ticks: <int>, wind_up_ticks: <int, optional telegraph> }
          effects:
            - { kind: damage, base: [<lo>, <hi>], brand: <brand_damage, optional> }
            - { kind: modifier, stats: {}, duration_ticks: <int>, cc: [<stun|root|silence|confuse|fear|antagonize>] }
        weight: 2
        hp_below: <0..1, optional: only when the mob is below this hp fraction>
`;

function forgeUser(brief: MobBrief, atlas: Set<string>, roster: RosterEntry[], opts: { fullRoster?: boolean; assignSprite?: boolean; avoidAxes?: string[] } = {}): string {
  const sprites = [...atlas].filter((s) => !s.startsWith('item_') && s !== 'player');
  const shown = opts.fullRoster
    ? [...roster].sort((a, b) => a.level - b.level)
    : roster.filter((r) => Math.abs(r.level - brief.level) <= 8)
        .sort((a, b) => Math.abs(a.level - brief.level) - Math.abs(b.level - brief.level))
        .slice(0, 40);

  const lines: string[] = ['# Brief'];
  if (brief.theme) lines.push(`Theme: ${brief.theme}`);
  if (brief.biome) lines.push(`Biome: ${brief.biome}`);
  // Biome-anchored exploration: the loop assigns the biome (one of the world's
  // real land biomes); the model invents a creature that BELONGS in it. This is
  // a staging pool to hand-pick from, so favour breadth — but breadth WITHIN the
  // assigned biome (different creature-families/niches), never a mob that would
  // look out of place there.
  if (opts.fullRoster && brief.biome) {
    lines.push(
      `Invent a mob that plausibly lives in a ${brief.biome} — its look, habits, ` +
      `and abilities should read as native to that terrain. It must be a genuinely ` +
      `distinct NICHE from the ${brief.biome} mobs already in the roster below, not ` +
      `a reskin. Do NOT invent creatures for other biomes or for places the world ` +
      `has no room for (no reefs, no cloud temples, no volcano-forges).`,
    );
    lines.push(
      'Declare a `concept_axis` — a short kebab tag for the creature-FAMILY/niche ' +
      `within this biome (e.g. for swamp: bog-amphibian, drowned-dead, will-o-wisp, ` +
      `carnivorous-flora). Reskins of the same niche share an axis.`,
    );
    if (opts.avoidAxes?.length) {
      lines.push(
        `# Niches already covered in ${brief.biome} — pick a DIFFERENT one; do NOT ` +
        `use these or any near-synonym/reskin:\n  ${opts.avoidAxes.join(', ')}`,
      );
    }
  }
  lines.push(`Target level: ~${brief.level}${brief.level_min != null && brief.level_max != null ? ` (band ${brief.level_min}-${brief.level_max})` : ''}`);
  lines.push(`Generate ${brief.count} mob(s)${brief.count > 1 ? ' that cohere as one threat group' : ''}.`);
  lines.push('');
  if (opts.fullRoster && brief.level_min != null && brief.level_max != null) {
    lines.push(`# ${roleHistogram(roster, brief.level_min, brief.level_max)}`);
    lines.push('Bias toward the thin/absent roles above when it fits the concept.');
    lines.push('');
  }
  lines.push(shown.length
    ? '# Existing mobs — DO NOT reinvent these archetypes under a new name (e.g.\n' +
      'another "sneaky goblin skirmisher" or "shaman variant"). Each new mob must\n' +
      `read as a clearly distinct NICHE concept from every entry below.\n${shown.map((r) => `  ${rosterSummary(r)}`).join('\n')}`
    : '# No existing mobs yet — first mover, invent freely.');
  if (opts.assignSprite === false) {
    lines.push('');
    lines.push('# Sprite: omit — sprites are assigned in a later stage, not by you.');
  } else {
    lines.push('');
    lines.push(`# Sprite atlas (pick sprites from these, or omit)\n${sprites.join(', ')}`);
  }
  return lines.join('\n');
}

// ── Offline stub ─────────────────────────────────────────────────────────────
// Deterministic, plausible, and exercises all three resolver paths: a reuse, a
// proposed near-duplicate (reused), and a genuine gap-filling mint (electricity).
function stubBatch(brief: MobBrief): z.infer<typeof batchSchema> {
  const slug = (brief.theme || 'wretch').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) || 'wretch';
  const lvl = Math.max(1, brief.level);
  const shockBolt: AbilityDef = {
    id: `${slug}_shock`, name: 'Shock Bolt', actor: 'mob',
    targeting: { shape: 'projectile', range: 7 },
    cast: { cost: {}, cooldown_ticks: 16 },
    effects: [
      { kind: 'damage', base: [lvl, lvl * 2], brand: 'electricity_damage' },
      { kind: 'modifier', stats: {}, duration_ticks: 4, cc: ['stun'] },
    ],
  };
  return {
    mobs: [
      {
        id: `${slug}_stormcaller`, name: `${title(slug)} Stormcaller`, sprite: 'goblin_shaman_01',
        level: lvl, role: 'ranged', speed: 0.9, behavior: 'kiting', aggro_range: 8, preferred_range: 5,
        abilities: [
          { define: shockBolt, weight: 3 },
          { ability: 'arrow_shot', weight: 1 },
        ],
      },
      {
        id: `${slug}_brute`, name: `${title(slug)} Brute`, sprite: 'hobgoblin_warlord_01',
        level: lvl, role: 'tank', speed: 0.85, behavior: 'aggressive', aggro_range: 6,
        abilities: [{ ability: 'shieldbash', weight: 2 }],
      },
    ].slice(0, Math.max(1, brief.count)),
  };
}
const title = (s: string): string => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ── Orchestration ─────────────────────────────────────────────────────────────
export interface ForgeResult {
  mobs: Record<string, unknown>[];
  minted: AbilityDef[];
  reused: string[];
  problems: string[];
  /** The concept_axis tag(s) the model declared for this batch, in mob order —
   *  exploration mode uses these to track and enforce spread across the run. */
  axes: string[];
}

export interface ForgeOpts {
  live: boolean;
  signal?: AbortSignal;
  /** Abilities minted earlier in this run but not yet committed to disk — merged
   *  into the reuse pool so a long exploration run doesn't re-mint the same
   *  function across separate candidates. */
  extraPool?: AbilityDef[];
  /** Mobs proposed earlier in this run but not yet committed to disk — merged
   *  into the roster shown to the model, same reasoning as extraPool. */
  extraRoster?: RosterEntry[];
  /** Show the model the ENTIRE roster (+ role-gap histogram) instead of just
   *  nearby-level entries — for self-directed exploration, not operator briefs. */
  fullRoster?: boolean;
  /** Resolve and attach a real atlas sprite to each mob (default true). Candidate
   *  generation (not yet committed to the live world) should leave this false —
   *  sprite assignment is a follow-on stage applied only to approved mobs. */
  assignSprite?: boolean;
  /** Concept axes already over-represented in this run — exploration mode passes
   *  these so the prompt can steer the model OFF the dominant theme (repulsion
   *  against the accumulating majority, the fix for single-biome collapse). */
  avoidAxes?: string[];
}

export async function forgeMobs(brief: MobBrief, opts: ForgeOpts): Promise<ForgeResult> {
  const pool = [...loadAbilityPool(), ...(opts.extraPool ?? [])];
  const atlas = validSprites();
  const roster = [...loadMobRoster(), ...(opts.extraRoster ?? [])];
  let batch: z.infer<typeof batchSchema>;

  if (opts.live) {
    const gaps = computeGaps(pool);
    const { value } = await callAndValidate({
      label: 'mob-forge', model: tierModel('tier1'), signal: opts.signal,
      system: [forgeSystem(pool, gaps)], user: forgeUser(brief, atlas, roster, { fullRoster: opts.fullRoster, assignSprite: opts.assignSprite, avoidAxes: opts.avoidAxes }), schema: batchSchema,
    });
    batch = value;
  } else {
    await sleep(200, opts.signal);
    batch = stubBatch(brief);
  }

  // Thread the working pool across mobs so two mobs wanting the same NEW function
  // share one minted ability instead of minting it twice.
  const working = [...pool];
  const minted: AbilityDef[] = [];
  const reused: string[] = [];
  const problems: string[] = [];
  const mobs: Record<string, unknown>[] = [];
  const axes: string[] = [];

  for (const gm of batch.mobs) {
    if (gm.concept_axis) axes.push(gm.concept_axis.trim().toLowerCase());
    // The define branch is schema-validated but zod infers `class: string` where
    // AbilityDef wants the narrower AbilityClass union — a nominal-only gap (mob
    // abilities carry no class), so cast. actor is forced to 'mob'.
    const kit: KitEntry[] = gm.abilities.map((e) => ('define' in e ? ({ ...e.define, actor: 'mob' } as AbilityDef) : e.ability));
    const res = resolveAbilityKit(kit, working);
    working.push(...res.minted);
    minted.push(...res.minted);
    reused.push(...res.reused);
    problems.push(...res.problems.map((p) => `[${gm.id}] ${p}`));

    // Build the mob's ability list from the aligned resolution, carrying each
    // entry's weight/hp_below; drop rejected (null) entries and de-dup by id.
    const abilities: MobAbilityEntry[] = [];
    const seen = new Set<string>();
    res.resolved.forEach((id, i) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const src = gm.abilities[i]!;
      abilities.push({ ability: id, ...(src.weight != null ? { weight: src.weight } : {}), ...(src.hp_below != null ? { hp_below: src.hp_below } : {}) });
    });
    mobs.push(finalizeMob(gm, abilities, atlas, opts.assignSprite ?? true, brief.biome));
  }

  return { mobs, minted, reused, problems, axes };
}

// Assemble the final mob object in a stable field order; resolve the sprite to
// a real atlas id (role-derived fallback if the model omitted or invented one)
// — unless assignSprite is false, in which case sprite is left unset entirely
// (a follow-on stage assigns sprites only to approved candidates).
function finalizeMob(gm: GenMob, abilities: MobAbilityEntry[], atlas: Set<string>, assignSprite: boolean, biome?: string): Record<string, unknown> {
  const sprite = assignSprite ? (gm.sprite && atlas.has(gm.sprite) ? gm.sprite : spriteForRole(gm.role, gm.id)) : undefined;
  return {
    id: gm.id,
    name: gm.name,
    ...(sprite ? { sprite } : {}),
    level: gm.level,
    ...(gm.level_range ? { level_range: gm.level_range } : {}),
    // Loop-assigned biome affinity so the candidate spawns only in its terrain.
    ...(biome ? { biomes: [biome] } : {}),
    role: gm.role,
    speed: gm.speed,
    behavior: gm.behavior,
    aggro_range: gm.aggro_range,
    ...(gm.preferred_range != null ? { preferred_range: gm.preferred_range } : {}),
    ...(gm.xp != null ? { xp: gm.xp } : {}),
    ...(gm.resistances ? { resistances: gm.resistances } : {}),
    ...(abilities.length ? { abilities } : {}),
  };
}

/** Persist a forge result: minted abilities first (so the mob refs resolve at
 *  load), then the mob templates. Returns the files written. */
export function commitForge(result: ForgeResult): string[] {
  const written = writeMintedAbilities(result.minted);
  for (const mob of result.mobs) {
    const file = join(MOBS_DIR, `${mob.id}.yaml`);
    writeFileSync(file, yaml.dump(mob, { lineWidth: 120, noRefs: true }), 'utf8');
    written.push(file);
  }
  return written;
}

/** Stage a forge result for review WITHOUT touching the live world/entities/mobs
 *  or world/abilities directories — one self-contained file per mob (its data
 *  plus any abilities it minted), so a reviewer can inspect and greenlight
 *  candidates individually before anything goes live. */
export function writeCandidates(result: ForgeResult, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const mintedById = new Map(result.minted.map((a) => [a.id, a]));
  const written: string[] = [];
  for (const mob of result.mobs) {
    const abilityIds = ((mob.abilities as MobAbilityEntry[] | undefined) ?? []).map((a) => a.ability);
    const mintedForThisMob = abilityIds.map((id) => mintedById.get(id)).filter((a): a is AbilityDef => !!a);
    const file = join(dir, `${mob.id}.yaml`);
    writeFileSync(file, yaml.dump({ mob, minted_abilities: mintedForThisMob }, { lineWidth: 120, noRefs: true }), 'utf8');
    written.push(file);
  }
  return written;
}
