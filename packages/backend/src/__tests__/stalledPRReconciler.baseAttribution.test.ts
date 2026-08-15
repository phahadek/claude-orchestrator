/**
 * Base-attributable-failures exemption for StalledPRReconciler's
 * stalled_pr_retry_count — see baseAttribution.ts. Only a gate_failed stall
 * (the reconciler's sole test/build-failure kind) ever consults base health:
 *  - a gate_failed stall confirmed base-attributable (base tree total_fail)
 *    is still re-driven, but never charges the counter, and marks
 *    stalled_retry_base_exhausted so a later base-recovery pass knows this
 *    PR (and only this PR) is eligible for a budget restore.
 *  - once already escalated to stalled_reconcile_cap, a PR whose
 *    stalled_retry_base_exhausted flag is set has its budget restored (and
 *    pause cleared) the next time the base branch comes back clean_pass —
 *    scoped to that PR alone, never every open PR.
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
}));

import {
  getAllOpenPRs,
  setPauseReason,
  incrementStalledPRRetryCount,
  setStalledRetryBaseExhausted,
  resetStalledPRRetryCountForBaseRecovery,
} from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { getProjectByGithubRepo } from '../config.js';
import {
  isBaseTotalFail,
  isProjectBaseHealthy,
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

  it('marks stalled_retry_base_exhausted (without incrementing further) on escalation when the exhausting stall was base-attributable', async () => {
    vi.mocked(isBaseTotalFail).mockResolvedValue(true);
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

  it('restores the budget and clears the pause once base recovers for a PR whose exhaustion was base-attributable', async () => {
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 1,
      pause_reason: 'stalled_reconcile_cap',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast, messages } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).toHaveBeenCalledWith(
      1715,
      'org/repo',
    );
    expect(setPauseReason).toHaveBeenCalledWith(1715, 'org/repo', null);
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
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).not.toHaveBeenCalled();
    expect(setPauseReason).not.toHaveBeenCalled();
  });

  it('never restores a base-attributable-exhausted PR while base is still unhealthy', async () => {
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(false);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 1,
      pause_reason: 'stalled_reconcile_cap',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).not.toHaveBeenCalled();
    expect(setPauseReason).not.toHaveBeenCalled();
  });
});
