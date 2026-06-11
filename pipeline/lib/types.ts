// Types for the Gardener/Implementer pipeline. Loaded from and written to
// world/pipeline/*.yaml. Kept loose where the LLM's output is free-form.

// Canonical list lives in schemas.ts (OPPORTUNITY_TYPES); re-exported here so
// existing imports keep working.
export type { OpportunityType } from './schemas.ts';

export type OpportunityStatus =
  | 'pending'
  | 'approved'
  | 'implemented'
  | 'blocked'
  | 'superseded';

export interface Opportunity {
  id: string;
  type: string;
  priority: number;
  status: OpportunityStatus;
  rationale: string;
  // Free-form per-type fields. The Gardener writes them; the Implementer reads
  // them. We intentionally do not pin a schema per type at this stage.
  [extra: string]: unknown;
}

export interface OpportunitiesFile {
  generated_at: string | null;
  world_summary: string;
  opportunities: Opportunity[];
}

export interface RenderStat {
  zone: string;
  inaccessible_tiles: number;
  /** Non-zero when a walkable default_tile is reachable — dungeon-carving bug. */
  accessible_default_tiles: number;
  accessible_default_tile_name: string;
}

export interface HistoryEntry {
  opportunity_id: string;
  /** Opportunity type — feeds the Gardener's anti-repetition digest. */
  type?: string;
  /** Primary zone the opportunity targeted, when one was named. */
  target_zone?: string;
  implemented_at: string;
  files_written: string[];
  files_modified: string[];
  notes: string;
  /** Relative paths to PNG renders generated for any zones touched in this run. */
  renders?: string[];
  /** Accessibility stats from the post-write render pass. Non-empty when any
   *  zone had inaccessible tiles or an accessible-background issue. */
  render_stats?: RenderStat[];
}

export interface HistoryFile {
  entries: HistoryEntry[];
}
