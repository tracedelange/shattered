// Zod schemas for the two LLM-output shapes. The Gardener and Implementer
// run their parsed YAML through these before writing anything. Validation
// failures feed into the repair-retry path with Zod's structured error
// messages — the LLM almost always fixes typed errors when shown the path.
//
// `passthrough()` is intentional: the LLM is free to attach type-specific
// fields to opportunities (suggested_id, connection, lore_hooks, etc.).
// We pin the structural fields and let the rest ride.

import { z } from 'zod';
import { ZONE_ARCHETYPES } from '../../shared/types.ts';
import { MutationSchema } from './mutations.ts';
import { SagaSchema } from './sagas.ts';

export const ArchetypeSchema = z.enum(
  ZONE_ARCHETYPES as unknown as [string, ...string[]],
);

export const FocalPointSchema = z.union([
  z.object({ region: z.string().min(1) }),
  z.object({ x: z.number(), y: z.number() }),
  z.object({ landmark_offset: z.object({ dx: z.number(), dy: z.number() }) }),
]);

export const SpatialConstraintSchema = z.object({
  type: z.enum(['adjacency', 'elevation', 'visibility', 'distance']),
  target: z.string().min(1),
  direction: z.string().optional(),
  relation: z.enum(['above', 'below']).optional(),
  min_zones: z.number().int().optional(),
  note: z.string().optional(),
}).passthrough();

/**
 * Implementor v2 taxonomy (docs/implementor-v2.md). The world's procedural
 * base is frozen — every type is a form of individualization. The Gardener
 * prompt's type list is generated from this array so prompt and schema can
 * never drift.
 */
export const OPPORTUNITY_TYPES = [
  'zone_enhance',   // add content to an existing generated zone (feature entries)
  'zone_connect',   // new sub-zone stub linked to a parent via portal
  'mob_populate',   // adjust a zone's creature composition; create templates as needed
  'merchant_add',   // give a merchant NPC a shop (stock list); placement is a separate mob_populate
  'prefab_create',  // define a reusable ASCII prefab in world/prefabs/
  'quest_add',      // new quest tied to existing world content
  'quest_refactor', // wire concrete objectives onto an existing quest's stages
  'lore_refactor',  // correct or restructure the lore bible
  'tile_create',    // extend a tileset with a new tile or sprite
] as const;

export const OpportunityTypeSchema = z.enum(OPPORTUNITY_TYPES);
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

// Types whose work modifies an existing zone (via file_ops). They MUST carry a
// structured `target_zone` — the whole pipeline scopes on it (context focus,
// the file_op scope guard, metrics). A zone named only in `intent` prose leaves
// the implementer with no scope and lets a weak model write to an arbitrary
// zone. quest_refactor scopes on target_quest, not a zone, so it's exempt.
export const ZONE_SCOPED_TYPES = new Set<string>([
  'zone_enhance', 'zone_connect', 'mob_populate', 'quest_add',
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
  // Narrative-spine tags: the saga this opportunity advances and which of its
  // escalation stages it realizes. Set together when an opportunity is part of
  // an arc; the Implementer is shown the saga brief and, on success, marks the
  // stage realized_by this id.
  saga_id: z.string().optional(),
  saga_stage: z.string().optional(),
}).passthrough().superRefine((opp, ctx) => {
  // Zone-modifying opportunities must declare target_zone as a field (not just
  // mention a zone in intent prose). Gardener output is validated through this
  // schema, so a missing target_zone triggers the gardener's repair retry.
  const targetZone = (opp as { target_zone?: unknown }).target_zone;
  if (ZONE_SCOPED_TYPES.has(opp.type) && (typeof targetZone !== 'string' || !targetZone.trim())) {
    ctx.addIssue({
      code: 'custom',
      path: ['target_zone'],
      message:
        `${opp.type} requires a target_zone field naming the zone it modifies ` +
        `(e.g. target_zone: zone_4_30). Do not name the zone only in intent prose.`,
    });
  }
});

