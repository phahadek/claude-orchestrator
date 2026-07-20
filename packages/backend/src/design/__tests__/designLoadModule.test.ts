/**
 * Tests for the in-process design-load loader (packages/backend/src/design/designLoad.ts).
 *
 * AC: loadDesignContext returns the design digest shape — the target task,
 * its parsed open questions, the arch-store-selected units resolved against
 * the manifest's context_pages, and code-map grounding read from the
 * loader-seeded cache file (empty when absent).
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
import { insertProject, insertMilestone } from '../../db/queries.js';
import { loadDesignContext } from '../designLoad.js';

const TARGET_BOARD = 'target-board-id';
const PROJECT = 'proj-1';
const MILESTONE = 'm-1';
const TASK_ID = 'task-design-1';
const ARCH_PAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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
    display_order: 1,
  });
});

function titleProp(text: string) {
  return { type: 'title', title: [{ text: { content: text } }] };
}
function selectProp(name: string | null) {
  return { type: 'select', select: name ? { name } : null };
}
function richTextProp(text: string) {
  return {
    type: 'rich_text',
    rich_text: text ? [{ text: { content: text } }] : [],
  };
}

function pageFor(row: {
  id: string;
  name: string;
  type: string;
  status: string;
}) {
  return {
    id: row.id,
    url: `https://notion.so/${row.id}`,
    properties: {
      'Task Name': titleProp(row.name),
      Status: selectProp(row.status),
      Type: selectProp(row.type),
      'Depends On': richTextProp(''),
      Notes: richTextProp(''),
    },
  };
}

function headingBlock(level: 2 | 3, text: string) {
  return {
    id: `h-${text}`,
    type: `heading_${level}`,
    [`heading_${level}`]: { rich_text: [{ text: { content: text } }] },
  };
}
function bulletBlock(text: string) {
  return {
    id: `b-${text}`,
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ text: { content: text } }] },
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

let taskBlocks: unknown[] = [];

beforeEach(() => {
  taskBlocks = [
    headingBlock(2, 'Open questions'),
    bulletBlock('Should we use approach A or B?'),
    bulletBlock('What is the retry policy?'),
    headingBlock(2, 'Notion pages affected'),
    bulletBlock('Technical Architecture *(update — Section X)*'),
    bulletBlock('Unregistered Page *(new)*'),
  ];

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
                name: 'Design the widget',
                type: '📐 Design',
                status: '🗂️ Ready',
              },
            ]
          : [];
      return jsonResponse({
        results: rows.map(pageFor),
        has_more: false,
        next_cursor: null,
      });
    }

    const pageMatch = u.match(/\/pages\/([^/]+)$/);
    if (pageMatch && method === 'GET') {
      const id = pageMatch[1];
      return jsonResponse({
        id,
        url: `https://notion.so/${id}`,
        properties: { 'Task Name': titleProp('Design the widget') },
      });
    }

    const blocksMatch = u.match(/\/blocks\/([^/]+)\/children/);
    if (blocksMatch && method === 'GET') {
      return jsonResponse({
        results: taskBlocks,
        has_more: false,
        next_cursor: null,
      });
    }

    throw new Error(`unmocked fetch ${method} ${u}`);
  }) as unknown as typeof fetch;
});

describe('loadDesignContext', () => {
  it('returns the design digest shape: task, open questions, arch units, code-map grounding', async () => {
    const result = await loadDesignContext(MILESTONE, TASK_ID, {
      repoRoot: '/tmp/design-load-test-nonexistent-repo',
      manifest: {
        context_pages: [{ id: ARCH_PAGE_ID, title: 'Technical Architecture' }],
      },
    });

    expect(result.task).toEqual({
      id: TASK_ID,
      title: 'Design the widget',
      status: '🗂️ Ready',
      type: '📐 Design',
      url: `https://notion.so/${TASK_ID}`,
    });

    expect(result.openQuestions).toEqual({
      items: ['Should we use approach A or B?', 'What is the retry policy?'],
      source: 'explicit_heading',
    });

    expect(result.archUnits).toEqual([
      {
        id: ARCH_PAGE_ID,
        title: 'Technical Architecture',
        raw: 'Technical Architecture *(update — Section X)*',
      },
    ]);
    expect(result.unresolvedPageRefs).toEqual([
      { title: 'Unregistered Page', raw: 'Unregistered Page *(new)*' },
    ]);

    // No code-map.json cache under this repoRoot — grounding is empty.
    expect(result.codeMapGrounding).toEqual({});
  });

  it('throws when the task is not on the milestone board', async () => {
    await expect(
      loadDesignContext(MILESTONE, 'unknown-task', {
        repoRoot: '/tmp/design-load-test-nonexistent-repo',
        manifest: { context_pages: [] },
      }),
    ).rejects.toThrow(/not found/);
  });

  it('throws for an unknown milestone', async () => {
    await expect(
      loadDesignContext('unknown-milestone', TASK_ID, {
        manifest: { context_pages: [] },
      }),
    ).rejects.toThrow(/unknown milestone/);
  });
});
