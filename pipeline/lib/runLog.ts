// Tee console output to a timestamped transcript under logs/ (git-ignored) so
// every gardener/implementer run — direct or via the loop driver — leaves an
// inspectable record, including the [llm] usage line and any dry-run output.
//
// Uses appendFileSync per line so the file is flushed even when the process
// exits non-zero (the error paths call process.exit, which won't drain an async
// stream). Low-frequency logging, so the sync cost is irrelevant.

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { REPO_ROOT } from './io.ts';

/** Patch console.log/error to also append to logs/<label>-<timestamp>.log. Returns the path. */
export function initRunLog(label: string): string {
  const dir = join(REPO_ROOT, 'logs');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${label}-${stamp}.log`);

  const tee = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    orig(...args);
    try {
      appendFileSync(path, format(...args) + '\n');
    } catch {
      // Never let logging failures break a run.
    }
  };
  console.log = tee(console.log.bind(console));
  console.error = tee(console.error.bind(console));

  console.error(`[runlog] ${label} → ${path}`);
  return path;
}
