/**
 * Yields control back to the event loop so a long-running scan/iteration
 * interleaves with pending HTTP/WS request handling instead of holding the
 * loop for the entire pass.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Run `fn` over `items` with at most `concurrency` calls in flight at once.
 * Results are returned in the same order as `items`.
 * Throws from `fn` propagate and abort remaining work for that slot.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0 || concurrency <= 0) return [];

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
