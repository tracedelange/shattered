// The three intermediate artifact schemas — the spine of the cascade. Each tier
// is a `callAndValidate` against its schema, so a malformed LLM response
// self-repairs once (same machinery the existing pipeline uses).

import { z } from 'zod';

// ── Tier 1: the World Blueprint (broad strokes, region division, constraints) ──
export const RegionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  overview: z.string().min(1),
  motif: z.string().min(1),
  zones: z.array(z.string().min(1)).min(1),
  // Constraints handed DOWN to Tier 2 for this region.
  constraints: z.array(z.string().min(1)).default([]),
});

export const ZoneSketchSchema = z.object({
  zone: z.string().min(1),
  region: z.string().min(1),
  summary: z.string().min(1),
  role: z.string().min(1), // role in the arc (hub, on-ramp, fringe, capstone, ...)
});

export const WorldBlueprintSchema = z.object({
  storyline: z.string().min(1),
  lore_additions: z.string().min(1),
  regions: z.array(RegionSchema).min(1),
  zone_sketches: z.array(ZoneSketchSchema).min(1),
});
export type WorldBlueprint = z.infer<typeof WorldBlueprintSchema>;
export type Region = z.infer<typeof RegionSchema>;

// ── Tier 2: a Region Plan (hyper-specific implementation tasks) ────────────────
export const TASK_KINDS = ['mob', 'item', 'quest', 'zone'] as const;

export const TaskSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(TASK_KINDS),
  zone: z.string().min(1),
  // The hyper-specific requirement Tier 3 translates into schema YAML.
  requirement: z.string().min(1),
  // Content-library ids (archetypes, factions, quest templates) this task draws on.
  library_refs: z.array(z.string().min(1)).default([]),
});

export const RegionPlanSchema = z.object({
  region_id: z.string().min(1),
  tasks: z.array(TaskSchema).min(1),
});
export type RegionPlan = z.infer<typeof RegionPlanSchema>;
export type Task = z.infer<typeof TaskSchema>;

// ── Tier 3: an Artifact (engine-schema YAML, staged to runs/) ──────────────────
// `content` is the YAML body; the real Tier 3 validates it against the engine's
// per-type schema (MobBodySchema, QuestBodySchema, ...). Here it's a record so
// the cascade can stage anything and the UI can render it.
export const ArtifactSchema = z.object({
  task_id: z.string().min(1),
  artifact_type: z.enum(TASK_KINDS),
  filename: z.string().min(1),
  content: z.record(z.string(), z.unknown()),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
