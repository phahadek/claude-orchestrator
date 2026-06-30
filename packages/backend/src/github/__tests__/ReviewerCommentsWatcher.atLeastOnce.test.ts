import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory SQLite DB ───────────────────────────────────────────────────────

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  return { db };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn().mockReturnValue({ id: 'proj-1' }),
}));
vi.mock('../../config/settings', () => ({
  typedGetSetting: vi.fn().mockReturnValue([]),
}));
vi.mock('../pollUtils', () => ({
  isTerminalStalePR: vi.fn().mockReturnValue(false),
}));
vi.mock('../reviewUtils', () => ({
  formatHumanReviewFeedback: vi
    .fn()
    .mockImplementation(
      (_prNum: number, comments: unknown[]) =>
        `feedback(${comments.length} comments)`,
    ),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  getRoutedCommentIds,
  markCommentsPending,
  ackPendingComments,
} from '../../db/queries.js';
import { ReviewerCommentsWatcher } from '../ReviewerCommentsWatcher.js';
import { db } from '../../db/db.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function seedSession(sessionId: string, status: string = 'running'): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, status, started_at) VALUES (?, ?, ?)`,
  ).run(sessionId, status, Date.now());
}

function seedPR(prNumber: number, repo: string, sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO pull_requests
       (pr_number, pr_url, repo, session_id, state, draft, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, 'open', 0, '2024-01-01', '2024-01-01', '2024-01-01')`,
  ).run(
    prNumber,
    `https://github.com/${repo}/pull/${prNumber}`,
    repo,
    sessionId,
  );
}

function pendingIds(prNumber: number, repo: string): string[] {
  return (
    db
      .prepare<{
        pr_number: number;
        repo: string;
      }>(
        `SELECT comment_id FROM pr_review_comments_routed WHERE pr_number = @pr_number AND repo = @repo AND routed_state = 'pending'`,
      )
      .all({ pr_number: prNumber, repo }) as { comment_id: string }[]
  ).map((r) => r.comment_id);
}

function ackedIds(prNumber: number, repo: string): string[] {
  return (
    db
      .prepare<{
        pr_number: number;
        repo: string;
      }>(
        `SELECT comment_id FROM pr_review_comments_routed WHERE pr_number = @pr_number AND repo = @repo AND routed_state = 'acked'`,
      )
      .all({ pr_number: prNumber, repo }) as { comment_id: string }[]
  ).map((r) => r.comment_id);
}

const REPO = 'owner/repo';
const SESSION_ID = 'session-aabbccdd';
const PR_NUMBER = 42;

beforeEach(() => {
  db.prepare(`DELETE FROM pr_review_comments_routed`).run();
  db.prepare(`DELETE FROM pull_requests`).run();
  db.prepare(`DELETE FROM sessions`).run();
  seedSession(SESSION_ID, 'idle');
  seedPR(PR_NUMBER, REPO, SESSION_ID);
});

// ── Tests for DB helpers ───────────────────────────────────────────────────────

describe('markCommentsPending / getRoutedCommentIds / ackPendingComments', () => {
  it('getRoutedCommentIds returns only acked IDs (not pending)', () => {
    markCommentsPending(PR_NUMBER, REPO, ['ic_1', 'ic_2']);
    const acked = getRoutedCommentIds(PR_NUMBER, REPO);
    expect(acked.size).toBe(0); // pending, not acked yet
  });

  it('ackPendingComments flips pending → acked', () => {
    markCommentsPending(PR_NUMBER, REPO, ['ic_1', 'ic_2']);
    ackPendingComments(PR_NUMBER, REPO);
    const acked = getRoutedCommentIds(PR_NUMBER, REPO);
    expect(acked.has('ic_1')).toBe(true);
    expect(acked.has('ic_2')).toBe(true);
    expect(pendingIds(PR_NUMBER, REPO)).toHaveLength(0);
  });

  it('markCommentsPending INSERT OR IGNORE never flips acked back to pending', () => {
    markCommentsPending(PR_NUMBER, REPO, ['ic_1']);
    ackPendingComments(PR_NUMBER, REPO);
    // Re-call markCommentsPending — should not change acked row
    markCommentsPending(PR_NUMBER, REPO, ['ic_1']);
    expect(ackedIds(PR_NUMBER, REPO)).toContain('ic_1');
    expect(pendingIds(PR_NUMBER, REPO)).toHaveLength(0);
  });
});

