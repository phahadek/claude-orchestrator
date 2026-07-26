import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory SQLite (tables required by module-level db.prepare() in queries.ts) ──
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../config.js', () => ({
  config: { notionApiKey: 'test-key', port: 3000 },
}));

import { NotionClient } from '../notion/NotionClient.js';
import { NotionTaskBackend } from '../tasks/NotionTaskBackend.js';
import { markdownToBlocks } from '../tasks/bodyRender.js';
import { composeSplitIntents, ORIGINAL_REF } from '../split/splitSession.js';

const TASK_ID = '11111111-1111-1111-1111-111111111111';

function makeNotionPageResponse(id: string) {
  return {
    id,
    url: `https://notion.so/${id}`,
    properties: {
      'Task Name': {
        type: 'title',
        title: [{ text: { content: 'New Task' } }],
      },
      Status: { type: 'select', select: { name: '🔲 Backlog' } },
      Type: { type: 'select', select: { name: '💻 Code' } },
      'Depends On': { type: 'rich_text', rich_text: [] },
      Notes: { type: 'rich_text', rich_text: [] },
    },
  };
}

/** Fetch stub that branches on method + path, mirroring Notion's REST shape. */
function stubNotionFetch(pageId: string) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method as string;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });

    if (method === 'POST' && url.endsWith('/pages')) {
      return {
        ok: true,
        json: async () => makeNotionPageResponse(pageId),
      };
    }
    if (method === 'GET' && url.includes(`/blocks/${pageId}/children`)) {
      return { ok: true, json: async () => ({ results: [], has_more: false, next_cursor: null }) };
    }
    if (method === 'PATCH' && url.includes(`/blocks/${pageId}/children`)) {
      return { ok: true, json: async () => ({}) };
    }
    if (method === 'DELETE') {
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch call: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('NotionTaskBackend.createTask — body at create', () => {
  it('writes the supplied body verbatim in the same create call', async () => {
    const calls = stubNotionFetch(TASK_ID);
    const backend = new NotionTaskBackend(new NotionClient());

    const body = '## Summary\nDo the thing.\n\n## Context\nSome context.';
    const id = await backend.createTask({
      databaseId: 'db-1',
      title: 'New Task',
      body,
    });

    expect(id).toBe(`notion:${TASK_ID}`);

    const patchCall = calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/children'),
    );
    expect(patchCall).toBeDefined();
    expect((patchCall!.body as { children: unknown[] }).children).toEqual(
      markdownToBlocks(body),
    );

    const createCall = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/pages'),
    );
    expect(
      (createCall!.body as { properties: { Status: { select: { name: string } } } })
        .properties.Status.select.name,
    ).toBe('🔲 Backlog');
  });

  it('creates a task with empty content when no body is supplied (no regression)', async () => {
    const calls = stubNotionFetch(TASK_ID);
    const backend = new NotionTaskBackend(new NotionClient());

    const id = await backend.createTask({
      databaseId: 'db-1',
      title: 'New Task',
    });

    expect(id).toBe(`notion:${TASK_ID}`);
    // No block-write calls at all when body is omitted.
    const blockCalls = calls.filter((c) => c.url.includes('/blocks/'));
    expect(blockCalls).toHaveLength(0);

    const createCall = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/pages'),
    );
    expect(
      (createCall!.body as { properties: { Status: { select: { name: string } } } })
        .properties.Status.select.name,
    ).toBe('🔲 Backlog');
  });
});

describe('composeSplitIntents — sibling body carried through', () => {
  it('carries a sibling task.create payload body unchanged', () => {
    const body = '## Summary\nSibling spec.';
    const result = composeSplitIntents({
      projectId: 'proj-1',
      original: {
        id: 'notion:orig',
        sections: {
          summary: 'Narrowed subset.',
          dependencies: 'None.',
          context: '',
          acceptanceCriteria: '',
          filesAffected: '',
        } as never,
      },
      siblings: [
        {
          ref: 'sibling-1',
          fields: { databaseId: 'db-1', title: 'Sibling task', body },
          dependsOn: [ORIGINAL_REF],
        },
      ],
    });

    const createIntent = result.intents.find((i) => i.kind === 'task.create');
    expect(createIntent).toBeDefined();
    expect((createIntent!.payload as { body?: string }).body).toBe(body);
  });
});

describe('NotionTaskBackend.updateBody — existing-task path unaffected', () => {
  it('still overwrites the page body via the section renderer, unrelated to createTask', async () => {
    const calls = stubNotionFetch(TASK_ID);
    const backend = new NotionTaskBackend(new NotionClient());

    await backend.updateBody(`notion:${TASK_ID}`, {
      summary: 'Updated summary.',
      dependencies: [],
      context: [{ type: 'paragraph', text: 'hello' }],
      automatedCriteria: ['test 1'],
      manualCriteria: ['verify 1'],
    } as never);

    const patchCall = calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/children'),
    );
    expect(patchCall).toBeDefined();
    // updateBody goes through renderTaskBody (section grammar), not the raw
    // markdownToBlocks path createTask's body write uses.
    const getCall = calls.find(
      (c) => c.method === 'GET' && c.url.includes('/children'),
    );
    expect(getCall).toBeDefined();
  });
});
