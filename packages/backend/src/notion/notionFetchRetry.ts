// Bounded 429 retry: honour a server-supplied Retry-After (seconds), capped,
// falling back to bounded exponential backoff when the header is absent or
// unparseable. MAX_429_RETRIES bounds total attempts so a pathological or
// continuous 429 cannot stall or loop a request indefinitely.
const MAX_429_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const BASE_BACKOFF_MS = 500;

export interface NotionRetryOptions {
  /** Max total time spent sleeping across retries; omitted = unbounded (by retry count only). */
  totalBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface NotionRetryResult {
  response: Response;
  /** Delay the next retry would have used; set only when `response` is a 429 returned after giving up. */
  retryDelayMs?: number;
}

function parseRetryAfterMs(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  if (!header) return null;
  const secs = Number(header);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return secs * 1000;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch with bounded 429/Retry-After retry. Returns the first non-429
 * response, or the last 429 once retries (or the optional total budget) are
 * exhausted — the caller decides how to surface it.
 */
export async function fetchWithNotionRetry(
  url: string,
  init: RequestInit,
  opts: NotionRetryOptions = {},
): Promise<NotionRetryResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const start = now();

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429) return { response };

    const delayMs = Math.min(
      parseRetryAfterMs(response) ?? BASE_BACKOFF_MS * 2 ** attempt,
      MAX_RETRY_DELAY_MS,
    );
    const overBudget =
      opts.totalBudgetMs !== undefined &&
      now() - start + delayMs > opts.totalBudgetMs;

    if (attempt >= MAX_429_RETRIES || overBudget) {
      return { response, retryDelayMs: delayMs };
    }

    await sleep(delayMs);
  }
}
