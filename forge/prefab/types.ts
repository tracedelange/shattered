// Shared types for the prefab factory's generate → lint → repair loop.
// A prefab is the same shape the engine loads from world/prefabs/*.json:
// an ASCII grid + a legend (char → tile) + optional anchors (char → tag).

export interface PrefabBrief {
  /** Display name; the model derives a snake_case id from it. */
  name: string;
  /** Tileset whose tile names the legend may use (e.g. 'dungeon', 'overworld'). */
  tileset: string;
  width: number;
  height: number;
  /** Free-text intent: theme, required anchors, layout notes. */
  notes?: string;
}

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
  | { type: 'prefab_start'; brief: PrefabBrief; tileColors: Record<string, string>; maxIterations: number }
  | {
      type: 'prefab_step';
      iteration: number;
      phase: 'generate' | 'repair';
      prompt: string;
      raw: string;
      prefab?: PrefabCandidate;
      lint?: LintResult;
      parseError?: string;
    }
  | { type: 'prefab_done'; iterations: number; ok: boolean; prefab?: PrefabCandidate; lint?: LintResult; savedTo?: string }
  | { type: 'prefab_error'; message: string };

export type PrefabEmit = (e: PrefabEvent) => void;
