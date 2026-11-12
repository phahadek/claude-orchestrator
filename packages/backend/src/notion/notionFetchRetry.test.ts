import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithNotionRetry } from './notionFetchRetry';

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{}', { status, headers });
}

describe('fetchWithNotionRetry', () => {
  const fetchMock = vi.fn();
  const sleep = vi.fn(async () => {});

  beforeEach(() => {
    fetchMock.mockReset();
    sleep.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['GET', 'PATCH'])(
    'retries a 409 then returns 200 (%s)',
    async (method) => {
      fetchMock.mockResolvedValueOnce(res(409)).mockResolvedValueOnce(res(200));
      const { response } = await fetchWithNotionRetry(
        'u',
        { method },
        { sleep },
      );
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    },
  );

  it('retries 503 on GET and when method is absent', async () => {
    fetchMock.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    const { response } = await fetchWithNotionRetry('u', {}, { sleep });
    expect(response.status).toBe(200);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each(['PATCH', 'POST'])(
    'returns 503 on %s immediately',
    async (method) => {
      fetchMock.mockResolvedValueOnce(res(503));
      const { response } = await fetchWithNotionRetry(
        'u',
        { method },
        { sleep },
      );
      expect(response.status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it('retries 529 on GET', async () => {
    fetchMock.mockResolvedValueOnce(res(529)).mockResolvedValueOnce(res(200));
    const { response } = await fetchWithNotionRetry(
      'u',
      { method: 'GET' },
      { sleep },
    );
    expect(response.status).toBe(200);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('stops a persistent 409 after MAX_RETRIES and returns the last 409', async () => {
    fetchMock.mockImplementation(async () => res(409));
    const result = await fetchWithNotionRetry(
      'u',
      { method: 'PATCH' },
      { sleep },
    );
    expect(result.response.status).toBe(409);
    expect(result.retryDelayMs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      500, 1000, 2000,
    ]);
  });

  it('honours 429 Retry-After and reports retryDelayMs when giving up', async () => {
    fetchMock.mockImplementation(async () => res(429, { 'Retry-After': '2' }));
    const result = await fetchWithNotionRetry(
      'u',
      { method: 'GET' },
      { sleep },
    );
    expect(result.response.status).toBe(429);
    expect(result.retryDelayMs).toBe(2000);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('caps Retry-After and respects totalBudgetMs', async () => {
    fetchMock.mockImplementation(async () =>
      res(429, { 'Retry-After': '120' }),
    );
    const result = await fetchWithNotionRetry(
      'u',
      { method: 'GET' },
      { sleep, totalBudgetMs: 10_000, now: () => 0 },
    );
    expect(result.response.status).toBe(429);
    expect(result.retryDelayMs).toBe(30_000);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404])('returns %i immediately', async (status) => {
    fetchMock.mockResolvedValueOnce(res(status));
    const { response } = await fetchWithNotionRetry(
      'u',
      { method: 'GET' },
      { sleep },
    );
    expect(response.status).toBe(status);
    expect(sleep).not.toHaveBeenCalled();
  });
});
