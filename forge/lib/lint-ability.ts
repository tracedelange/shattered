// The semantic gate for ability definitions — the layer AbilityDefSchema can't
// cover. The schema (server/world/ability_schema.ts) enforces shape: types,
// enums, no-unknown-fields, the rank ladder. This enforces MEANING: cross-field
// rules that are individually well-typed but combine into a no-op or a footgun.
//
// This is the "validate" half of a propose→validate→freeze loop for GENERATED
// abilities — the same role validateProposal plays for the grammar inventor.
// Deliberately no balance/power-budget check here: damage-per-cast vs level band
// is a real gate too, but it needs numbers the designer owns and is better run
// through tools/combat-sim.ts. This file only catches what is unambiguously wrong
// regardless of tuning. Every hand-authored ability in world/abilities/ passes it
// (that is the regression fixture — see tools/lint-abilities.ts).
//
// Convention mirrors inventor.ts: returns a flat string[] of problems; entries
// prefixed `warn:` are advisory (design smells), everything else is blocking.

import { validateAbilityDef } from '../../server/world/ability_schema.ts';
import type { AbilityDef, AbilityEffect, DamageEffect, HealEffect, Range } from '../../shared/types.ts';

// The default when targeting.side / zone side is omitted (matches abilities.ts).
const DEFAULT_SIDE = 'enemy';

function baseProblems(label: string, base: Range): string[] {
  const [lo, hi] = base;
  const out: string[] = [];
  // rangeSchema is z.tuple([number, number]) — it never checks order or sign, so
  // a generator can emit [16, 10] or [-5, 3] and the engine would rollRange it.
  if (lo > hi) out.push(`${label} base [${lo}, ${hi}] is inverted (lo > hi)`);
  if (lo < 0 || hi < 0) out.push(`${label} base [${lo}, ${hi}] is negative`);
  return out;
}

// Walk every damage/heal base an ability rolls — top-level effects, a modifier's
// dot/hot tick_effect, and a zone's per-tick effect.
function eachRolledEffect(effects: AbilityEffect[]): { label: string; e: DamageEffect | HealEffect }[] {
  const out: { label: string; e: DamageEffect | HealEffect }[] = [];
  effects.forEach((e, i) => {
    if (e.kind === 'damage' || e.kind === 'heal') out.push({ label: `effects[${i}]`, e });
    if (e.kind === 'modifier' && e.tick_effect) out.push({ label: `effects[${i}].tick_effect`, e: e.tick_effect });
    if (e.kind === 'zone') out.push({ label: `effects[${i}].effect`, e: e.effect });
  });
  return out;
}

/** Semantic problems for an already-schema-valid AbilityDef. `warn:`-prefixed
 *  entries are advisory; any other entry is blocking. */
export function lintAbility(def: AbilityDef): string[] {
  const out: string[] = [];
  const { shape, radius, side: tSide, origin } = def.targeting;
  const side = tSide ?? DEFAULT_SIDE;
  const isMob = def.actor !== 'player';

  // ── Targeting coherence ─────────────────────────────────────────────────────
  // radius is read ONLY when shape === 'area' (resolveTargets). Either mismatch
  // is a silent bug: a radius on a non-area shape does nothing, and an area with
  // no radius degrades to a single-target hit — the AoE intent just vanishes.
  if (radius != null && shape !== 'area') out.push(`radius is set but shape is '${shape}' — radius only applies to shape: area`);
  if (shape === 'area' && radius == null) out.push(`shape: area needs a radius, else it silently resolves to a single target`);
  // Same silent-no-op class as radius: resolveTargets only consults `origin` on
  // the area branch, so setting it anywhere else reads as intent that never runs.
  if (origin != null && shape !== 'area') out.push(`origin is set but shape is '${shape}' — origin only applies to shape: area`);

  // ── Actor/rank coherence ────────────────────────────────────────────────────
  // The schema forces player→ranks but never forbids the converse: a mob/any
  // ability is flat single-power and must carry no rank ladder.
  if (isMob && def.ranks) out.push(`ranks are forbidden on actor '${def.actor ?? 'mob'}' — mob/any abilities are flat single-power`);

  // ── Disposition coherence (the mending_touch footgun) ───────────────────────
  // side defaults to 'enemy'. A heal aimed at the enemy heals whoever you're
  // fighting; a direct damage effect aimed at an ally is friendly fire. The first
  // has no legitimate use (blocking); the second occasionally might (advisory).
  // shape: self is exempt — resolveTargets always returns the actor and never
  // reads side, so a self-heal keeps the default side harmlessly.
  const heals = def.effects.some((e) => e.kind === 'heal' || (e.kind === 'zone' && e.effect.kind === 'heal'));
  const directDamage = def.effects.some((e) => e.kind === 'damage' || (e.kind === 'zone' && e.effect.kind === 'damage'));
  if (shape !== 'self') {
    if (heals && side === 'enemy') out.push(`heals but targeting.side is 'enemy' (default) — it would heal the target it lands on; set side: ally`);
    if (directDamage && side === 'ally') out.push(`warn: deals damage but targeting.side is 'ally' — friendly fire, intended?`);
  }

  // A zone can carry its own side independent of targeting.side; check it too.
  for (const e of def.effects) {
    if (e.kind !== 'zone') continue;
    const zSide = e.side ?? DEFAULT_SIDE;
    if (e.effect.kind === 'heal' && zSide === 'enemy') out.push(`zone heals but zone side is 'enemy' (default) — set side: ally`);
    if (e.effect.kind === 'damage' && zSide === 'ally') out.push(`warn: zone deals damage but zone side is 'ally' — friendly fire, intended?`);
  }

  // ── Base ranges ─────────────────────────────────────────────────────────────
  for (const { label, e } of eachRolledEffect(def.effects)) out.push(...baseProblems(label, e.base));

  // ── Move coherence ──────────────────────────────────────────────────────────
  // charge/leap/knockback move relative to a TARGET; on shape: self there is no
  // target to move toward/away from. blink is a self-reposition — fine on self.
  for (const e of def.effects) {
    if (e.kind === 'move' && e.motion !== 'blink' && shape === 'self') {
      out.push(`warn: motion '${e.motion}' needs a target but shape is 'self' — only 'blink' repositions the self`);
    }
  }

  // ── Economy smells (advisory — see design-space doc) ────────────────────────
  const cost = def.cast.cost ?? {};
  const hasCost = Object.values(cost).some((v) => v > 0);
  if (isMob && hasCost) out.push(`warn: mob ability has a resource cost — no mob mana economy exists today, mob abilities are free/cooldown-only`);
  if (directDamage && def.cast.cooldown_ticks === 0 && !hasCost) out.push(`warn: damaging ability has 0 cooldown and no cost — spammable every tick`);

  return out;
}

/** Parse raw YAML/JSON through the schema, then the semantic gate. Throws on a
 *  schema failure (same as load-time); returns semantic problems otherwise. */
export function lintAbilityRaw(raw: unknown, file: string): { def: AbilityDef; problems: string[] } {
  const def = validateAbilityDef(raw, file);
  return { def, problems: lintAbility(def) };
}