export const OpportunitiesFileSchema = z.object({
  generated_at: z.string().nullable(),
  world_summary: z.string(),
  // New or updated sagas authored this run. The host upserts them into
  // world/lore/sagas.yaml by id (a returned saga fully replaces the stored one
  // of the same id). Omit when no saga work happened this run.
  sagas: z.array(SagaSchema).optional(),
  opportunities: z.array(OpportunitySchema),
}).passthrough();

// --- Implementer ---

export const ImplementerOutputSchema = z.object({
  /**
   * The entire response (Implementor v3): a flat list of validated, discriminated
   * mutation ops. Each op is one small unit the engine validates and applies
   * independently through the atomic mutation boundary (pipeline/lib/mutations.ts).
   * Replaces the old files[]/file_ops[]/new_zones[]/lore_update/tileset_update
   * channels — there is now ONE channel, so validation cannot diverge by which
   * delivery slot a create happened to land in.
   */
  mutations: z.array(MutationSchema),
  notes: z.string().optional(),
  status: z.enum(['implemented', 'superseded', 'blocked']).optional(),
}).superRefine((data, ctx) => {
  // No-op contract: a response with no ops at all requires explanatory notes.
  if (data.mutations.length === 0 && !data.notes) {
    ctx.addIssue({
      code: 'custom',
      path: ['notes'],
      message: 'when mutations is empty, notes is required to explain the no-op',
    });
  }
});

export type Opportunity = z.infer<typeof OpportunitySchema>;
export type OpportunitiesFile = z.infer<typeof OpportunitiesFileSchema>;
export type ImplementerOutput = z.infer<typeof ImplementerOutputSchema>;

// ---------------------------------------------------------------------------
// Build Plan — the intermediate intent document produced by the first LLM
// call in the two-shot Implementer flow. The LLM designs in this schema;
// the execute call receives the approved plan as additional context.
// ---------------------------------------------------------------------------

const BuildPlanZoneSchema = z.object({
  id: z.string().min(1),
  /** 'create' for a new zone file; 'modify' for changes to an existing one. */
  mode: z.enum(['create', 'modify']),
  /** 1–2 sentences: the zone's intended feel, faction, and narrative role. */
  intent: z.string().min(1),
  /** Structural archetype driving the internal spatial grammar. Required in
   *  spirit for `create`; lint warns when a created zone omits it. */
  archetype: ArchetypeSchema.optional(),
  /** The narrative anchor. Defaults to the landmark/archetype default if unset. */
  focal_point: FocalPointSchema.optional(),
  /** Spatial relationships this zone should satisfy (carried from the opportunity). */
  spatial_constraints: z.array(SpatialConstraintSchema).optional(),
  /** Prose description of the spatial layout: named regions, roads/paths,
   *  how things relate to each other, and where portals/connections land. */
  layout_sketch: z.string().min(1),
  /** Approximate size the LLM expects to use. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  default_tile: z.string().optional(),
  tileset: z.string().optional(),
  /** Which cardinal directions the zone connects to, and to which zone id. */
  connections: z.record(z.string(), z.string()).optional(),
  /** What mobs spawn where, and in what quantities. */
  spawn_summary: z.string().optional(),
  /** Potential accessibility problems to watch for during the render check:
   *  non-rect walls, isolated rooms, spawn regions near blocked tiles, etc. */
  accessibility_notes: z.string().optional(),
}).passthrough();

export const BuildPlanSchema = z.object({
  /** One entry per zone file the LLM intends to create or modify. */
  zones: z.array(BuildPlanZoneSchema),
  /** Entity template IDs the plan requires — either already existing or to be created. */
  entities_needed: z.array(z.string()).optional(),
  /** Any new tiles needed and which tileset they belong to. */
  tileset_needs: z.string().optional(),
  /** Risks, gotchas, or decisions the execute step should keep in mind. */
  execution_notes: z.string().optional(),
}).passthrough();

export type BuildPlan = z.infer<typeof BuildPlanSchema>;
export type SpatialConstraint = z.infer<typeof SpatialConstraintSchema>;
