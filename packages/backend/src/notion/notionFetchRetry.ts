// Bounded retry: 429 honours a server-supplied Retry-After (seconds), capped,
// falling back to bounded exponential backoff when the header is absent or
// unparseable. 409 (not saved, safe to retry) retries for every method;
// 502/503/504/529 retry only for GET, since a non-GET write may already have
// been applied. MAX_RETRIES is one shared budget so a pathological or
// continuous failure cannot stall or loop a request indefinitely.
const MAX_RETRIES = 3;
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

const TRANSIENT_GET_STATUSES = new Set([502, 503, 504, 529]);

function isRetryable(status: number, init: RequestInit): boolean {
  if (status === 429 || status === 409) return true;
  const method = (init.method ?? 'GET').toUpperCase();
  return method === 'GET' && TRANSIENT_GET_STATUSES.has(status);
}

/**
 * fetch with bounded retry on 429 (Retry-After), 409, and transient GET 5xx.
 * Returns the first non-retryable response, or the last retryable one once
 * retries (or the optional total budget) are exhausted — the caller decides
 * how to surface it. `retryDelayMs` is set for a final 429 only.
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
    if (!isRetryable(response.status, init)) return { response };

    const is429 = response.status === 429;
    const delayMs = Math.min(
      (is429 ? parseRetryAfterMs(response) : null) ??
        BASE_BACKOFF_MS * 2 ** attempt,
      MAX_RETRY_DELAY_MS,
    );
    const overBudget =
      opts.totalBudgetMs !== undefined &&
      now() - start + delayMs > opts.totalBudgetMs;

    if (attempt >= MAX_RETRIES || overBudget) {
      return is429 ? { response, retryDelayMs: delayMs } : { response };
    }

    await sleep(delayMs);
  }
}
