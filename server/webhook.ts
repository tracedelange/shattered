import { Webhooks, createNodeMiddleware } from '@octokit/webhooks';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PORT = Number(process.env.WEBHOOK_PORT) || 9000;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const BRANCH = process.env.WEBHOOK_BRANCH ?? 'main';

const webhooks = new Webhooks({ secret: SECRET });

webhooks.on('push', ({ payload }) => {
  const branch = (payload.ref ?? '').replace('refs/heads/', '');
  if (branch !== BRANCH) return;

  console.log(`[webhook] push on ${branch} — pulling`);

  try {
    execSync('git pull', { cwd: REPO_ROOT, stdio: 'pipe' });
    console.log('[webhook] git pull succeeded');
  } catch (err) {
    console.error('[webhook] git pull failed:', (err as Error).message);
    return;
  }

  try {
    const pid = Number(readFileSync(join(REPO_ROOT, '.game.pid'), 'utf8').trim());
    process.kill(pid, 'SIGUSR2');
    console.log(`[webhook] sent SIGUSR2 to game server pid=${pid}`);
  } catch (err) {
    console.error('[webhook] could not signal game server:', (err as Error).message);
  }
});

createServer(createNodeMiddleware(webhooks, { path: '/webhook' })).listen(PORT, () => {
  console.log(`[webhook] listening on port ${PORT}`);
});
