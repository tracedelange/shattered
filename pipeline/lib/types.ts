// Types for the Gardener/Implementer pipeline. Loaded from and written to
// world/pipeline/*.yaml. Kept loose where the LLM's output is free-form.

export type OpportunityType =
  | 'new_zone'
  | 'deepen_zone'
  | 'add_connection'
  | 'faction_presence'
  | 'refactor_zone'
  | 'add_entity'
  | 'add_quest'
  | 'refactor_quest'
  | 'refactor_lore'
  | 'add_tile';

export type OpportunityStatus =
  | 'pending'
  | 'approved'
  | 'implemented'
  | 'blocked'
  | 'superseded';

export interface Opportunity {
  id: string;
  type: OpportunityType;
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

export interface HistoryEntry {
  opportunity_id: string;
  implemented_at: string;
  files_written: string[];
  files_modified: string[];
  notes: string;
  /** Relative paths to PNG renders generated for any zones touched in this run. */
  renders?: string[];
}

export interface HistoryFile {
  entries: HistoryEntry[];
}
