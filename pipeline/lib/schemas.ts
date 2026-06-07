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
  direction: z.enum(['north', 'south', 'east', 'west']).optional(),
  relation: z.enum(['above', 'below']).optional(),
  min_zones: z.number().int().optional(),
  note: z.string().optional(),
}).passthrough();

export const OpportunityTypeSchema = z.enum([
  'new_zone',
  'deepen_zone',
  'add_connection',
  'faction_presence',
  'refactor_zone',
  'add_entity',
  'add_quest',
  'refactor_quest',
  'refactor_lore',
  'add_tile',
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
  // Append-only fields — safe for any opportunity type.
  zones_append: z.array(z.unknown()).optional(),
  factions_append: z.array(z.unknown()).optional(),
  geography_append: z.array(z.unknown()).optional(),
  // Replace fields — overwrite the entire section. Use for refactor_lore cleanup.
  // If both _replace and _append are set for the same key, _replace wins.
  zones_replace: z.array(z.unknown()).optional(),
  factions_replace: z.array(z.unknown()).optional(),
  geography_replace: z.array(z.unknown()).optional(),
  // Unresolved thread management.
  unresolved_resolve: z.array(z.string()).optional(),
  unresolved_append: z.array(z.string()).optional(),
  // Replace the entire unresolved list (use for bulk cleanup).
  unresolved_replace: z.array(z.string()).optional(),
}).passthrough();

// Per-tile / per-sprite entry. `blocking: true` opts the tile into the
// runtime blocking set at world-load time — use it for any solid tile that
// isn't already in the hardcoded base set (wall/water/void/tree).
const TileEntrySchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, {
    message: 'color must be a #rrggbb hex string',
  }),
  blocking: z.boolean().optional(),
}).passthrough();

export const TilesetUpdateSchema = z.object({
  tileset: z.string().min(1, 'tileset name is required'),
  tiles_add: z.record(z.string(), TileEntrySchema).optional(),
  sprites_add: z.record(z.string(), TileEntrySchema).optional(),
}).superRefine((data, ctx) => {
  const tiles = data.tiles_add ? Object.keys(data.tiles_add).length : 0;
  const sprites = data.sprites_add ? Object.keys(data.sprites_add).length : 0;
  if (tiles + sprites === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['tiles_add'],
      message: 'tileset_update must add at least one tile or sprite',
    });
  }
});

export const ImplementerOutputSchema = z.object({
  files: z.array(ImplementerFileSchema),
  lore_update: LoreUpdateSchema.optional(),
  tileset_update: TilesetUpdateSchema.optional(),
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
export type TilesetUpdate = z.infer<typeof TilesetUpdateSchema>;
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
