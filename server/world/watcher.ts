import chokidar, { type FSWatcher } from 'chokidar';

export interface WatchEvent { event: 'add' | 'change' | 'unlink'; path: string }

export function watchWorld(rootDir: string, onChange: (ev: WatchEvent) => void): FSWatcher {
  const watcher = chokidar.watch(rootDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  let pending: ReturnType<typeof setTimeout> | null = null;
  const debounce = (event: WatchEvent['event'], path: string) => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      onChange({ event, path });
    }, 150);
  };

  watcher.on('add',    p => debounce('add', p));
  watcher.on('change', p => debounce('change', p));
  watcher.on('unlink', p => debounce('unlink', p));

  return watcher;
}
