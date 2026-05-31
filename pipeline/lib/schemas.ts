// Zod schemas for the two LLM-output shapes. The Gardener and Implementer
// run their parsed YAML through these before writing anything. Validation
// failures feed into the repair-retry path with Zod's structured error
// messages — the LLM almost always fixes typed errors when shown the path.
//
// `passthrough()` is intentional: the LLM is free to attach type-specific
// fields to opportunities (suggested_id, connection, lore_hooks, etc.).
// We pin the structural fields and let the rest ride.

import { z } from 'zod';

export const OpportunityTypeSchema = z.enum([
  'new_zone',
  'deepen_zone',
  'add_connection',
  'faction_presence',
  'refactor_zone',
  'add_entity',
  'add_quest',
  'refactor_lore',
]);

export const OpportunityStatusSchema = z.enum([
  'pending',
  'approved',
  'implemented',
  'blocked',
  'superseded',
]);

export const OpportunitySchema = z.object({
  id: z.string().regex(/^opp_\d{3,}$/, {
    message: 'opportunity id must match /^opp_\\d{3,}$/, e.g. opp_017',
  }),
  type: OpportunityTypeSchema,
  priority: z.number().min(0).max(1),
  status: OpportunityStatusSchema,
  rationale: z.string().min(1, 'rationale must not be empty'),
}).passthrough();

export const OpportunitiesFileSchema = z.object({
  generated_at: z.string().nullable(),
  world_summary: z.string(),
  opportunities: z.array(OpportunitySchema),
}).passthrough();

// --- Implementer ---

export const ImplementerFileSchema = z.object({
  path: z.string().min(1),
  op: z.enum(['write', 'modify']),
  body: z.string().min(1, 'body must not be empty for write/modify ops'),
});

export const LoreUpdateSchema = z.object({
  zones_append: z.array(z.unknown()).optional(),
  factions_append: z.array(z.unknown()).optional(),
  geography_append: z.array(z.unknown()).optional(),
  unresolved_resolve: z.array(z.string()).optional(),
  unresolved_append: z.array(z.string()).optional(),
}).passthrough();

export const ImplementerOutputSchema = z.object({
  files: z.array(ImplementerFileSchema),
  lore_update: LoreUpdateSchema.optional(),
  notes: z.string().optional(),
  status: z.enum(['implemented', 'superseded', 'blocked']).optional(),
}).superRefine((data, ctx) => {
  // No-op contract: empty files[] requires explanatory notes.
  if (data.files.length === 0 && !data.notes) {
    ctx.addIssue({
      code: 'custom',
      path: ['notes'],
      message: 'when files[] is empty, notes is required to explain the no-op',
    });
  }
});

export type Opportunity = z.infer<typeof OpportunitySchema>;
export type OpportunitiesFile = z.infer<typeof OpportunitiesFileSchema>;
export type ImplementerFile = z.infer<typeof ImplementerFileSchema>;
export type LoreUpdate = z.infer<typeof LoreUpdateSchema>;
export type ImplementerOutput = z.infer<typeof ImplementerOutputSchema>;
