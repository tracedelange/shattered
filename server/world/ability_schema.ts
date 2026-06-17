// Validates ability definitions (world/abilities/*.yaml) against the engine's
// ability primitive (see docs/plan-abilities.md). Mirrors quest_schema.ts: the
// plain AbilityDef interface lives in shared/types.ts; this is the strict
// load-time gate. An ability describes WHAT happens — a controller decides WHEN.

import { z } from 'zod';
import { SCALING_COEFFS, BRAND_KEYS } from '../../shared/constants.ts';
import type { AbilityDef } from '../../shared/types.ts';

const ID_RE = /^[a-z][a-z0-9_]*$/;
const rangeSchema = z.tuple([z.number(), z.number()]);

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

const modifierEffect = z.object({
  kind: z.literal('modifier'),
  stats: z.record(z.string(), z.number()),
  duration_ticks: z.number().int().positive(),
  // A dot/hot: this effect fires each tick while the modifier is active.
  tick_effect: z.union([damageEffect, healEffect]).optional(),
}).strict();

const moveEffect = z.object({
  kind: z.literal('move'),
  motion: z.enum(['charge', 'leap', 'knockback', 'blink']),
  distance: z.number().int().positive(),
}).strict();

const effectSchema = z.discriminatedUnion('kind', [damageEffect, healEffect, modifierEffect, moveEffect]);

export const AbilityDefSchema = z.object({
  id: z.string().regex(ID_RE),
  name: z.string().min(1),
  targeting: z.object({
    shape: z.enum(['self', 'target', 'projectile', 'area']),
    range: z.number().nonnegative(),
  }).strict(),
  cast: z.object({
    cost: z.record(z.string(), z.number().nonnegative()).optional(),
    cooldown_ticks: z.number().int().nonnegative(),
    wind_up_ticks: z.number().int().nonnegative().optional(),
  }).strict(),
  effects: z.array(effectSchema).min(1),
}).strict();

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
