/**
 * Tests for StalledPRReconciler.
 *
 * Verifies:
 * - Incomplete-verdict PR with no new push is re-reviewed, up to the per-head_sha cap.
 * - Open PR whose review session is error/killed gets a FRESH review session
 *   (review_session_id cleared before enqueue).
 * - Gate-failed PR (autofix_failed/verify_failed) is retried without a new push.
 * - After the retry cap, the PR is escalated to pause_reason=stalled_reconcile_cap
 *   and a pr_stalled_escalated broadcast is sent.
 * - PRs already at stalled_reconcile_cap are skipped.
 * - PRs with a review in-flight are skipped.
 * - reconcileOnce() processes no-op PRs without side effects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries.js', () => ({
  getAllOpenPRs: vi.fn(),
  getSession: vi.fn(),
  setPauseReason: vi.fn(),
  incrementStalledPRRetryCount: vi.fn(),
  clearReviewSessionId: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn(() => null),
}));

import {
  getAllOpenPRs,
  getSession,
  setPauseReason,
  incrementStalledPRRetryCount,
  clearReviewSessionId,
} from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { StalledPRReconciler } from '../orchestration/StalledPRReconciler.js';
import type { ServerMessage } from '../ws/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    pr_number: 42,
    repo: 'org/repo',
    pr_url: 'https://github.com/org/repo/pull/42',
    task_id: 'notion:abc123',
    session_id: 'session-1',
    title: 'Test PR',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: null,
    updated_at: null,
    synced_at: new Date().toISOString(),
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'abc123',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    pause_reason_set_at: null,
    ci_remediation_attempted_sha: null,
    pre_review_stage: null,
    conflict_nudge_sha: null,
    stalled_pr_retry_count: 0,
    ...overrides,
  };
}

function makeReviewOrchestrator(inFlight = false) {
  return {
    isReviewInFlight: vi.fn(() => inFlight),
    enqueueReview: vi.fn(),
  };
}

function makeBroadcast() {
  const messages: ServerMessage[] = [];
  return {
    fn: (msg: ServerMessage) => messages.push(msg),
    messages,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('StalledPRReconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(incrementStalledPRRetryCount).mockReturnValue(1);
  });

  it('re-enqueues an incomplete-verdict PR with no new push', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1', // same → stalled
      review_session_id: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast, messages } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, repo: 'org/repo' }),
    );
    expect(incrementStalledPRRetryCount).toHaveBeenCalledWith(42, 'org/repo');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'stalled_pr_reconcile_attempt' }),
    );
    // No escalation yet
    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toBeUndefined();
  });

  it('clears review_session_id and enqueues fresh review for errored review session', async () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha1',
      last_reviewed_sha: null,
      review_session_id: 'dead-review-session',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);
    vi.mocked(getSession).mockReturnValue({
      status: 'error',
      session_id: 'dead-review-session',
    } as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(clearReviewSessionId).toHaveBeenCalledWith(42, 'org/repo');
    expect(ro.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, repo: 'org/repo' }),
    );
  });

  it('retries a gate-failed PR without requiring a new push', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'autofix_failed' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_session_id: null,
      pending_push: 0,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, repo: 'org/repo' }),
    );
    expect(clearReviewSessionId).not.toHaveBeenCalled(); // not errored session
  });

  it('also retries verify_failed gate-failure', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'verify_failed' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_session_id: null,
      pending_push: 0,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, repo: 'org/repo' }),
    );
  });

  it('escalates to stalled_reconcile_cap after retry cap is reached', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      stalled_pr_retry_count: 2, // already at cap
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast, messages } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'org/repo',
      'stalled_reconcile_cap',
    );
    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toMatchObject({
      type: 'pr_stalled_escalated',
      prNumber: 42,
      repo: 'org/repo',
      kind: 'incomplete_verdict',
    });
    expect(ro.enqueueReview).not.toHaveBeenCalled();
  });

  it('skips PRs already at stalled_reconcile_cap', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      pause_reason: JSON.stringify({
        reason: 'stalled_reconcile_cap',
        source: 'review',
        severity: 'needs_attention',
        retry_strategy: 'manual_action',
      }),
      stalled_pr_retry_count: 2,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(setPauseReason).not.toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
  });

  it('skips PRs with a review already in-flight', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator(true); // in-flight = true
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
  });

  it('skips normal open PRs with no stalled state', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha0', // different — not stalled
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
  });

  it('skips gate-failed PR with pending_push (normal push flow handles it)', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'autofix_failed' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_session_id: null,
      pending_push: 1, // push is pending
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
  });

  it('does nothing when reviewOrchestrator is not set', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    // No reviewOrchestrator set

    await reconciler.reconcileOnce();

    // reDrive returns at the !reviewOrchestrator guard before incrementing —
    // nothing happens.
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
  });
});
