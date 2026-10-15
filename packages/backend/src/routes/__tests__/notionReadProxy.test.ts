import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});
vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    config: { ...actual.config, notionApiKey: 'ntn_real_key' },
  };
});

import { createNotionReadProxyRouter } from '../notionReadProxy';
import {
  mintStageCredential,
  _resetStageCredentialsForTesting,
} from '../../auth/SessionStageAuth';

function jsonRes(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function buildApp(opts?: Parameters<typeof createNotionReadProxyRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/api', createNotionReadProxyRouter(opts));
  return app;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetStageCredentialsForTesting();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Notion read proxy', () => {
  it('retries a 429 with Retry-After and returns the eventual 2xx, substituting the real key', async () => {
    const token = mintStageCredential('s1');
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(429, { code: 'rate_limited' }, { 'Retry-After': '1' }),
      )
      .mockResolvedValueOnce(jsonRes(200, { results: [] }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const res = await supertest(buildApp({ sleep }))
      .post('/api/notion-proxy/v1/search')
      .set('Authorization', `Bearer ${token}`)
      .set('Notion-Version', '2025-09-03')
      .send({ query: 'x' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.notion.com/v1/search');
    expect(init.headers.Authorization).toBe('Bearer ntn_real_key');
    expect(init.headers['Notion-Version']).toBe('2025-09-03');
  });

  it('returns the upstream 429 with Retry-After after retry exhaustion', async () => {
    const token = mintStageCredential('s1');
    fetchMock.mockImplementation(async () =>
      jsonRes(429, { code: 'rate_limited' }, { 'Retry-After': '2' }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    const res = await supertest(buildApp({ sleep }))
      .get('/api/notion-proxy/v1/pages/abc')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('2');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('never holds past the 45s budget: returns the 429 immediately when the next sleep would cross it', async () => {
    const token = mintStageCredential('s1');
    fetchMock.mockImplementation(async () =>
      jsonRes(429, { code: 'rate_limited' }, { 'Retry-After': '20' }),
    );
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });

    const res = await supertest(buildApp({ sleep, now: () => clock }))
      .get('/api/notion-proxy/v1/pages/abc')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('20');
    // 20s + 20s slept; a third 20s sleep would reach 60s > 45s.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(clock).toBeLessThanOrEqual(45_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['POST', '/api/notion-proxy/v1/pages'],
    ['PATCH', '/api/notion-proxy/v1/pages/abc'],
    ['DELETE', '/api/notion-proxy/v1/blocks/abc'],
    ['GET', '/api/notion-proxy/v1/oauth/token'],
    ['POST', '/api/notion-proxy/v1/comments'],
    ['POST', '/api/notion-proxy/v1/blocks/abc/children'],
  ])('rejects %s %s', async (method, path) => {
    const token = mintStageCredential('s1');
    const res = await supertest(buildApp())
      [method.toLowerCase() as 'get'](path)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admits data-source query POSTs', async () => {
    const token = mintStageCredential('s1');
    fetchMock.mockResolvedValueOnce(jsonRes(200, { results: [] }));
    const res = await supertest(buildApp())
      .post('/api/notion-proxy/v1/data_sources/abc/query')
      .set('Authorization', `Bearer ${token}`)
      .send({ page_size: 1 });
    expect(res.status).toBe(200);
  });

  it('rejects a missing or invalid session credential', async () => {
    const missing = await supertest(buildApp()).get(
      '/api/notion-proxy/v1/users/me',
    );
    expect(missing.status).toBe(401);
    const invalid = await supertest(buildApp())
      .get('/api/notion-proxy/v1/users/me')
      .set('Authorization', 'Bearer nope');
    expect(invalid.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
