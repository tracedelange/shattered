// Shared options every tier call receives.
export interface TierOpts {
  /** Live = real LLM calls (per-tier model). Off = derived-from-seed stubs. */
  live: boolean;
  /** Aborts in-flight work when the UI hits Stop. */
  signal?: AbortSignal;
}
