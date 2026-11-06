/**
 * Tests for the in-process docs-load loader (packages/backend/src/docs/docsLoad.ts).
 *
 * AC: loadDocsContext returns the task + its declared Target surface /
 * Source domains, and refuses cleanly (before any Notion call) for a
 * non-Notion-backed project.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { notionApiKey: 'test', notionDatabaseId: 'test', port: 3000 },
}));

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  insertProject,
  insertMilestone,
  updateProject,
} from '../../db/queries.js';
import { loadDocsContext } from '../docsLoad.js';
import { GroomTaskSourceUnsupportedError } from '../../planning/errors.js';

const TARGET_BOARD = 'target-board-id';
const PROJECT = 'proj-1';
const MILESTONE = 'm-1';
const TASK_ID = 'task-docs-1';

beforeEach(() => {
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();

  insertProject({
    id: PROJECT,
    name: 'Project One',
    project_dir: '/tmp/project-one',
    context_url: null,
    github_repo: null,
    task_source: 'notion',
  });
  insertMilestone({
    id: MILESTONE,
    project_id: PROJECT,
    name: 'M1',
    source_id: TARGET_BOARD,
    canonical_short_id: 'M1',
    display_order: 1,
  });
});

function titleProp(text: string) {
  return { type: 'title', title: [{ text: { content: text } }] };
}
function selectProp(name: string | null) {
  return { type: 'select', select: name ? { name } : null };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

beforeEach(() => {
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';

    const boardMatch = u.match(/\/databases\/([^/]+)\/query/);
    if (boardMatch && method === 'POST') {
      const boardId = boardMatch[1];
      const rows =
        boardId === TARGET_BOARD
          ? [
              {
                id: TASK_ID,
                url: `https://notion.so/${TASK_ID}`,
                properties: {
                  'Task Name': titleProp('Document the widget'),
                  Status: selectProp('🗂️ Ready'),
                  Type: selectProp('📝 Docs'),
                },
              },
            ]
          : [];
      return jsonResponse({
        results: rows,
        has_more: false,
        next_cursor: null,
      });
    }

    const blocksMatch = u.match(/\/blocks\/([^/]+)\/children/);
    if (blocksMatch && method === 'GET') {
      return jsonResponse({ results: [], has_more: false, next_cursor: null });
    }

    throw new Error(`unmocked fetch ${method} ${u}`);
  }) as unknown as typeof fetch;
});

describe('loadDocsContext', () => {
  it('refuses with GroomTaskSourceUnsupportedError instead of reaching Notion for a YAML-backed project', async () => {
    updateProject(PROJECT, { task_source: 'yaml' });
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockClear();

    await expect(
      loadDocsContext(MILESTONE, TASK_ID, {
        repoRoot: '/tmp/project-one',
        project: PROJECT,
      }),
    ).rejects.toThrow(GroomTaskSourceUnsupportedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