// ── Integration tests for at-least-once delivery ──────────────────────────────

function makeGitHubClient(commentId: string) {
  return {
    listPRReviews: vi.fn().mockResolvedValue([]),
    listPRReviewComments: vi.fn().mockResolvedValue([]),
    listPRIssueComments: vi.fn().mockResolvedValue([
      {
        id: commentId,
        author: 'human',
        authorType: 'User',
        body: 'please fix',
      },
    ]),
  };
}

function makeSessionManager() {
  return { sendOrResume: vi.fn().mockResolvedValue(undefined) };
}

describe('ReviewerCommentsWatcher at-least-once delivery', () => {
  it('comment delivered, session dies before turn completes → re-delivered on next poll', async () => {
    const COMMENT_ID = '101';
    const github = makeGitHubClient(COMMENT_ID) as any;
    const sessions = makeSessionManager() as any;
    const watcher = new ReviewerCommentsWatcher(github, sessions);

    // First poll: delivers the comment
    await (watcher as any).pollPR(
      db
        .prepare(`SELECT * FROM pull_requests WHERE pr_number = ? AND repo = ?`)
        .get(PR_NUMBER, REPO),
    );
    expect(sessions.sendOrResume).toHaveBeenCalledTimes(1);
    expect(pendingIds(PR_NUMBER, REPO)).toContain(`ic_${COMMENT_ID}`);
    expect(ackedIds(PR_NUMBER, REPO)).toHaveLength(0);

    // Simulate session death — no ack fires; comment stays pending

    // Second poll: re-delivers because comment is still pending (not in acked set)
    sessions.sendOrResume.mockClear();
    await (watcher as any).pollPR(
      db
        .prepare(`SELECT * FROM pull_requests WHERE pr_number = ? AND repo = ?`)
        .get(PR_NUMBER, REPO),
    );
    expect(sessions.sendOrResume).toHaveBeenCalledTimes(1);
  });

  it('comment delivered, turn completes → acked and not re-delivered on next poll', async () => {
    const COMMENT_ID = '102';
    const github = makeGitHubClient(COMMENT_ID) as any;
    const sessions = makeSessionManager() as any;
    const watcher = new ReviewerCommentsWatcher(github, sessions);

    // First poll: delivers the comment
    await (watcher as any).pollPR(
      db
        .prepare(`SELECT * FROM pull_requests WHERE pr_number = ? AND repo = ?`)
        .get(PR_NUMBER, REPO),
    );
    expect(sessions.sendOrResume).toHaveBeenCalledTimes(1);

    // Simulate successful turn completion (ack)
    ackPendingComments(PR_NUMBER, REPO);
    expect(ackedIds(PR_NUMBER, REPO)).toContain(`ic_${COMMENT_ID}`);

    // Second poll: comment is acked → not re-delivered
    sessions.sendOrResume.mockClear();
    await (watcher as any).pollPR(
      db
        .prepare(`SELECT * FROM pull_requests WHERE pr_number = ? AND repo = ?`)
        .get(PR_NUMBER, REPO),
    );
    expect(sessions.sendOrResume).not.toHaveBeenCalled();
  });

  it('already-acked comment is never sent twice', async () => {
    const COMMENT_ID = '103';
    // Pre-seed as acked (already delivered in a prior session)
    db.prepare(
      `INSERT INTO pr_review_comments_routed (pr_number, repo, comment_id, routed_at, routed_state) VALUES (?, ?, ?, ?, 'acked')`,
    ).run(PR_NUMBER, REPO, `ic_${COMMENT_ID}`, Date.now());

    const github = makeGitHubClient(COMMENT_ID) as any;
    const sessions = makeSessionManager() as any;
    const watcher = new ReviewerCommentsWatcher(github, sessions);

    await (watcher as any).pollPR(
      db
        .prepare(`SELECT * FROM pull_requests WHERE pr_number = ? AND repo = ?`)
        .get(PR_NUMBER, REPO),
    );
    expect(sessions.sendOrResume).not.toHaveBeenCalled();
  });
});
