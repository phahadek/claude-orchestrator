/**
 * A depth_review session opens no PR — pull_requests carries only
 * session_id/review_session_id, both scoped to the conformance review — so
 * the PR-merge conclusion path can never resolve a depth-review session and
 * never marks it terminal. DepthReviewService.watchForSessionEnd concludes
 * it directly via markSessionDone once its process exits cleanly.
 *
 * Verifies:
 * - markSessionDone transitions an idle depth_review session to done.
 * - That transition happens independent of any PR outcome (merged or
 *   closed) — a depth_review session carries no PR link at all.
 * - The concluded-session archiver picks it up on its normal sweep once done.
 * - markSessionDone's running->deferred guard (the mechanism the PR-merge
 *   path relies on for review sessions) is unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertSession,
  markSessionDone,
  getSession,
  archiveConcludedSessionsOlderThan,
} from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM pull_requests').run();
});

function seedDepthReviewSession(sessionId: string, status: string): void {
  insertSession({
    session_id: sessionId,
    task_id: `task-${sessionId}`,
    task_url: null,
    project_context_url: null,
    status,
    started_at: 0,
    session_type: 'depth_review',
    task_name: `Depth review of PR #1552`,
  } as never);
}

describe('depth_review session conclusion', () => {
  it('reaches done when markSessionDone is called on a clean-exit (idle) session', () => {
    seedDepthReviewSession('depth-review-1', 'idle');

    markSessionDone('depth-review-1', 1000, null, 'depth_review_service');

    const row = getSession('depth-review-1');
    expect(row?.status).toBe('done');
    expect(row?.ended_at).toBe(1000);
  });

  it('reaches done independent of its PR being closed rather than merged', () => {
    seedDepthReviewSession('depth-review-2', 'idle');
    db.prepare(
      `INSERT INTO pull_requests
         (pr_number, pr_url, repo, state, draft, review_result, review_at,
          created_at, updated_at, synced_at)
       VALUES
         (1552, 'https://github.com/owner/repo/pull/1552', 'owner/repo', 'closed', 0,
          NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();

    markSessionDone('depth-review-2', 2000, null, 'depth_review_service');

    const row = getSession('depth-review-2');
    expect(row?.status).toBe('done');
  });

  it('is subsequently archived by the concluded-session archiver on its normal sweep', () => {
    seedDepthReviewSession('depth-review-3', 'idle');
    markSessionDone('depth-review-3', 3000, null, 'depth_review_service');

    const archivedIds = archiveConcludedSessionsOlderThan(3001);

    expect(archivedIds).toContain('depth-review-3');
    const row = getSession('depth-review-3');
    expect(row?.archived).toBe(1);
  });

  it('a running session is deferred rather than immediately marked done (the PR-merge path relies on this, unchanged)', () => {
    seedDepthReviewSession('review-session-1', 'running');

    markSessionDone('review-session-1', 4000, null, 'pr_merge_watcher');

    const row = getSession('review-session-1');
    expect(row?.status).toBe('running');
  });
});
