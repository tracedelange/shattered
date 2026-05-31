import chokidar from 'chokidar';

export function watchWorld(rootDir, onChange) {
  const watcher = chokidar.watch(rootDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  let pending = null;
  const debounce = (event, path) => {
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
