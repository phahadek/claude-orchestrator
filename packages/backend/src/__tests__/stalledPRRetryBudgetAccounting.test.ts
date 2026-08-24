/**
 * Tests for the stalled-PR retry-budget accounting fix:
 *
 *  - A fixer relaunch refused before it starts (memory admission deferral,
 *    sessionManager unset, no session to relaunch onto) must not increment
 *    stalled_pr_retry_count.
 *  - A fixer relaunch that actually starts still increments the counter
 *    exactly once per attempt.
 *  - reDriveViaFixerRelaunch returns a value reflecting whether the relaunch
 *    actually occurred.
 *  - A PR with no session to relaunch onto escalates immediately with a
 *    real-cause pause reason, distinct from the generic reconcile_exhausted
 *    flag StalledPRReconciler.escalate() sets on retry-cap exhaustion.
 *  - clearTerminalPRFlags('human_unpark') restores stalled_pr_retry_count /
 *    stalled_retry_base_exhausted alongside clearing a live reconcile_exhausted
 *    flag, so an operator rerun isn't immediately re-capped on the next tick.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Part 1: StalledPRReconciler-level charge-on-action tests ────────────────

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
  getSessionLastActivityMs: vi.fn(() => null),
  setStalledRetryBaseExhausted: vi.fn(),
  resetStalledPRRetryCountForBaseRecovery: vi.fn(),
  setReconcileExhausted: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
  hasPrBodyMarkerUpdateSinceTimestamp: vi.fn(() => false),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn(() => null),
}));

vi.mock('../config/settings.js', () => ({
  typedGetSetting: vi.fn(() => 5),
}));

vi.mock('../session/sessionLifecycle.js', () => ({
  sessionBusyInFlightToolCall: vi.fn(() => false),
}));

import {
  getAllOpenPRs,
  setPauseReason,
  incrementStalledPRRetryCount,
  setReconcileExhausted,
} from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { StalledPRReconciler } from '../orchestration/StalledPRReconciler.js';
import type { ServerMessage } from '../ws/types.js';

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
    review_result: JSON.stringify({ verdict: 'autofix_failed' }),
    review_at: null,
    created_at: null,
    updated_at: null,
    synced_at: new Date().toISOString(),
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'sha1',
    last_reviewed_sha: 'sha1',
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
    flake_recovery_attempts: 0,
    ...overrides,
  };
}

function makeReviewOrchestrator() {
  return {
    isReviewInFlight: vi.fn(() => false),
    enqueueReview: vi.fn(() => true),
  };
}

function makeBroadcast() {
  const messages: ServerMessage[] = [];
  return {
    fn: (msg: ServerMessage) => messages.push(msg),
    messages,
  };
}

describe('StalledPRReconciler — retry budget is only charged for a relaunch that actually happens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(incrementStalledPRRetryCount).mockReturnValue(1);
  });

  it('does not increment stalled_pr_retry_count when the fixer relaunch is refused by memory admission (returns null)', async () => {
    const pr = makePR();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const relaunchFixerForPR = vi.fn().mockResolvedValue(null);
    const sm = { relaunchFixerForPR };
    const ro = makeReviewOrchestrator();
    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(relaunchFixerForPR).toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'stalled_pr_reconcile_attempt' }),
    );
  });

  it('does not increment stalled_pr_retry_count when sessionManager is unset', async () => {
    const pr = makePR();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const ro = makeReviewOrchestrator();
    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    // No sessionManager set.

    await reconciler.reconcileOnce();

    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
  });

  it('does not increment stalled_pr_retry_count and escalates immediately when the PR has no session_id to relaunch onto', async () => {
    const pr = makePR({ session_id: null });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const relaunchFixerForPR = vi.fn();
    const sm = { relaunchFixerForPR };
    const ro = makeReviewOrchestrator();
    const { fn: broadcast, messages } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(relaunchFixerForPR).not.toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'org/repo',
      'stalled_no_relaunch_target',
      expect.stringContaining('no session to relaunch onto'),
    );
    // Distinct from the generic reconcile_exhausted flag escalate() sets on
    // retry-cap exhaustion — this PR was never charged against that budget.
    expect(setReconcileExhausted).not.toHaveBeenCalled();
    expect(
      messages.find(
        (m) =>
          m.type === 'pr_stalled_escalated' &&
          (m as { kind: string }).kind === 'no_relaunch_target',
      ),
    ).toBeDefined();
  });

  it('increments stalled_pr_retry_count exactly once when the fixer relaunch actually starts', async () => {
    const pr = makePR();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const relaunchFixerForPR = vi.fn().mockResolvedValue('session-1');
    const sm = { relaunchFixerForPR };
    const ro = makeReviewOrchestrator();
    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(relaunchFixerForPR).toHaveBeenCalledTimes(1);
    expect(incrementStalledPRRetryCount).toHaveBeenCalledTimes(1);
    expect(incrementStalledPRRetryCount).toHaveBeenCalledWith(42, 'org/repo');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'stalled_pr_reconcile_attempt' }),
    );
  });

  it('does not increment stalled_pr_retry_count when redeliverUndeliveredFeedback finds nothing to redeliver', async () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { getSession, countUndeliveredInboxItems } = await import(
      '../db/queries.js'
    );
    vi.mocked(getSession).mockReturnValue({ status: 'idle' } as any);
    vi.mocked(countUndeliveredInboxItems).mockReturnValue(1);

    const redeliverUndeliveredFeedback = vi.fn().mockResolvedValue(false);
    const sm = { redeliverUndeliveredFeedback };
    const ro = makeReviewOrchestrator();
    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(redeliverUndeliveredFeedback).toHaveBeenCalledWith('session-1');
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
  });

  it('does not increment stalled_pr_retry_count for the pending-push consume path when enqueueReview declines to queue', async () => {
    const pr = makePR({ pending_push: 1 });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const ro = {
      isReviewInFlight: vi.fn(() => false),
      enqueueReview: vi.fn(() => false),
    };
    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    expect(ro.enqueueReview).toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
  });
});
