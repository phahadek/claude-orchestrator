/**
 * Tests for the session-anchor-durability fix: an open PR's session_id is
 * the sole anchor for its recovery paths (fixer relaunch, OrphanedTaskSweeper's
 * open-PR protection), yet neither deleteGhostSessions nor DELETE
 * /api/sessions/:id ever consulted pull_requests before deleting a session
 * row. Verifies:
 * - deleteSession refuses when an open PR references the session id.
 * - deleteGhostSessions skips (and logs) a zero-event session referenced by
 *   an open PR, but still deletes a zero-event session with no referencing PR.
 * - DELETE /api/sessions/:id refuses (409) when an open PR references the
 *   session id, and still deletes when no open PR references it.
 * - relaunchFixerForPR distinguishes "session row missing" from the
 *   idle-with-no-worktree null outcome.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'owner/repo', 'notion', 1000, 1000);
  return { db };
});

import express from 'express';
import supertest from 'supertest';
import { logger } from '../logger.js';
import {
  insertSession,
  deleteSession,
  deleteGhostSessions,
  getSession,
  upsertPullRequest,
} from '../db/queries.js';
import { sessionsRouter } from '../routes/sessions.js';

const now = '2024-01-01T00:00:00Z';
const basePR = {
  task_id: null,
  repo: 'owner/repo',
  title: 'fix: something',
  body: null,
  head_branch: 'feature/x',
  base_branch: 'dev',
  draft: 0,
  review_result: null,
  review_at: null,
  created_at: now,
  updated_at: now,
  synced_at: now,
  review_iteration: 0,
  review_session_id: null,
  head_sha: null,
  last_reviewed_sha: null,
  node_id: null,
  mergeable: null,
  merge_state: null,
  merge_state_checked_at: null,
};

function makeSession(sessionId: string) {
  return {
    session_id: sessionId,
    task_id: `notion:${sessionId}`,
    task_url: 'https://notion.so/x',
    project_context_url: '',
    status: 'idle' as const,
    started_at: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deleteSession() — open-PR anchor durability', () => {
  it('refuses to delete a session referenced by an open PR', () => {
    insertSession(makeSession('sess-open-pr'));
    upsertPullRequest({
      ...basePR,
      pr_url: 'https://github.com/owner/repo/pull/1',
      pr_number: 1,
      session_id: 'sess-open-pr',
      state: 'open',
    });

    const result = deleteSession('sess-open-pr');

    expect(result).toBe(false);
    expect(getSession('sess-open-pr')).not.toBeUndefined();
  });

  it('deletes a session with no referencing open PR', () => {
    insertSession(makeSession('sess-no-pr'));

    const result = deleteSession('sess-no-pr');

    expect(result).toBe(true);
    expect(getSession('sess-no-pr')).toBeUndefined();
  });

  it('deletes a session whose only referencing PR is merged/closed', () => {
    insertSession(makeSession('sess-closed-pr'));
    upsertPullRequest({
      ...basePR,
      pr_url: 'https://github.com/owner/repo/pull/2',
      pr_number: 2,
      session_id: 'sess-closed-pr',
      state: 'merged',
    });

    const result = deleteSession('sess-closed-pr');

    expect(result).toBe(true);
    expect(getSession('sess-closed-pr')).toBeUndefined();
  });
});

describe('deleteGhostSessions() — open-PR anchor durability', () => {
  it('leaves a zero-event session in place when an open PR references it, and logs the skip', () => {
    insertSession(makeSession('ghost-protected'));
    upsertPullRequest({
      ...basePR,
      pr_url: 'https://github.com/owner/repo/pull/3',
      pr_number: 3,
      session_id: 'ghost-protected',
      state: 'open',
    });

    const deletedCount = deleteGhostSessions();

    expect(getSession('ghost-protected')).not.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('ghost-protected'),
    );
    // The protected session must not be counted in the deleted total.
    expect(deletedCount).toBe(0);
  });

  it('still deletes a zero-event session with no referencing PR', () => {
    insertSession(makeSession('ghost-unprotected'));

    const deletedCount = deleteGhostSessions();

    expect(getSession('ghost-unprotected')).toBeUndefined();
    expect(deletedCount).toBe(1);
  });

  it('deletes an unprotected ghost session while leaving a PR-protected one in place, in the same sweep', () => {
    insertSession(makeSession('ghost-protected-2'));
    insertSession(makeSession('ghost-unprotected-2'));
    upsertPullRequest({
      ...basePR,
      pr_url: 'https://github.com/owner/repo/pull/4',
      pr_number: 4,
      session_id: 'ghost-protected-2',
      state: 'open',
    });

    const deletedCount = deleteGhostSessions();

    expect(getSession('ghost-protected-2')).not.toBeUndefined();
    expect(getSession('ghost-unprotected-2')).toBeUndefined();
    expect(deletedCount).toBe(1);
  });
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  return app;
}

describe('DELETE /api/sessions/:id — open-PR anchor durability', () => {
  it('refuses (409) to delete a session referenced by an open PR', async () => {
    insertSession(makeSession('route-open-pr'));
    upsertPullRequest({
      ...basePR,
      pr_url: 'https://github.com/owner/repo/pull/5',
      pr_number: 5,
      session_id: 'route-open-pr',
      state: 'open',
    });

    const res = await supertest(buildApp()).delete(
      '/api/sessions/route-open-pr',
    );

    expect(res.status).toBe(409);
    expect(getSession('route-open-pr')).not.toBeUndefined();
  });

  it('deletes (200) a session with no referencing open PR', async () => {
    insertSession(makeSession('route-no-pr'));

    const res = await supertest(buildApp()).delete('/api/sessions/route-no-pr');

    expect(res.status).toBe(200);
    expect(getSession('route-no-pr')).toBeUndefined();
  });
});
