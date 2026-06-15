// Forge server — serves the kanban UI and streams cascade events over Socket.IO.
// The UI sends 'run'; we execute the orchestrator and forward every event.

import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCascade } from './run.ts';
import { tierModel } from './lib/models.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FORGE_PORT ?? 3006);

const app = express();
app.use(express.static(join(__dirname, 'ui')));

const http = createServer(app);
const io = new Server(http);

io.on('connection', (socket) => {
  let controller: AbortController | null = null;
  socket.on('run', async () => {
    if (controller) return; // one run per socket at a time
    controller = new AbortController();
    try {
      await runCascade((e) => socket.emit('forge', e), controller.signal);
    } catch (err) {
      socket.emit('forge', { type: 'run_error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      controller = null;
    }
  });
  socket.on('stop', () => controller?.abort());
  socket.on('disconnect', () => controller?.abort());
});

http.listen(PORT, () => {
  const live = !!process.env.FORGE_LIVE;
  console.log(`forge: http://localhost:${PORT}  (live mode: ${live ? 'ON' : 'off — stubbed'})`);
  if (live) {
    console.log(`  provider: ${process.env.PIPELINE_BASE_URL ?? 'api.anthropic.com'}`);
    console.log(`  models:   t1=${tierModel('tier1')}  t2=${tierModel('tier2')}  t3=${tierModel('tier3')}`);
  }
});
