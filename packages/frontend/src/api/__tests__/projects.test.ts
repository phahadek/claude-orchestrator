import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiRequest } from '../projects';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status,
      statusText: String(status),
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    }),
  );
}

describe('apiRequest', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed JSON on 200', async () => {
    mockFetch(200, { ok: true });
    const result = await apiRequest<{ ok: boolean }>('/api/test');
    expect(result).toEqual({ ok: true });
  });

  it('returns undefined on 204', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 204,
        statusText: 'No Content',
        ok: true,
        json: () => Promise.reject(new Error('no body')),
      }),
    );
    const result = await apiRequest<undefined>('/api/test');
    expect(result).toBeUndefined();
  });

  it('dispatches device-unauthorized and throws on 401', async () => {
    mockFetch(401, { error: 'unauthorized', code: 'device_not_enrolled' });
    const dispatched: Event[] = [];
    window.addEventListener('device-unauthorized', (e) => dispatched.push(e));

    await expect(apiRequest('/api/test')).rejects.toThrow('Unauthorized');
    expect(dispatched).toHaveLength(1);

    window.removeEventListener(
      'device-unauthorized',
      dispatched[0] as unknown as EventListener,
    );
  });

  it('does not clear device_token from localStorage on 401', async () => {
    const removeItem = vi.fn();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue('existing-token'),
      setItem: vi.fn(),
      removeItem,
    });
    mockFetch(401, { error: 'unauthorized', code: 'device_not_enrolled' });

    await expect(apiRequest('/api/test')).rejects.toThrow('Unauthorized');
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('dispatches device-bootstrap-loopback-only on 403 bootstrap_loopback_only', async () => {
    mockFetch(403, { error: 'forbidden', code: 'bootstrap_loopback_only' });
    const dispatched: Event[] = [];
    const handler = (e: Event) => dispatched.push(e);
    window.addEventListener('device-bootstrap-loopback-only', handler);

    await expect(apiRequest('/api/test')).rejects.toThrow('forbidden');
    expect(dispatched).toHaveLength(1);

    window.removeEventListener('device-bootstrap-loopback-only', handler);
  });

  it('does NOT dispatch device-bootstrap-loopback-only on unrelated 403', async () => {
    mockFetch(403, { error: 'forbidden', code: 'some_other_code' });
    const dispatched: Event[] = [];
    const handler = (e: Event) => dispatched.push(e);
    window.addEventListener('device-bootstrap-loopback-only', handler);

    await expect(apiRequest('/api/test')).rejects.toThrow();
    expect(dispatched).toHaveLength(0);

    window.removeEventListener('device-bootstrap-loopback-only', handler);
  });

  it('throws with error message from body on non-2xx', async () => {
    mockFetch(500, { error: 'internal server error' });
    await expect(apiRequest('/api/test')).rejects.toThrow(
      'internal server error',
    );
  });

  it('sends Authorization header when token is present', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue('my-token'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await apiRequest('/api/test');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-token',
        }),
      }),
    );
  });

  it('does not send Authorization header when no token', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await apiRequest('/api/test');
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});
