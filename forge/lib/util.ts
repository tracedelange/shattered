// Small async helpers for the orchestrator.

/** A sleep that rejects with an AbortError when the signal fires, so stub-mode
 *  delays cancel promptly when the UI hits Stop. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}

/** True when an error is an abort (signal fired) rather than a real failure. */
export const isAbortError = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));

/** Run `fn` over `items` with at most `limit` in flight, preserving result order.
 *  limit = 1 is strictly sequential — one request at a time (the default, so
 *  local/Ollama providers don't get hit with concurrent requests). */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
