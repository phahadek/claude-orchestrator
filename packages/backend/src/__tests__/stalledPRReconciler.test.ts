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
  deleteAnalyzeResult: vi.fn(),
  setHeadSha: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
  countUndeliveredInboxItems: vi.fn(() => 0),
  updateMergeState: vi.fn(),
  lookupSessionByBranch: vi.fn(() => null),
  linkPRTaskAndSession: vi.fn(),
  setPendingPush: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn(() => null),
}));

vi.mock('../config/settings.js', () => ({
  typedGetSetting: vi.fn(() => 5),
}));

import {
  getAllOpenPRs,
  getSession,
  setPauseReason,
  incrementStalledPRRetryCount,
  clearReviewSessionId,
  deleteAnalyzeResult,
  setHeadSha,
  clearTerminalPRFlags,
  countUndeliveredInboxItems,
  updateMergeState,
  lookupSessionByBranch,
  linkPRTaskAndSession,
  setPendingPush,
} from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { typedGetSetting } from '../config/settings.js';
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

function makeReviewOrchestrator(inFlight = false, enqueueReturns = true) {
  return {
    isReviewInFlight: vi.fn(() => inFlight),
    enqueueReview: vi.fn(() => enqueueReturns),
  };
}

function makeSessionManager() {
  return {
    relaunchFixerForPR: vi.fn().mockResolvedValue('session-1'),
    redeliverUndeliveredFeedback: vi.fn().mockResolvedValue(true),
  };
}

