// LLM transport layer. Two backends are supported:
//
//   claude  (default) — shells out to `claude --print` via stdin.
//                       Auth piggybacks whatever Claude Code session is active.
//                       No API key required.
//
//   opencode          — shells out to `opencode run "<prompt>"`.
//                       Auth piggybacks whatever provider OpenCode is configured
//                       with (Anthropic, Gemini, GitHub Copilot/Zen, etc.).
//                       Model-agnostic: use PIPELINE_MODEL=provider/model.
//                       Enable with --opencode flag in gardener/implementer/loop.
//
// Both backends capture stdout as the model response. The entire prompt
// (system blocks + user message) is concatenated into a single flat string —
// a consequence of CLI-based invocation. If proper system/user separation
// becomes important, migrate to the opencode HTTP server API instead.

import { spawn } from 'node:child_process';
import yaml from 'js-yaml';

const CLAUDE_BIN    = process.env.PIPELINE_CLAUDE_BIN    ?? 'claude';
const OPENCODE_BIN  = process.env.PIPELINE_OPENCODE_BIN  ?? 'opencode';
const MODEL         = process.env.PIPELINE_MODEL          ?? null;

export interface CallOptions {
  // Conceptually "system" framing — concatenated with the user message into
  // a single flat prompt because CLI backends don't have a system message API.
  system: string[];
  user: string;
  /** When true, use `opencode run` instead of `claude --print`. */
  useOpenCode?: boolean;
}

export async function callLlm(opts: CallOptions): Promise<string> {
  return opts.useOpenCode ? callOpenCode(opts) : callClaudeCode(opts);
}

// ---------------------------------------------------------------------------
// Backend: claude --print (default)
// ---------------------------------------------------------------------------

function callClaudeCode(opts: CallOptions): Promise<string> {
  const prompt = buildFlatPrompt(opts);

  const args = ['--print'];
  if (MODEL) args.push('--model', MODEL);

  return spawnAndCapture(CLAUDE_BIN, args, { stdin: prompt });
}

// ---------------------------------------------------------------------------
// Backend: opencode run
// ---------------------------------------------------------------------------
// The entire prompt is passed as a single positional argument. opencode run
// takes [message..] as args and has no stdin prompt path, so we pass the
// concatenated system+user text directly.
//
// Note on prompt size: opencode run passes the message as a process argument.
// macOS limits args to ~2 MB. For most world states this is fine; if the
// world bundle grows large, consider the opencode HTTP server API instead
// (opencode serve + POST /session/:id/message), which has no size constraint.

function callOpenCode(opts: CallOptions): Promise<string> {
  const prompt = buildFlatPrompt(opts);

  const args = ['run'];
  if (MODEL) args.push('--model', MODEL);
  // Pass the full prompt as a single positional argument.
  args.push(prompt);

  return spawnAndCapture(OPENCODE_BIN, args, { stdin: null });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildFlatPrompt(opts: CallOptions): string {
  return [
    ...opts.system,
    '',
    '---',
    '',
    opts.user,
  ].join('\n\n');
}

interface SpawnOpts {
  /** Write this string to stdin then close it. Pass null to skip stdin. */
  stdin: string | null;
}

function spawnAndCapture(
  bin: string,
  args: string[],
  opts: SpawnOpts,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(
          `${bin} exited ${code}.\nstderr:\n${Buffer.concat(err).toString('utf8')}`,
        ));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8').trim());
    });
    if (opts.stdin !== null) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
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
