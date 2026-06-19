// Shared types for the prefab factory's generate → lint → repair loop.
// A prefab is the same shape the engine loads from world/prefabs/*.json:
// an ASCII grid + a legend (char → tile) + optional anchors (char → tag).

import type { ShapeKind } from './shapes.ts';

export interface PrefabBrief {
  /** Display name; the model derives a snake_case id from it. */
  name: string;
  /** Tileset whose tile names the legend may use (e.g. 'dungeon', 'overworld'). */
  tileset: string;
  width: number;
  height: number;
  /** Free-text intent: theme, required anchors, layout notes. */
  notes?: string;
  /** Per-run model override (e.g. 'claude-sonnet-4-6'). Falls back to env. */
  model?: string;
  // ─── Structured fields (set by the architect; optional for hand-typed briefs) ───
  /** Pass-1 base shape primitive: deterministic geometry the LLM never paints. */
  shape?: ShapeKind;
  /** Functional role from the taxonomy (entrance, boss_arena, treasure_vault…). */
  purpose?: string;
  /** Flavor (ruined, flooded, holy, corrupted…). */
  theme?: string;
  /** Anchor tags the prefab must include (descend, loot, boss…). */
  required_anchors?: string[];
}

export type ArchitectEvent =
  | { type: 'architect_start'; count: number; model: string }
  | { type: 'architect_done'; briefs: PrefabBrief[]; savedTo?: string }
  | { type: 'architect_error'; message: string };

export type ArchitectEmit = (e: ArchitectEvent) => void;

export interface PrefabCandidate {
  id: string;
  description?: string;
  data: string;
  legend: Record<string, string>;
  anchors?: Record<string, string>;
}

export interface LintStats {
  rows: number;
  cols: number;
  walkable: number;
  blocked: number;
  /** blocked / (walkable + blocked), 0..1. */
  wallFraction: number;
  /** Count of disconnected walkable regions (1 = fully connected). */
  walkableRegions: number;
  anchors: number;
}

export interface LintResult {
  ok: boolean;
  defects: string[];
  stats: LintStats;
}

export type PrefabEvent =
  | { type: 'prefab_start'; brief: PrefabBrief; model: string; tileColors: Record<string, string>; maxIterations: number }
  | {
      type: 'prefab_step';
      iteration: number;
      phase: 'generate' | 'repair';
      prompt: string;
      raw: string;
      prefab?: PrefabCandidate;
      lint?: LintResult;
      parseError?: string;
      /** Pass-2 op log: which ops applied / were rejected by the engine. */
      note?: string;
    }
  | { type: 'prefab_done'; iterations: number; ok: boolean; prefab?: PrefabCandidate; lint?: LintResult; savedTo?: string }
  | { type: 'prefab_error'; message: string };

export type PrefabEmit = (e: PrefabEvent) => void;
