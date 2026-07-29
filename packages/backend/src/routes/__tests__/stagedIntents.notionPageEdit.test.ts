/**
 * Tests for the notion.pageEdit staged-intent kind — the Notion
 * source-of-truth-page twin of the task.* board-write kinds. Round-trips
 * staged -> approved -> committed and dispatches through
 * NotionWriteCommands -> NotionClient.applyPageEdit on commit. A stale-base
 * apply (old_str no longer matches) must reject rather than mis-apply, and
 * routes the intent back to needs_revision for re-staging.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockApplyPageEdit } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockApplyPageEdit: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../notion/NotionClient', async () => {
  const actual = await vi.importActual<typeof import('../../notion/NotionClient')>(
    '../../notion/NotionClient',
  );
  return {
    ...actual,
    NotionClient: vi.fn().mockImplementation(() => ({
      applyPageEdit: mockApplyPageEdit,
    })),
  };
});

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter } from '../stagedIntents';
import { NotionPageEditStaleBaseError } from '../../notion/NotionClient';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue({ type: 'notion' });
  mockApplyPageEdit.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('notion.pageEdit', () => {
  it('round-trips staged -> approved -> committed and invokes the notion-write handler on apply', async () => {
    mockApplyPageEdit.mockResolvedValue(undefined);
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'notion.pageEdit',
      projectId: 'proj-a',
      payload: {
        page_id: 'notion:doc-page-1',
        content_updates: [{ old_str: 'old text', new_str: 'new text' }],
      },
    });
    expect(staged.status).toBe(201);
    expect(staged.body.state).toBe('staged');

    const approved = await agent
      .post(`/api/staged-intents/${staged.body.id}/approve`)
      .send({});
    expect(approved.status).toBe(200);
    expect(approved.body.state).toBe('approved');

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);
    expect(mockApplyPageEdit).toHaveBeenCalledWith('notion:doc-page-1', [
      { old_str: 'old text', new_str: 'new text' },
    ]);

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.body.id) as { state: string };
    expect(row.state).toBe('committed');
  });

  it('a stale-base apply (old_str no longer matches) rejects and routes back for re-stage rather than mis-applying', async () => {
    mockApplyPageEdit.mockRejectedValue(
      new NotionPageEditStaleBaseError('notion:doc-page-1', 'old text'),
    );
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'notion.pageEdit',
      projectId: 'proj-a',
      payload: {
        page_id: 'notion:doc-page-1',
        content_updates: [{ old_str: 'old text', new_str: 'new text' }],
      },
    });

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});

    expect(applied.status).toBe(500);
    expect(mockApplyPageEdit).toHaveBeenCalled();

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.body.id) as { state: string };
    // Never committed — routed back to a revisable state instead of mis-applying.
    expect(row.state).not.toBe('committed');
  });
});
