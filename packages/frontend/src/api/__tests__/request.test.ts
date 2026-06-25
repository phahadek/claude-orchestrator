import { describe, it, expect, vi, afterEach } from 'vitest';
import { request } from '../projects';

function makeFetchResponse(
  status: number,
  body: unknown,
  ok = status >= 200 && status < 300,
) {
  return Promise.resolve({
    ok,
    status,
    statusText: String(status),
    json: async () => body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('request() — 401 handling', () => {
  it('throws and dispatches device-unauthorized on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValue(
          makeFetchResponse(
            401,
            { error: 'unauthorized', code: 'device_not_enrolled' },
            false,
          ),
        ),
    );
    const dispatched: string[] = [];
    vi.spyOn(window, 'dispatchEvent').mockImplementation((e) => {
      dispatched.push((e as CustomEvent).type);
      return true;
    });

    await expect(request('/api/test')).rejects.toThrow();
    expect(dispatched).toContain('device-unauthorized');
  });

  it('does not clear device_token on 401', async () => {
    const store: Record<string, string> = { device_token: 'existing-token' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValue(
          makeFetchResponse(401, { error: 'unauthorized' }, false),
        ),
    );
    vi.spyOn(window, 'dispatchEvent').mockImplementation(() => true);

    await expect(request('/api/test')).rejects.toThrow();
    expect(store['device_token']).toBe('existing-token');
  });

  it('never returns 401 body as data', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValue(
          makeFetchResponse(401, { error: 'unauthorized', find: null }, false),
        ),
    );
    vi.spyOn(window, 'dispatchEvent').mockImplementation(() => true);

    const result = await request('/api/test').catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect(Array.isArray(result)).toBe(false);
  });
});

describe('request() — 403 handling', () => {
  it('dispatches device-loopback-required on 403 bootstrap_loopback_only', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValue(
          makeFetchResponse(
            403,
            { error: 'forbidden', code: 'bootstrap_loopback_only' },
            false,
          ),
        ),
    );
    const dispatched: string[] = [];
    vi.spyOn(window, 'dispatchEvent').mockImplementation((e) => {
      dispatched.push((e as CustomEvent).type);
      return true;
    });

    await expect(request('/api/test')).rejects.toThrow();
    expect(dispatched).toContain('device-loopback-required');
    expect(dispatched).not.toContain('device-unauthorized');
  });

  it('does not dispatch device-loopback-required on other 403s', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValue(makeFetchResponse(403, { error: 'forbidden' }, false)),
    );
    const dispatched: string[] = [];
    vi.spyOn(window, 'dispatchEvent').mockImplementation((e) => {
      dispatched.push((e as CustomEvent).type);
      return true;
    });

    await expect(request('/api/test')).rejects.toThrow();
    expect(dispatched).not.toContain('device-loopback-required');
  });
});

describe('request() — 2xx handling', () => {
  it('returns parsed JSON on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(makeFetchResponse(200, [{ id: 'p1' }])),
    );

    const result = await request<{ id: string }[]>('/api/test');
    expect(result).toEqual([{ id: 'p1' }]);
  });

  it('returns undefined on 204', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockReturnValue(
          Promise.resolve({
            ok: true,
            status: 204,
            statusText: '204',
            json: async () => null,
          }),
        ),
    );

    const result = await request('/api/test');
    expect(result).toBeUndefined();
  });
});