function makeGitHubClient(headSha: string | null) {
  return {
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha }),
    categorizeMergeability: vi.fn(),
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

  it('never re-drives an open human_merge_only PR, even in an otherwise incomplete-verdict shape', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_session_id: null,
      human_merge_only: 1,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast, messages } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
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

  it('relaunches the fixer (not a re-review) for a gate-failed PR without requiring a new push', async () => {
    const pr = makePR({
      review_result: JSON.stringify({
        verdict: 'autofix_failed',
        summary: 'verify failed: npm test',
      }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_session_id: null,
      pending_push: 0,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const sm = makeSessionManager();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(sm.relaunchFixerForPR).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 42, repo: 'org/repo' }),
      expect.any(String),
    );
    expect(clearReviewSessionId).not.toHaveBeenCalled(); // not errored session
    expect(incrementStalledPRRetryCount).toHaveBeenCalledWith(42, 'org/repo');
  });

  it('also relaunches the fixer for verify_failed gate-failure', async () => {
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
    const sm = makeSessionManager();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(sm.relaunchFixerForPR).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 42, repo: 'org/repo' }),
      expect.any(String),
    );
  });

  it('re-runs the gate via enqueueReview instead of relaunching the fixer when remote HEAD has advanced past head_sha (gate_failed)', async () => {
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
    const sm = makeSessionManager();
    const gh = makeGitHubClient('sha2'); // remote HEAD advanced past sha1
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);
    reconciler.setGitHubClient(gh as any);

    await reconciler.reconcileOnce();

    expect(gh.getPRState).toHaveBeenCalledWith(42, 'org/repo');
    expect(setHeadSha).toHaveBeenCalledWith(42, 'org/repo', 'sha2');
    expect(clearTerminalPRFlags).toHaveBeenCalledWith(
      42,
      'org/repo',
      'head_sha_advance',
    );
    expect(ro.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, repo: 'org/repo' }),
    );
    expect(sm.relaunchFixerForPR).not.toHaveBeenCalled();
    // The push is handled via setHeadSha's own atomic reset, not a manual bump.
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
  });

  it('relaunches the fixer (not enqueueReview) for a gate-failed PR when remote HEAD equals head_sha, and still escalates at the retry cap', async () => {
    const prBelowCap = makePR({
      review_result: JSON.stringify({ verdict: 'verify_failed' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_session_id: null,
      pending_push: 0,
      stalled_pr_retry_count: 1,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([prBelowCap] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const sm = makeSessionManager();
    const gh = makeGitHubClient('sha1'); // remote HEAD unchanged
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);
    reconciler.setGitHubClient(gh as any);

    await reconciler.reconcileOnce();

    expect(gh.getPRState).toHaveBeenCalledWith(42, 'org/repo');
    expect(setHeadSha).not.toHaveBeenCalled();
    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(sm.relaunchFixerForPR).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 42, repo: 'org/repo' }),
      expect.any(String),
    );

    // Unchanged behavior: once the retry count is at the cap, the PR still
    // escalates to stalled_reconcile_cap regardless of the HEAD check.
    vi.clearAllMocks();
    const prAtCap = makePR({
      review_result: JSON.stringify({ verdict: 'verify_failed' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_session_id: null,
      pending_push: 0,
      stalled_pr_retry_count: 2, // already at cap
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([prAtCap] as any);
    const { fn: broadcast2, messages } = makeBroadcast();
    const reconciler2 = new StalledPRReconciler(broadcast2, { retryCap: 2 });
    reconciler2.setReviewOrchestrator(ro as any);
    reconciler2.setSessionManager(sm as any);
    reconciler2.setGitHubClient(gh as any);

    await reconciler2.reconcileOnce();

    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toMatchObject({
      type: 'pr_stalled_escalated',
      prNumber: 42,
      repo: 'org/repo',
      kind: 'gate_failed',
    });
    expect(sm.relaunchFixerForPR).not.toHaveBeenCalled();
  });

  it('does not relaunch a gate-failed PR when sessionManager is not set', async () => {
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
    // No sessionManager set

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
  });

  it('routes a dead-session merge conflict to the fixer relaunch with a rebase prompt', async () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha1',
      merge_state: 'dirty',
      session_id: 'session-1',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);
    vi.mocked(getSession).mockImplementation((sessionId: string) => {
      if (sessionId === 'session-1') return { status: 'error' } as any;
      return null as any;
    });

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const sm = makeSessionManager();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(sm.relaunchFixerForPR).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 42, repo: 'org/repo' }),
      expect.stringContaining('Rebase'),
    );
  });

  it('does not treat a conflicted PR with a live (idle) implementing session as stalled', async () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha1',
      merge_state: 'dirty',
      session_id: 'session-1',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);
    vi.mocked(getSession).mockImplementation((sessionId: string) => {
      if (sessionId === 'session-1') return { status: 'idle' } as any;
      return null as any;
    });

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const sm = makeSessionManager();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    // pre_review_interrupted would otherwise match (no review_result, no pending
    // push) — but that's for the live-session nudge path (AutoMerger) to handle,
    // not the reconciler. Confirm the reconciler doesn't fixer-relaunch here.
    expect(sm.relaunchFixerForPR).not.toHaveBeenCalled();
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
      'incomplete_verdict — 2 fixer attempts exhausted',
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

  it('consumes a stuck pending_push and re-drives via enqueueReview for a gate-failed PR, bounded by the retry cap', async () => {
    const prBelowCap = makePR({
      review_result: JSON.stringify({ verdict: 'autofix_failed' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_session_id: null,
      pending_push: 1, // stuck push — no live session to notify it
      stalled_pr_retry_count: 1,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([prBelowCap] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(setPendingPush).toHaveBeenCalledWith(42, 'org/repo', 0);
    expect(ro.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, repo: 'org/repo' }),
    );
    expect(incrementStalledPRRetryCount).toHaveBeenCalledWith(42, 'org/repo');
    expect(setPauseReason).not.toHaveBeenCalled();

    // Once the retry cap is reached, the same stuck-pending_push state
    // escalates instead of looping.
    vi.clearAllMocks();
    const prAtCap = makePR({
      review_result: JSON.stringify({ verdict: 'autofix_failed' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_session_id: null,
      pending_push: 1,
      stalled_pr_retry_count: 2,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([prAtCap] as any);

    await reconciler.reconcileOnce();

    expect(setPendingPush).not.toHaveBeenCalled();
    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'org/repo',
      'stalled_reconcile_cap',
      expect.stringContaining('gate_failed'),
    );
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

  it('re-drives an analyze_failing PR, deletes analyze cache, and clears pause_reason', async () => {
    const pr = makePR({
      pause_reason: JSON.stringify({
        reason: 'analyze_failing',
        source: 'review',
        severity: 'needs_attention',
        retry_strategy: 'manual_action',
      }),
      head_sha: 'sha1',
      review_result: JSON.stringify({ verdict: 'analyze_failed' }),
      pending_push: 0,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(deleteAnalyzeResult).toHaveBeenCalledWith(42, 'org/repo', 'sha1');
    expect(setPauseReason).toHaveBeenCalledWith(42, 'org/repo', null);
    expect(ro.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, repo: 'org/repo' }),
    );
    expect(incrementStalledPRRetryCount).toHaveBeenCalledWith(42, 'org/repo');
  });

  it('escalates analyze_failing PR to stalled_reconcile_cap after retry cap', async () => {
    const pr = makePR({
      pause_reason: JSON.stringify({
        reason: 'analyze_failing',
        source: 'review',
        severity: 'needs_attention',
        retry_strategy: 'manual_action',
      }),
      head_sha: 'sha1',
      review_result: JSON.stringify({ verdict: 'analyze_failed' }),
      pending_push: 0,
      stalled_pr_retry_count: 2, // at cap
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
      'analyze_failing — 2 fixer attempts exhausted',
    );
    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toMatchObject({
      type: 'pr_stalled_escalated',
      prNumber: 42,
      repo: 'org/repo',
      kind: 'analyze_failing',
    });
    expect(ro.enqueueReview).not.toHaveBeenCalled();
  });

  it('clears review_session_id and enqueues review for pre_review_interrupted PR', async () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha1',
      review_session_id: null,
      pending_push: 0,
      pause_reason: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);
    vi.mocked(getSession).mockReturnValue(null as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(clearReviewSessionId).toHaveBeenCalledWith(42, 'org/repo');
    expect(ro.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, repo: 'org/repo' }),
    );
    expect(incrementStalledPRRetryCount).toHaveBeenCalledWith(42, 'org/repo');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'stalled_pr_reconcile_attempt' }),
    );
  });

  it('escalates pre_review_interrupted to stalled_reconcile_cap after retry cap', async () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha1',
      review_session_id: null,
      pending_push: 0,
      pause_reason: null,
      stalled_pr_retry_count: 2, // at cap
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
      'pre_review_interrupted — 2 fixer attempts exhausted',
    );
    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toMatchObject({
      type: 'pr_stalled_escalated',
      prNumber: 42,
      repo: 'org/repo',
      kind: 'pre_review_interrupted',
    });
    expect(ro.enqueueReview).not.toHaveBeenCalled();
  });

  it('skips analyze_failing PR with pending_push (push flow handles it)', async () => {
    const pr = makePR({
      pause_reason: JSON.stringify({
        reason: 'analyze_failing',
        source: 'review',
        severity: 'needs_attention',
        retry_strategy: 'manual_action',
      }),
      head_sha: 'sha1',
      pending_push: 1,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(deleteAnalyzeResult).not.toHaveBeenCalled();
  });

  it('refreshes a stale merge_state via GitHubClient for an approved+unmergeable PR, then re-drives via fixer relaunch', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
      head_sha: 'sha1',
      mergeable: 0,
      merge_state: 'unknown',
      session_id: 'session-1',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);
    vi.mocked(getSession).mockImplementation((sessionId: string) => {
      if (sessionId === 'session-1') return { status: 'error' } as any;
      return null as any;
    });

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const sm = makeSessionManager();
    const gh = makeGitHubClient(null);
    vi.mocked(gh.categorizeMergeability).mockResolvedValue({
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'dirty',
      failingChecks: [],
    } as any);
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);
    reconciler.setGitHubClient(gh as any);

    await reconciler.reconcileOnce();

    expect(gh.categorizeMergeability).toHaveBeenCalledWith(42, 'org/repo');
    expect(updateMergeState).toHaveBeenCalledWith(
      42,
      'org/repo',
      0,
      'dirty',
      null,
    );
    expect(sm.relaunchFixerForPR).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 42, repo: 'org/repo' }),
      expect.stringContaining('Rebase'),
    );
  });

  it('escalates an approved+unmergeable PR to stalled_reconcile_cap after DEFAULT_RETRY_CAP attempts on the same head_sha', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
      head_sha: 'sha1',
      mergeable: 0,
      merge_state: 'unknown',
      session_id: 'session-1',
      stalled_pr_retry_count: 2, // at DEFAULT_RETRY_CAP
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);
    vi.mocked(getSession).mockImplementation((sessionId: string) => {
      if (sessionId === 'session-1') return { status: 'idle' } as any;
      return null as any;
    });

    const { fn: broadcast, messages } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const sm = makeSessionManager();
    const gh = makeGitHubClient(null);
    vi.mocked(gh.categorizeMergeability).mockResolvedValue({
      category: 'conflict',
      mergeState: 'blocked',
      rawMergeableState: 'blocked',
      failingChecks: [],
    } as any);
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);
    reconciler.setGitHubClient(gh as any);

    await reconciler.reconcileOnce();

    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toMatchObject({
      type: 'pr_stalled_escalated',
      prNumber: 42,
      repo: 'org/repo',
      kind: 'conflict_dead_session',
    });
    expect(sm.relaunchFixerForPR).not.toHaveBeenCalled();
  });

  it('redelivers undelivered review feedback to an idle implementing session', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_iteration: 0,
      session_id: 'session-1',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);
    vi.mocked(getSession).mockImplementation((sessionId: string) => {
      if (sessionId === 'session-1') return { status: 'idle' } as any;
      return null as any;
    });
    vi.mocked(countUndeliveredInboxItems).mockReturnValue(1);
    vi.mocked(typedGetSetting).mockReturnValue(3);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const sm = makeSessionManager();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(sm.redeliverUndeliveredFeedback).toHaveBeenCalledWith('session-1');
    expect(incrementStalledPRRetryCount).toHaveBeenCalledWith(42, 'org/repo');
    expect(ro.enqueueReview).not.toHaveBeenCalled();
  });

  it('does not re-drive undelivered_review_feedback once review_iteration is at max_review_iterations', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      review_iteration: 3,
      session_id: 'session-1',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);
    vi.mocked(getSession).mockImplementation((sessionId: string) => {
      if (sessionId === 'session-1') return { status: 'idle' } as any;
      return null as any;
    });
    vi.mocked(countUndeliveredInboxItems).mockReturnValue(1);
    vi.mocked(typedGetSetting).mockReturnValue(3); // review_iteration (3) >= cap (3)

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const sm = makeSessionManager();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(sm.redeliverUndeliveredFeedback).not.toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
  });

  // ── Honest attempt accounting / orphaned-PR handling ──────────────────────

  it('does not increment the retry count for a null-task_id pre_review_interrupted PR when no dispatch occurs (task re-derivation fails)', async () => {
    const pr = makePR({
      task_id: null,
      session_id: null,
      review_result: null,
      head_sha: 'sha1',
      review_session_id: null,
      pending_push: 0,
      pause_reason: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);
    vi.mocked(lookupSessionByBranch).mockReturnValue(null);

    const { fn: broadcast, messages } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).not.toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'stalled_pr_reconcile_attempt' }),
    );
    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'org/repo',
      'stalled_reconcile_cap',
      expect.stringContaining('orphaned'),
    );
    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toMatchObject({
      type: 'pr_stalled_escalated',
      prNumber: 42,
      repo: 'org/repo',
      kind: 'orphaned_no_task_link',
    });
  });

  it('reDrive returns false and does not increment the retry count when enqueueReview does not queue the job', async () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha1',
      review_session_id: null,
      pending_push: 0,
      pause_reason: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const ro = makeReviewOrchestrator(false, false); // enqueueReview reports it did not queue
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'stalled_pr_reconcile_attempt' }),
    );
  });

  it('re-derives task_id from head_branch and re-drives an orphaned but mergeable PR on the first reconcile cycle', async () => {
    const pr = makePR({
      task_id: null,
      session_id: null,
      review_result: null,
      head_sha: 'sha1',
      review_session_id: null,
      pending_push: 0,
      pause_reason: null,
      head_branch: 'feature/orphaned-pr',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);
    vi.mocked(lookupSessionByBranch).mockReturnValue({
      session_id: 'derived-session',
      task_id: 'notion:derived-task',
    } as any);
    vi.mocked(getSession).mockReturnValue({
      status: 'done',
      session_id: 'derived-session',
      task_url: 'https://notion.so/derived-task',
    } as any);

    const { fn: broadcast, messages } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(linkPRTaskAndSession).toHaveBeenCalledWith(
      42,
      'org/repo',
      'notion:derived-task',
      'derived-session',
    );
    expect(ro.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 42,
        repo: 'org/repo',
        taskId: 'notion:derived-task',
      }),
    );
    expect(incrementStalledPRRetryCount).toHaveBeenCalledWith(42, 'org/repo');
    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toBeUndefined();
  });
});
