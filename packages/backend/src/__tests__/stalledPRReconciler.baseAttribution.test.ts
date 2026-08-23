/**
 * Base-attributable-failures exemption for StalledPRReconciler's
 * stalled_pr_retry_count — see baseAttribution.ts. gate_failed, session_inert,
 * and pre_review_interrupted stalls (BASE_ATTRIBUTABLE_ESCALATION_KINDS) may
 * all plausibly trace back to a broken base branch:
 *  - a gate_failed stall confirmed base-attributable live (base tree
 *    total_fail right now) is still re-driven, but never charges the
 *    counter, and marks stalled_retry_base_exhausted so a later
 *    base-recovery pass knows this PR (and only this PR) is a candidate for
 *    a budget restore.
 *  - on escalation (retry cap reached), any of the three eligible kinds arms
 *    stalled_retry_base_exhausted unconditionally — no live health check at
 *    this instant, since a total_fail window is often short-lived and may
 *    not coincide with the exact moment of escalation.
 *  - once already escalated to stalled_reconcile_cap, a PR whose
 *    stalled_retry_base_exhausted flag is set has its budget restored (and
 *    pause cleared via the base_recovery trigger) once the base branch is
 *    clean_pass again AND base-health history corroborates a total_fail
 *    verdict occurred at/after this PR's own escalation timestamp — scoped
 *    to that PR alone, never every open PR.
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
  hasBaseTotalFailSince: vi.fn(),
}));

import {
  getAllOpenPRs,
  getSession,
  setPauseReason,
  incrementStalledPRRetryCount,
  setStalledRetryBaseExhausted,
  resetStalledPRRetryCountForBaseRecovery,
  clearTerminalPRFlags,
  getSessionLastActivityMs,
} from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { getProjectByGithubRepo } from '../config.js';
import {
  isBaseTotalFail,
  isProjectBaseHealthy,
  hasBaseTotalFailSince,
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

  it('does not charge stalled_pr_retry_count for a gate_failed stall confirmed base-attributable live (base tree total_fail), but still re-drives the fixer', async () => {
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

  it('charges stalled_pr_retry_count normally for a gate_failed stall not base-attributable live', async () => {
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

  const ARMING_CASES: Array<{
    kind: string;
    overrides: Record<string, unknown>;
    configureMocks?: () => void;
  }> = [
    {
      kind: 'gate_failed',
      overrides: { review_result: JSON.stringify({ verdict: 'verify_failed' }) },
    },
    {
      kind: 'session_inert',
      // A stall kind that could never arm the escape before this change —
      // classifyStalledPR's activity-based fallback: no verdict, a review
      // session that resolves to a non-terminal status (so pre_review_interrupted
      // and errored_review_session don't shadow it), and a session whose last
      // activity is well past the inert threshold.
      overrides: {
        review_result: null,
        review_session_id: 'live-review-session',
        session_id: 'inert-session',
      },
      configureMocks: () => {
        vi.mocked(getSession).mockReturnValue({ status: 'running' } as any);
        vi.mocked(getSessionLastActivityMs).mockReturnValue(
          Date.now() - 10 * 60 * 1000,
        );
      },
    },
    {
      kind: 'pre_review_interrupted',
      // Another kind that could never arm the escape before this change: no
      // verdict yet, no pending push, and no review session holding the slot.
      overrides: { review_result: null, review_session_id: null, pending_push: 0 },
    },
  ];

  describe.each(ARMING_CASES)(
    'arming on escalation for kind=$kind (BASE_ATTRIBUTABLE_ESCALATION_KINDS)',
    ({ overrides, configureMocks }) => {
      it('arms stalled_retry_base_exhausted unconditionally on escalation, without consulting the live base-health check', async () => {
        configureMocks?.();
        // isBaseTotalFail is never even resolved usefully here — rejects to
        // prove arming does not depend on it.
        vi.mocked(isBaseTotalFail).mockRejectedValue(
          new Error('must not be called at escalation time'),
        );
        const pr = makePR({ stalled_pr_retry_count: 2, ...overrides }); // already at cap
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
    },
  );

  it('takes the base-recovery escape (kind=session_inert) once the base recovers — a kind that could never arm the escape before this change', async () => {
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    vi.mocked(hasBaseTotalFailSince).mockResolvedValue(true);
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

    expect(hasBaseTotalFailSince).toHaveBeenCalledWith(PROJECT, 1000);
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

  it('takes the escape when the PR escalated before a total_fail verdict existed and is still escalated once history shows base recovery — recovery-time comparison, not just the live cached verdict', async () => {
    // The live snapshot at recovery time is clean_pass (isProjectBaseHealthy
    // true) — the escape must still be taken because history shows a
    // total_fail run landed after this PR's own escalation timestamp.
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    vi.mocked(hasBaseTotalFailSince).mockResolvedValue(true);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 1,
      pause_reason: 'stalled_reconcile_cap',
      pause_reason_set_at: 500, // escalated before the total_fail window opened
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(hasBaseTotalFailSince).toHaveBeenCalledWith(PROJECT, 500);
    expect(resetStalledPRRetryCountForBaseRecovery).toHaveBeenCalled();
  });

  it('does not take the escape when the base is clean_pass now but history shows no total_fail since escalation', async () => {
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    vi.mocked(hasBaseTotalFailSince).mockResolvedValue(false);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 1,
      pause_reason: 'stalled_reconcile_cap',
      pause_reason_set_at: 500,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).not.toHaveBeenCalled();
    expect(clearTerminalPRFlags).not.toHaveBeenCalled();
  });

  it('never restores an escalated PR whose exhaustion was for a reason unrelated to base health, even once base recovers', async () => {
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    vi.mocked(hasBaseTotalFailSince).mockResolvedValue(true);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 0, // exhausted for an unrelated reason — never armed
      pause_reason: 'stalled_reconcile_cap',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).not.toHaveBeenCalled();
    expect(clearTerminalPRFlags).not.toHaveBeenCalled();
    expect(hasBaseTotalFailSince).not.toHaveBeenCalled();
  });

  it('never restores a base-attributable-exhausted PR while base is still unhealthy', async () => {
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(false);
    vi.mocked(hasBaseTotalFailSince).mockResolvedValue(true);
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
    expect(clearTerminalPRFlags).not.toHaveBeenCalled();
  });
});
