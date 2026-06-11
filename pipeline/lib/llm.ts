// LLM transport layer — direct Anthropic Messages API.
//
// Both pipelines are single-shot generators: system context blocks + one user
// turn → one fenced-YAML response. No tools, no agent loop, no subprocess.
// (The Agent SDK transport this replaced spawned a Claude Code process per
// call; with the agentic loop gone in Implementor v2, that was pure overhead.)
//
// Prompt caching: the system blocks are ordered stable-first (system prompt,
// then world context, then per-run state) and the last block carries a
// cache_control breakpoint, so repair calls and same-neighborhood loop
// iterations within the TTL read the whole prefix from cache.
//
// Environment:
//   ANTHROPIC_API_KEY    auth (required unless PIPELINE_BASE_URL is set).
//   PIPELINE_MODEL       pin a model (Anthropic id, or the Ollama tag when
//                        using a local endpoint, e.g. "qwen3:14b").
//   PIPELINE_MAX_TOKENS  per-response output cap (default 32000).
//   PIPELINE_BASE_URL    point at an Anthropic-compatible endpoint (Ollama
//                        speaks the Messages API natively — set
//                        http://localhost:11434 to run fully local).
//   PIPELINE_AUTH_TOKEN  bearer token for a custom endpoint (default
//                        "ollama"; local servers require one but ignore it).
//   PIPELINE_EFFORT      override reasoning effort for every call.
//   PIPELINE_THINKING    disabled | adaptive (default adaptive).

import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import yaml from 'js-yaml';

const BASE_URL   = process.env.PIPELINE_BASE_URL ?? undefined;
const MODEL      = process.env.PIPELINE_MODEL ?? 'claude-sonnet-4-6';
const MAX_TOKENS = Number(process.env.PIPELINE_MAX_TOKENS ?? 32000);

type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
// Reasoning depth. Default is low (cheap/fast); pipelines raise it per-call
// (implementer → medium). PIPELINE_EFFORT overrides everything for experiments.
const EFFORT_OVERRIDE = process.env.PIPELINE_EFFORT as EffortLevel | undefined;
// PIPELINE_THINKING = disabled | adaptive. Adaptive (default) lets the model
// decide when structural reasoning is worth it.
const THINKING = process.env.PIPELINE_THINKING ?? 'adaptive';

// Rough $/MTok for the usage log line (input, output, cache read, cache write).
// Unknown models (local endpoints) log $0.
const PRICING: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5':  { in: 1, out: 5,  cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-4-8':   { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/**
 * Process exit code pipelines use to signal "stopped on a usage/rate limit".
 * The loop driver keys on this to stop cleanly rather than treat it as a crash.
 */
export const USAGE_LIMIT_EXIT_CODE = 2;

/** Thrown when the model run stops because usage/rate limits were hit. */
export class UsageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageLimitError';
  }
}

export interface CallOptions {
  /** Tag used in log output to distinguish calls. */
  label?: string;
  /** System framing blocks, stable-first. The last block gets the cache breakpoint. */
  system: string[];
  /** The user turn. */
  user: string;
  /** Reasoning depth for this call. Defaults to 'low'; PIPELINE_EFFORT overrides. */
  effort?: EffortLevel;
  /** PNG file paths attached to the user turn as images (gardener --audit). */
  images?: string[];
  /**
   * No-op. The Agent SDK transport this replaced ran an agentic loop; callers
   * still pass this to mean "single-shot, no tools", which is now always true
   * for the Messages transport. Accepted and ignored for caller compatibility.
   */
  disableTools?: boolean;
}

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;

  if (BASE_URL) {
    _client = new Anthropic({
      baseURL: BASE_URL,
      authToken: process.env.PIPELINE_AUTH_TOKEN ?? 'ollama',
    });
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        '[llm] ANTHROPIC_API_KEY is not set. The pipeline calls the Anthropic API ' +
        'directly — export a key (e.g. via .env) or set PIPELINE_BASE_URL for a ' +
        'local endpoint.',
      );
    }
    _client = new Anthropic();
  }
  return _client;
}

export async function callLlm(opts: CallOptions): Promise<string> {
  const tag = opts.label ? `llm:${opts.label}` : 'llm';
  const client = getClient();

  // Stable-first system blocks; breakpoint on the last one caches the full
  // prefix for repair calls and same-context loop iterations within the TTL.
  const system: Anthropic.TextBlockParam[] = opts.system.map((text, i) => ({
    type: 'text',
    text,
    ...(i === opts.system.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));

  const userContent: Anthropic.ContentBlockParam[] = [
    ...(opts.images ?? []).map((path): Anthropic.ImageBlockParam => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: readFileSync(path).toString('base64'),
      },
    })),
    { type: 'text', text: opts.user },
  ];

  const started = Date.now();
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: userContent }],
      ...(THINKING === 'disabled' ? { thinking: { type: 'disabled' as const } } : { thinking: { type: 'adaptive' as const } }),
      output_config: { effort: EFFORT_OVERRIDE ?? opts.effort ?? 'low' },
    });
    const message = await stream.finalMessage();

    const u = message.usage;
    const p = PRICING[MODEL];
    const cost = p
      ? (u.input_tokens * p.in +
         u.output_tokens * p.out +
         (u.cache_read_input_tokens ?? 0) * p.cacheRead +
         (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6
      : 0;
    console.error(
      `[${tag}] usage: in=${u.input_tokens} out=${u.output_tokens} ` +
      `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} ` +
      `cost=$${cost.toFixed(4)} ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );

    if (message.stop_reason === 'refusal') {
      throw new Error(`[${tag}] model refused the request.`);
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error(
        `[${tag}] response truncated at ${MAX_TOKENS} output tokens — ` +
        'raise PIPELINE_MAX_TOKENS or shrink the request.',
      );
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) {
      throw new Error(`[${tag}] model returned no text content (stop_reason=${message.stop_reason}).`);
    }
    return text.trim();
  } catch (err) {
    // The SDK already retried 429/5xx with backoff (default max_retries=2).
    // What still escapes is terminal for this run: map limit/overload signals
    // to UsageLimitError so the loop driver stops cleanly.
    if (err instanceof Anthropic.RateLimitError) {
      throw new UsageLimitError(`LLM rate limit reached. ${err.message}`);
    }
    if (err instanceof Anthropic.APIError && err.status === 529) {
      throw new UsageLimitError(`LLM service overloaded. ${err.message}`);
    }
    throw err;
  }
}

// LLMs sometimes wrap YAML in ```yaml fences. Strip them if present.
export function extractYaml(raw: string): string {
  const fence = raw.match(/```(?:yaml)?\s*\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return raw.trim();
}

export function parseYaml<T>(raw: string): T {
  return yaml.load(extractYaml(raw)) as T;
}
