/**
 * Real-DB test: a push on a PR holding depth_review_pending must leave the PR
 * merge-blocking (non-mergeable to AutoMerger) until a fresh depth pass clears it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'org/repo', 'notion', 1000, 1000);
  return { db };
});
vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn().mockReturnValue(undefined),
  AUTO_REVIEW_ENABLED: true,
}));
vi.mock('../../config/settings', () => ({
  typedGetSetting: vi.fn().mockReturnValue(5),
}));
vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  hasTaskEditSinceTimestamp: vi.fn().mockReturnValue(false),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../reviewUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../reviewUtils')>()),
  shouldAutoReview: vi.fn().mockReturnValue(true),
}));

import { PRMergeWatcher } from '../PRMergeWatcher';
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import type { ReviewOrchestrator } from '../ReviewOrchestrator';
import {
  upsertPullRequest,
  setPauseReason,
  getPRByNumber,
  clearPauseReasonEntry,
} from '../../db/queries';
import {
  isMergeBlockingPause,
  parsePauseReasonSet,
} from '../../db/pauseReason';
import { db } from '../../db/db';

const REPO = 'org/repo';
const PR_NUMBER = 77;
const NOW = '2024-01-01T00:00:00Z';

describe('PRMergeWatcher.handlePushDetected — depth-review hold', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM pull_requests').run();
  });

  it('keeps depth_review_pending (merge-blocking) after a push, clearing other reasons, until a depth pass discharges it', async () => {
    upsertPullRequest({
      pr_number: PR_NUMBER,
      pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      task_id: null,
      session_id: 'coder-session',
      repo: REPO,
      title: 'PR',
      body: null,
      head_branch: 'feature/x',
      base_branch: 'dev',
      state: 'open',
      draft: 0,
      review_result: null,
      review_at: null,
      created_at: NOW,
      updated_at: NOW,
      synced_at: NOW,
      review_iteration: 0,
      review_session_id: 'review-session',
      head_sha: 'oldsha',
      last_reviewed_sha: null,
      node_id: null,
      mergeable: null,
      merge_state: null,
      merge_state_checked_at: null,
    });
    setPauseReason(PR_NUMBER, REPO, 'ci_failing');
    setPauseReason(PR_NUMBER, REPO, 'depth_review_pending');

    const github = {
      fetchPR: vi.fn().mockResolvedValue({ headSha: 'newsha' }),
    } as unknown as GitHubClient;
    const sessions = new EventEmitter() as unknown as SessionManager;
    const reviewOrchestrator = {
      consumeAutofixSha: vi.fn().mockReturnValue(false),
      isReviewInFlight: vi.fn().mockReturnValue(false),
      enqueueReview: vi.fn(),
    } as unknown as ReviewOrchestrator;
    const watcher = new PRMergeWatcher(github, sessions, undefined, vi.fn());
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(getPRByNumber(PR_NUMBER, REPO)!);

    expect(reviewOrchestrator.enqueueReview).toHaveBeenCalledTimes(1);
    const after = getPRByNumber(PR_NUMBER, REPO)!;
    expect(
      parsePauseReasonSet(after.pause_reason).map((e) => e.reason),
    ).toEqual(['depth_review_pending']);
    expect(isMergeBlockingPause(after.pause_reason)).toBe(true);

    clearPauseReasonEntry(PR_NUMBER, REPO, 'depth_review_pending');
    expect(
      isMergeBlockingPause(getPRByNumber(PR_NUMBER, REPO)!.pause_reason),
    ).toBe(false);
  });
});
