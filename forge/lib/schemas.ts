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
// zone_enhance adjusts an EXISTING zone (features + atmosphere) — zones are
// pre-defined by the input graph, so the pipeline never creates them.
export const TASK_KINDS = ['mob', 'item', 'quest', 'zone_enhance'] as const;

// Typed objective for a quest task — Tier 3 assembles a valid stage machine from
// this (instead of a cheap model emitting a degenerate, auto-completing chain).
export const TaskObjectiveSchema = z.object({
  kind: z.enum(['kill', 'collect', 'talk']),
  // The id the objective points at: a mob template (kill), item base (collect),
  // or npc (talk). For kill, set it with mobIdFor(zone, archetype_ref).
  target_ref: z.string().optional(),
  count: z.number().int().positive().optional(),
});

export const TaskSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(TASK_KINDS),
  zone: z.string().min(1),
  // Human-readable intent — kept for traceability/UI. Tier 3 no longer parses it;
  // it translates the typed fields below deterministically.
  requirement: z.string().min(1),
  // Legacy aggregate of referenced ids (display/back-compat). Superseded by the
  // typed fields below, which Tier 3 actually reads.
  library_refs: z.array(z.string().min(1)).default([]),

  // ── Typed Tier-2 choices (the deterministic-Tier-3 contract) ──
  // mob: which frozen chassis + faction skin, which abilities, how hard.
  archetype_ref: z.string().optional(),
  faction_ref: z.string().optional(),
  ability_refs: z.array(z.string()).default([]),
  difficulty: z.enum(['trash', 'elite', 'boss']).optional(),
  // zone_enhance: which feature ids to place.
  feature_refs: z.array(z.string()).default([]),
  // quest: who gives it + the typed objective.
  giver_ref: z.string().optional(),
  objective: TaskObjectiveSchema.optional(),
  // item: which slot + family to roll.
  item_spec: z.object({
    slot: z.string(),
    family: z.enum(['weapon', 'armor', 'consumable', 'trinket']),
  }).optional(),
});

export const RegionPlanSchema = z.object({
  region_id: z.string().min(1),
  tasks: z.array(TaskSchema).min(1),
});
export type RegionPlan = z.infer<typeof RegionPlanSchema>;
export type Task = z.infer<typeof TaskSchema>;

// Mob id convention shared by Tier 2 (which references it from a quest objective)
// and Tier 3 (which names the mob) — Tier 3 is stateless per-task, so both sides
// must derive the same id from (zone, archetype) without seeing each other.
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export const mobIdFor = (zone: string, archetypeRef?: string): string => slug(`${zone}_${archetypeRef ?? 'threat'}`);

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
