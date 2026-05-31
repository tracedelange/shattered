// Thin wrapper around the `claude` CLI. Shells out to `claude --print` and
// pipes the prompt via stdin so we are not bounded by argv length and avoid
// shell-escaping the (large) world context. Auth is whatever Claude Code is
// already running under — no separate API key.

import { spawn } from 'node:child_process';
import yaml from 'js-yaml';

const CLAUDE_BIN = process.env.PIPELINE_CLAUDE_BIN ?? 'claude';
const MODEL = process.env.PIPELINE_MODEL ?? null;

export interface CallOptions {
  // Conceptually "system" framing. We concatenate these with the user message
  // into a single prompt sent via stdin — `claude --print` reads a flat prompt.
  system: string[];
  user: string;
}

export async function callLlm(opts: CallOptions): Promise<string> {
  const prompt = [
    ...opts.system,
    '',
    '---',
    '',
    opts.user,
  ].join('\n\n');

  const args = ['--print'];
  if (MODEL) args.push('--model', MODEL);

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(
          `claude --print exited ${code}.\nstderr:\n${Buffer.concat(err).toString('utf8')}`,
        ));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8').trim());
    });
    child.stdin.write(prompt);
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
