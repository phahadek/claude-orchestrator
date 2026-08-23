/**
 * Base-attributable-failures exemption for StalledPRReconciler's
 * stalled_pr_retry_count — see baseAttribution.ts.
 *
 *  - Pre-escalation re-drive (reDriveViaFixerRelaunch): a gate_failed stall
 *    confirmed base-attributable right now (base tree total_fail) is still
 *    re-driven, but never charges the counter, and marks
 *    stalled_retry_base_exhausted so a later base-recovery pass knows this
 *    PR (and only this PR) is eligible for a budget restore.
 *  - Escalation-time arming: stalled_retry_base_exhausted is armed purely on
 *    stall-kind eligibility (gate_failed, session_inert,
 *    pre_review_interrupted — BASE_ATTRIBUTABLE_STALL_KINDS) with no live
 *    base-health check of its own — a point-in-time sample at the exact
 *    escalation moment can miss a total_fail that happened earlier or
 *    hasn't happened yet. The other six stall kinds never arm it.
 *  - Recovery: once already escalated to stalled_reconcile_cap, a PR whose
 *    stalled_retry_base_exhausted flag is set has its budget restored (and
 *    pause cleared via clearTerminalPRFlags's 'base_recovery' trigger) once
 *    a base-health-history query over [pause_reason_set_at, now] finds a
 *    total_fail probe AND the base branch is healthy right now — scoped to
 *    that PR alone, never every open PR.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries.js', () => ({
  getAllOpenPRs: vi.fn(),
  getSession: vi.fn(),
  setPauseReason: vi.fn(),
  incrementStalledPRRetryCount: vi.fn(),
  setStalledRetryBaseExhausted: vi.fn(),
  resetStalledPRRetryCountForBaseRecovery: vi.fn(),
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
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
  hasPrBodyMarkerUpdateSinceTimestamp: vi.fn(() => false),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn(),
}));

vi.mock('../config/settings.js', () => ({
  typedGetSetting: vi.fn(() => 5),
}));

vi.mock('../session/sessionLifecycle.js', () => ({
  sessionBusyInFlightToolCall: vi.fn(() => false),
}));

vi.mock('../orchestration/baseAttribution.js', () => ({
  isBaseTotalFail: vi.fn(),
  isProjectBaseHealthy: vi.fn(),
  wasBaseTotalFailSince: vi.fn(),
}));

import {
  getAllOpenPRs,
  setPauseReason,
  incrementStalledPRRetryCount,
  setStalledRetryBaseExhausted,
  resetStalledPRRetryCountForBaseRecovery,
  clearTerminalPRFlags,
  getSession,
  getSessionLastActivityMs,
} from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { getProjectByGithubRepo } from '../config.js';
import {
  isBaseTotalFail,
  isProjectBaseHealthy,
  wasBaseTotalFailSince,
} from '../orchestration/baseAttribution.js';
import { StalledPRReconciler } from '../orchestration/StalledPRReconciler.js';
import type { ServerMessage } from '../ws/types.js';

const PROJECT = { id: 'proj-1', projectDir: '/proj' };

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    pr_number: 1715,
    repo: 'org/repo',
    pr_url: 'https://github.com/org/repo/pull/1715',
    task_id: 'notion:abc123',
    session_id: 'session-1',
    title: 'Test PR',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: JSON.stringify({ verdict: 'verify_failed' }),
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
    stalled_retry_base_exhausted: 0,
    flake_recovery_attempts: 0,
    flake_recovery_base_exhausted: 0,
    human_merge_only: 0,
    pr_intent_id: null,
    ...overrides,
  };
}

function makeBroadcast() {
  const messages: ServerMessage[] = [];
  return {
    fn: (msg: ServerMessage) => messages.push(msg),
    messages,
  };
}

function makeSessionManager() {
  return { relaunchFixerForPR: vi.fn().mockResolvedValue('session-1') };
}

describe('StalledPRReconciler base-attributable-failures exemption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectByGithubRepo).mockReturnValue(PROJECT as any);
    vi.mocked(incrementStalledPRRetryCount).mockReturnValue(1);
    vi.mocked(getSession).mockReturnValue(null as any);
    vi.mocked(getSessionLastActivityMs).mockReturnValue(null);
  });

  it('does not charge stalled_pr_retry_count for a gate_failed stall confirmed base-attributable (base tree total_fail), but still re-drives the fixer', async () => {
    vi.mocked(isBaseTotalFail).mockResolvedValue(true);
    const pr = makePR({ stalled_pr_retry_count: 1 });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const sm = makeSessionManager();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(sm.relaunchFixerForPR).toHaveBeenCalled();
    expect(incrementStalledPRRetryCount).not.toHaveBeenCalled();
    expect(setStalledRetryBaseExhausted).toHaveBeenCalledWith(
      1715,
      'org/repo',
      true,
    );
  });

  it('charges stalled_pr_retry_count normally for a gate_failed stall not base-attributable', async () => {
    vi.mocked(isBaseTotalFail).mockResolvedValue(false);
    const pr = makePR({ stalled_pr_retry_count: 1 });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const sm = makeSessionManager();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setSessionManager(sm as any);

    await reconciler.reconcileOnce();

    expect(incrementStalledPRRetryCount).toHaveBeenCalledWith(1715, 'org/repo');
    expect(setStalledRetryBaseExhausted).not.toHaveBeenCalled();
  });

  it('marks stalled_retry_base_exhausted on escalation for a gate_failed stall purely on kind eligibility — no live base-health check', async () => {
    // Deliberately never resolved/false — arming must not depend on it.
    vi.mocked(isBaseTotalFail).mockResolvedValue(false);
    const pr = makePR({ stalled_pr_retry_count: 2 }); // already at cap
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast, messages } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(setStalledRetryBaseExhausted).toHaveBeenCalledWith(
      1715,
      'org/repo',
      true,
    );
    expect(setPauseReason).toHaveBeenCalledWith(
      1715,
      'org/repo',
      'stalled_reconcile_cap',
      expect.any(String),
    );
    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toBeDefined();
  });

  it('marks stalled_retry_base_exhausted on escalation for a session_inert stall', async () => {
    vi.mocked(getSession).mockReturnValue(null);
    vi.mocked(getSessionLastActivityMs).mockReturnValue(Date.now() - 100_000);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      review_result: JSON.stringify({ verdict: 'approved' }),
      mergeable: 1,
      merge_state: 'clean',
      last_reviewed_sha: 'sha1',
      review_session_id: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(setStalledRetryBaseExhausted).toHaveBeenCalledWith(
      1715,
      'org/repo',
      true,
    );
  });

  it('marks stalled_retry_base_exhausted on escalation for a pre_review_interrupted stall', async () => {
    const pr = makePR({
      stalled_pr_retry_count: 2,
      review_result: null,
      review_session_id: null,
      pending_push: 0,
      last_reviewed_sha: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(setStalledRetryBaseExhausted).toHaveBeenCalledWith(
      1715,
      'org/repo',
      true,
    );
  });

  it('never arms stalled_retry_base_exhausted on escalation for a stall kind unrelated to base health (errored_review_session)', async () => {
    vi.mocked(getSession).mockReturnValue({ status: 'error' } as any);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      review_result: null,
      review_session_id: 'dead-review-session',
      pending_push: 0,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast, messages } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(setStalledRetryBaseExhausted).not.toHaveBeenCalled();
    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toBeDefined();
  });

  it('restores the budget and clears the pause via clearTerminalPRFlags(base_recovery) once a history probe confirms attribution and base is currently healthy', async () => {
    vi.mocked(wasBaseTotalFailSince).mockResolvedValue(true);
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 1,
      pause_reason: 'stalled_reconcile_cap',
      pause_reason_set_at: 1000,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast, messages } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(wasBaseTotalFailSince).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proj-1' }),
      1000,
    );
    expect(resetStalledPRRetryCountForBaseRecovery).toHaveBeenCalledWith(
      1715,
      'org/repo',
    );
    expect(clearTerminalPRFlags).toHaveBeenCalledWith(
      1715,
      'org/repo',
      'base_recovery',
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'stalled_pr_base_recovery_reset',
      }),
    );
    expect(messages.find((m) => m.type === 'pr_pause_cleared')).toBeDefined();
  });

  it('never restores an escalated PR whose exhaustion was not base-attributable, even once base recovers', async () => {
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 0, // exhausted for an unrelated reason
      pause_reason: 'stalled_reconcile_cap',
      pause_reason_set_at: 1000,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).not.toHaveBeenCalled();
    expect(clearTerminalPRFlags).not.toHaveBeenCalled();
  });

  it('never restores a base-attributable-exhausted PR while base is still unhealthy, even with a matching history probe', async () => {
    vi.mocked(wasBaseTotalFailSince).mockResolvedValue(true);
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(false);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 1,
      pause_reason: 'stalled_reconcile_cap',
      pause_reason_set_at: 1000,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).not.toHaveBeenCalled();
    expect(clearTerminalPRFlags).not.toHaveBeenCalled();
  });

  it('never restores a base-attributable-exhausted PR when no matching history probe exists, even though base is currently healthy', async () => {
    vi.mocked(wasBaseTotalFailSince).mockResolvedValue(false);
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 1,
      pause_reason: 'stalled_reconcile_cap',
      pause_reason_set_at: 1000,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).not.toHaveBeenCalled();
    expect(clearTerminalPRFlags).not.toHaveBeenCalled();
  });
});
