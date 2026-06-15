// Per-tier model selection, layered on the gardener pipeline's provider/auth
// transport (pipeline/lib/llm.ts). The SAME .env drives auth + provider for both:
//   ANTHROPIC_API_KEY                        Anthropic auth
//   PIPELINE_BASE_URL / PIPELINE_AUTH_TOKEN  custom/local endpoint (Ollama, proxy)
//   PIPELINE_MAX_TOKENS, PIPELINE_EFFORT     transport tuning
//
// The forge only adds per-tier model choice. Resolution order per tier:
//   FORGE_TIER{N}_MODEL  →  PIPELINE_MODEL  →  built-in per-tier default
//
// So: a single-model provider (PIPELINE_MODEL set, e.g. a local Ollama tag)
// drives ALL tiers; on stock Anthropic with nothing set you get Opus/Sonnet/
// Haiku; and FORGE_TIER*_MODEL restores per-tier control on any provider.

export type TierKey = 'tier1' | 'tier2' | 'tier3';

const DEFAULTS: Record<TierKey, string> = {
  tier1: 'claude-opus-4-8',
  tier2: 'claude-sonnet-4-6',
  tier3: 'claude-haiku-4-5',
};

const OVERRIDE_ENV: Record<TierKey, string> = {
  tier1: 'FORGE_TIER1_MODEL',
  tier2: 'FORGE_TIER2_MODEL',
  tier3: 'FORGE_TIER3_MODEL',
};

/** Resolve the model id for a tier from env (read at call time), falling back to
 *  PIPELINE_MODEL (shared with the gardener) then the per-tier default. */
export function tierModel(tier: TierKey): string {
  return process.env[OVERRIDE_ENV[tier]] ?? process.env.PIPELINE_MODEL ?? DEFAULTS[tier];
}
