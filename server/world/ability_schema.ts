// Validates ability definitions (world/abilities/*.yaml) against the engine's
// ability primitive (see docs/plan-abilities.md). Mirrors quest_schema.ts: the
// plain AbilityDef interface lives in shared/types.ts; this is the strict
// load-time gate. An ability describes WHAT happens — a controller decides WHEN.

import { z } from 'zod';
import { SCALING_COEFFS, BRAND_KEYS, CLASSES } from '../../shared/constants.ts';
import type { AbilityDef } from '../../shared/types.ts';

const ID_RE = /^[a-z][a-z0-9_]*$/;
const CLASS_VALUES = ['global', ...Object.keys(CLASSES)] as [string, ...string[]];
const rangeSchema = z.tuple([z.number(), z.number()]);
// Which faction (stats.ts factionOf) an ability/zone may land on. Omitted =
// 'enemy' (every ability authored before this field existed keeps its old
// behavior).
const sideSchema = z.enum(['ally', 'enemy', 'any']);

// Scaling grades index SCALING_COEFFS (S/A/B/C/D/E); stat keys are the four
// combat stats. Same letter-graded shape weapons use.
const gradeSchema = z.enum(Object.keys(SCALING_COEFFS) as [string, ...string[]]);
// Partial map: any subset of the four combat stats -> grade. An explicit object
// (not z.record over an enum key, which would require every key).
const scalingSchema = z.object({
  strength: gradeSchema.optional(),
  dexterity: gradeSchema.optional(),
  intelligence: gradeSchema.optional(),
  constitution: gradeSchema.optional(),
}).strict();
const brandSchema = z.string().refine((k) => (BRAND_KEYS as readonly string[]).includes(k), {
  message: `brand must be one of: ${BRAND_KEYS.join(', ')}`,
});

const damageEffect = z.object({
  kind: z.literal('damage'),
  base: rangeSchema,
  scaling: scalingSchema.optional(),
  brand: brandSchema.optional(),
}).strict();

const healEffect = z.object({
  kind: z.literal('heal'),
  base: rangeSchema,
  scaling: scalingSchema.optional(),
}).strict();

const ccSchema = z.enum(['stun', 'root', 'silence', 'confuse', 'fear', 'antagonize']);

const modifierEffect = z.object({
  kind: z.literal('modifier'),
  stats: z.record(z.string(), z.number()),
  duration_ticks: z.number().int().positive(),
  // A dot/hot: this effect fires each tick while the modifier is active.
  tick_effect: z.union([damageEffect, healEffect]).optional(),
  // Semantic crowd-control flags enforced in ai.ts/movement.ts/abilities.ts.
  cc: z.array(ccSchema).optional(),
}).strict();

const moveEffect = z.object({
  kind: z.literal('move'),
  motion: z.enum(['charge', 'leap', 'knockback', 'blink']),
  distance: z.number().int().positive(),
}).strict();

// A persistent ground zone (see World.activeZones) — independent of any
// entity, unlike `modifier`. `effect` is the damage/heal that fires each tick.
const zoneEffect = z.object({
  kind: z.literal('zone'),
  radius: z.number().positive(),
  duration_ticks: z.number().int().positive(),
  tick_interval_ticks: z.number().int().positive().optional(),
  effect: z.union([damageEffect, healEffect]),
  side: sideSchema.optional(),
}).strict();

const effectSchema = z.discriminatedUnion('kind', [damageEffect, healEffect, modifierEffect, moveEffect, zoneEffect]);

const rankSchema = z.object({
  rank: z.number().int().positive(),
  requires_level: z.number().int().positive(),
  cost_gold: z.number().int().nonnegative(),
  power_mult: z.number().positive(),
  // Overrides targeting.range / a move effect's distance at this rank — see
  // AbilityRank.range in shared/types.ts (mobility abilities like blink).
  range: z.number().positive().optional(),
  // Overrides cast.cooldown_ticks at this rank — see AbilityRank.cooldown_ticks
  // in shared/types.ts.
  cooldown_ticks: z.number().int().nonnegative().optional(),
}).strict();

export const AbilityDefSchema = z.object({
  id: z.string().regex(ID_RE),
  name: z.string().min(1),
  actor: z.enum(['player', 'mob', 'any']).optional(),
  class: z.enum(CLASS_VALUES).optional(),
  targeting: z.object({
    shape: z.enum(['self', 'target', 'projectile', 'area', 'point']),
    range: z.number().nonnegative(),
    // Only meaningful when shape is 'area' (see resolveTargets in abilities.ts).
    radius: z.number().positive().optional(),
    // Which faction this ability may land on. Omitted = 'enemy' (every ability
    // authored before this field existed keeps its old behavior).
    side: sideSchema.optional(),
    // Where an area's radius is measured from — see AbilityTargeting.origin.
    // Omitted = 'target' (the pre-existing behavior).
    origin: z.enum(['caster', 'target']).optional(),
  }).strict(),
  cast: z.object({
    cost: z.record(z.string(), z.number().nonnegative()).optional(),
    cooldown_ticks: z.number().int().nonnegative(),
    wind_up_ticks: z.number().int().nonnegative().optional(),
  }).strict(),
  effects: z.array(effectSchema).min(1),
  ranks: z.array(rankSchema).min(1).optional(),
}).strict()
  // A player ability must declare a class and a rank ladder; mob/any abilities
  // carry neither. (See docs/plan-class-abilities.md.)
  .superRefine((a, ctx) => {
    if (a.actor === 'player') {
      if (!a.class) ctx.addIssue({ code: 'custom', path: ['class'], message: 'player ability requires a class' });
      if (!a.ranks) ctx.addIssue({ code: 'custom', path: ['ranks'], message: 'player ability requires a ranks ladder' });
    }
    if (a.ranks) {
      a.ranks.forEach((r, i) => {
        if (r.rank !== i + 1) ctx.addIssue({ code: 'custom', path: ['ranks', i, 'rank'], message: `rank must be ${i + 1} (contiguous, 1-based)` });
        if (i > 0) {
          const prev = a.ranks![i - 1];
          if (r.requires_level < prev.requires_level) ctx.addIssue({ code: 'custom', path: ['ranks', i, 'requires_level'], message: 'requires_level must be non-decreasing' });
          if (r.cost_gold < prev.cost_gold) ctx.addIssue({ code: 'custom', path: ['ranks', i, 'cost_gold'], message: 'cost_gold must be non-decreasing' });
          if (r.range != null && prev.range != null && r.range < prev.range) ctx.addIssue({ code: 'custom', path: ['ranks', i, 'range'], message: 'range must be non-decreasing' });
        }
      });
    }
  });

export function validateAbilityDef(raw: unknown, file: string): AbilityDef {
  const result = AbilityDefSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Ability validation failed (${file}):\n${issues}`);
  }
  return result.data as AbilityDef;
}
