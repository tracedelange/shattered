// LLM transport layer — Claude Agent SDK.
//
// Both pipelines (gardener, implementer) drive an agentic loop: the model
// writes zone YAML to disk, runs `npm run render-zone` via shell, reads the
// resulting PNG inline, iterates, then emits a final fenced-YAML response.
// That requires real tool access (Bash/Read/Write/Edit), so we use the Claude
// Agent SDK's `query()` rather than the raw Messages API.
//
// Auth piggybacks the local Claude Code session the same way `claude --print`
// did (falling back to ANTHROPIC_API_KEY) — no key required when a session is
// active.
//
// Environment:
//   PIPELINE_MODEL       pin a model (Anthropic id, or the Ollama tag when
//                        using a local endpoint, e.g. "qwen3:14b").
//   PIPELINE_MAX_TURNS   bound the agent loop (default 100).
//   PIPELINE_BASE_URL    point at a custom Anthropic-compatible endpoint
//                        instead of Anthropic. Ollama speaks the Messages API
//                        natively — set http://localhost:11434 to run fully
//                        local. When set, auth + small-model + offline flags
//                        are wired automatically (see buildEnv).
//   PIPELINE_AUTH_TOKEN  token sent to the endpoint (default "ollama";
//                        local servers require it but ignore the value).
//   PIPELINE_SMALL_MODEL background "small/fast" model (default PIPELINE_MODEL)
//                        — so Claude Code's housekeeping calls also hit the
//                        local server instead of a hosted Haiku.

import { query } from '@anthropic-ai/claude-agent-sdk';
import yaml from 'js-yaml';
import { REPO_ROOT } from './io.ts';

const MODEL     = process.env.PIPELINE_MODEL ?? undefined;
const MAX_TURNS = Number(process.env.PIPELINE_MAX_TURNS ?? 100);
const BASE_URL  = process.env.PIPELINE_BASE_URL ?? undefined;

// Tools the agentic prompts rely on. Read renders PNGs inline; Bash runs the
// zone renderer; Write/Edit author the YAML files the model verifies.
const ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

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
  /** System framing blocks, passed through as the SDK system prompt. */
  system: string[];
  /** The user turn that kicks off the agent. */
  user: string;
}

// Build the env passed to the spawned Claude Code process when targeting a
// custom endpoint. We MUST spread process.env first so the child keeps PATH and
// friends (the Bash tool needs them), then layer the endpoint overrides on top.
function buildEnv(baseUrl: string): Record<string, string | undefined> {
  const smallModel = process.env.PIPELINE_SMALL_MODEL ?? MODEL;
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    // Required even though local servers (Ollama) ignore the value.
    ANTHROPIC_AUTH_TOKEN: process.env.PIPELINE_AUTH_TOKEN ?? 'ollama',
    // Route the background small/fast model at the same endpoint, else Claude
    // Code reaches for a hosted Haiku the local server doesn't serve.
    ...(smallModel ? { ANTHROPIC_SMALL_FAST_MODEL: smallModel } : {}),
    // Running local/offline — don't let the spawned binary phone home.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

export async function callLlm(opts: CallOptions): Promise<string> {
  let rateLimited = false;

  const response = query({
    prompt: opts.user,
    options: {
      systemPrompt: opts.system,
      allowedTools: ALLOWED_TOOLS,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: REPO_ROOT,
      maxTurns: MAX_TURNS,
      ...(MODEL ? { model: MODEL } : {}),
      ...(BASE_URL ? { env: buildEnv(BASE_URL) } : {}),
    },
  });

  for await (const message of response) {
    // Subscription rate-limit signal — remember it so we can classify a
    // subsequent error result as a usage limit rather than a generic failure.
    if (message.type === 'rate_limit_event') {
      if (message.rate_limit_info.status === 'rejected') rateLimited = true;
      continue;
    }

    if (message.type !== 'result') continue;

    if (message.subtype === 'success') {
      return message.result.trim();
    }

    // Any non-success result is terminal. Classify usage/limit exhaustion so
    // the loop driver can stop cleanly instead of treating it as a crash.
    const detail = message.errors?.join('\n') ?? '';
    if (
      rateLimited ||
      message.subtype === 'error_max_budget_usd' ||
      isUsageLimitText(detail)
    ) {
      throw new UsageLimitError(`LLM usage limit reached (${message.subtype}). ${detail}`.trim());
    }
    throw new Error(`LLM run failed (${message.subtype}). ${detail}`.trim());
  }

  // Generator ended without a result message — treat as a usage limit if we
  // saw a rejection, otherwise a generic failure.
  if (rateLimited) throw new UsageLimitError('LLM usage limit reached (stream ended after rate-limit rejection).');
  throw new Error('LLM run ended without a result message.');
}

// Phrases the underlying provider may surface in an error result when usage is
// exhausted. Kept narrow on purpose — the structured signals above are primary.
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /rate limit/i,
  /quota exceeded/i,
  /5[- ]?hour limit/i,
  /please try again (later|in)/i,
];

function isUsageLimitText(text: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(text));
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
