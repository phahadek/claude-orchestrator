import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../config.js', () => ({
  normalizePath: (p: string) => p,
  config: { notionApiKey: 'test-key' },
}));

vi.mock('../db/queries.js', () => ({
  upsertTaskCache: vi.fn(),
  getCacheAge: vi.fn().mockReturnValue(Infinity),
  getTaskCache: vi.fn().mockReturnValue(null),
  updateTaskCacheStatus: vi.fn(),
  getMergeReadyPRs: vi.fn().mockReturnValue([]),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    list: vi.fn().mockReturnValue([]),
    getById: vi.fn().mockReturnValue(null),
    getMilestone: vi.fn().mockReturnValue(null),
  },
}));

// Import after mocks are set up
import { projectsRouter } from '../routes/projects.js';

// ── Test app ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', projectsRouter);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const KNOWN_DB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const KNOWN_PAGE_ID = '11111111-2222-3333-4444-555555555555';
const MISSING_ID = 'ffffffff-0000-1111-2222-333333333333';

function mockFetch(handler: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => Promise.resolve(handler(url))),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/notion/validate-board', () => {
  it('returns 400 when id param is missing', async () => {
    const res = await supertest(buildApp()).get('/api/notion/validate-board');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('id') });
  });

  it('returns 400 when input cannot be parsed as a Notion ID', async () => {
    const res = await supertest(buildApp()).get(
      '/api/notion/validate-board?id=not-a-notion-id',
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it('returns { type: "database", title, id } for a known database ID', async () => {
    mockFetch((url) => {
      if (url.includes(`/databases/${KNOWN_DB_ID}`)) {
        return jsonResponse({
          id: KNOWN_DB_ID,
          object: 'database',
          title: [{ plain_text: 'My Board' }],
        });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });

    const res = await supertest(buildApp()).get(
      `/api/notion/validate-board?id=${KNOWN_DB_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'database', title: 'My Board' });
  });

  it('returns { type: "page" } for a known page ID', async () => {
    mockFetch((url) => {
      if (url.includes(`/databases/${KNOWN_PAGE_ID}`)) {
        return jsonResponse({ message: 'object_not_found' }, 404);
      }
      if (url.includes(`/pages/${KNOWN_PAGE_ID}`)) {
        return jsonResponse({ id: KNOWN_PAGE_ID, object: 'page' });
      }
      if (url.includes(`/blocks/${KNOWN_PAGE_ID}/children`)) {
        return jsonResponse({ results: [] });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });

    const res = await supertest(buildApp()).get(
      `/api/notion/validate-board?id=${KNOWN_PAGE_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: 'page',
      childDatabaseId: null,
      childDatabaseTitle: null,
    });
  });

  it('returns childDatabaseId when page has exactly one embedded database', async () => {
    const childId = 'cccccccc-dddd-eeee-ffff-000000000000';
    mockFetch((url) => {
      if (url.includes(`/databases/${KNOWN_PAGE_ID}`)) {
        return jsonResponse({ message: 'object_not_found' }, 404);
      }
      if (url.includes(`/pages/${KNOWN_PAGE_ID}`)) {
        return jsonResponse({ id: KNOWN_PAGE_ID, object: 'page' });
      }
      if (url.includes(`/blocks/${KNOWN_PAGE_ID}/children`)) {
        return jsonResponse({
          results: [
            {
              id: childId,
              type: 'child_database',
              child_database: { title: 'Tasks' },
            },
          ],
        });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });

    const res = await supertest(buildApp()).get(
      `/api/notion/validate-board?id=${KNOWN_PAGE_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: 'page',
      childDatabaseId: childId,
      childDatabaseTitle: 'Tasks',
    });
  });

  it('returns 400 for a missing ID', async () => {
    mockFetch((url) => {
      if (url.includes(`/databases/${MISSING_ID}`)) {
        return jsonResponse({ message: 'object_not_found' }, 404);
      }
      if (url.includes(`/pages/${MISSING_ID}`)) {
        return jsonResponse({ message: 'object_not_found' }, 404);
      }
      return jsonResponse({ message: 'not found' }, 404);
    });

    const res = await supertest(buildApp()).get(
      `/api/notion/validate-board?id=${MISSING_ID}`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining(MISSING_ID),
    });
  });

  it('accepts a full Notion URL and extracts the ID', async () => {
    const notionUrl = `https://www.notion.so/My-Board-${KNOWN_DB_ID.replace(/-/g, '')}`;
    mockFetch((url) => {
      if (url.includes(`/databases/${KNOWN_DB_ID}`)) {
        return jsonResponse({
          id: KNOWN_DB_ID,
          object: 'database',
          title: [{ plain_text: 'My Board' }],
        });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });

    const res = await supertest(buildApp()).get(
      `/api/notion/validate-board?id=${encodeURIComponent(notionUrl)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'database' });
  });
});
