/**
 * Breadth-attributable-failures exemption for StalledPRReconciler's
 * stalled_pr_retry_count — replaces the retired whole-tree base-health
 * check (baseAttribution.ts, deleted) with a per-run check against the PR's
 * own latest test-request run: gate_failed, session_inert, and
 * pre_review_interrupted stalls (BASE_ATTRIBUTABLE_ESCALATION_KINDS) may all
 * plausibly trace back to a widely-failing test rather than the PR's own
 * change:
 *  - a gate_failed stall whose latest run's failures are all
 *    breadth-attributable right now is still re-driven, but never charges
 *    the counter, and marks stalled_retry_base_exhausted so a later
 *    base-recovery pass knows this PR (and only this PR) is a candidate for
 *    a budget restore.
 *  - on escalation (retry cap reached), any of the three eligible kinds arms
 *    stalled_retry_base_exhausted unconditionally — no live check at this
 *    instant.
 *  - once already escalated (reconcile_exhausted), a PR whose
 *    stalled_retry_base_exhausted flag is set has its budget restored (and
 *    pause cleared via the base_recovery trigger) once its latest run's
 *    failures are breadth-attributable right now — scoped to that PR alone,
 *    never every open PR.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries.js', () => ({
  getAllOpenPRs: vi.fn(),
  getSession: vi.fn(),
  setPauseReason: vi.fn(),
  incrementStalledPRRetryCount: vi.fn(),
  setStalledRetryBaseExhausted: vi.fn(),
  resetStalledPRRetryCountForBaseRecovery: vi.fn(),
  setReconcileExhausted: vi.fn(),
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
  getLatestTestRequestRunForSession: vi.fn(),
  isRunFailureBreadthAttributable: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
  hasPrBodyMarkerUpdateSinceTimestamp: vi.fn(() => false),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn(),
}));

vi.mock('../config/settings.js', () => ({
  typedGetSetting: vi.fn((key: string) => {
    if (key === 'flip_rate_breadth_n') return 3;
    if (key === 'flip_rate_breadth_window_hours') return 24;
    return 5;
  }),
}));

vi.mock('../session/sessionLifecycle.js', () => ({
  sessionBusyInFlightToolCall: vi.fn(() => false),
  sessionAwaitingOperatorDecision: vi.fn(() => false),
}));

import {
  getAllOpenPRs,
  getSession,
  incrementStalledPRRetryCount,
  setStalledRetryBaseExhausted,
  resetStalledPRRetryCountForBaseRecovery,
  setReconcileExhausted,
  clearTerminalPRFlags,
  getSessionLastActivityMs,
  getLatestTestRequestRunForSession,
  isRunFailureBreadthAttributable,
} from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { getProjectByGithubRepo } from '../config.js';
import { StalledPRReconciler } from '../orchestration/StalledPRReconciler.js';
import type { ServerMessage } from '../ws/types.js';

const PROJECT = { id: 'proj-1', projectDir: '/proj' };
const LATEST_RUN = { id: 'run-latest' };

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
    reconcile_exhausted: 0,
    reconcile_exhausted_set_at: null,
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

describe('StalledPRReconciler breadth-attributable-failures exemption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectByGithubRepo).mockReturnValue(PROJECT as any);
    vi.mocked(incrementStalledPRRetryCount).mockReturnValue(1);
    vi.mocked(getLatestTestRequestRunForSession).mockReturnValue(
      LATEST_RUN as any,
    );
  });

  it('does not charge stalled_pr_retry_count for a gate_failed stall whose latest run is breadth-attributable right now, but still re-drives the fixer', async () => {
    vi.mocked(isRunFailureBreadthAttributable).mockReturnValue(true);
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
    // The PR's own session id is threaded through to find its latest run.
    expect(getLatestTestRequestRunForSession).toHaveBeenCalledWith(
      'proj-1',
      'session-1',
    );
    expect(isRunFailureBreadthAttributable).toHaveBeenCalledWith(
      'run-latest',
      3,
      24,
      expect.any(Number),
    );
  });

  it('charges stalled_pr_retry_count normally for a gate_failed stall not breadth-attributable', async () => {
    vi.mocked(isRunFailureBreadthAttributable).mockReturnValue(false);
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
      overrides: {
        review_result: JSON.stringify({ verdict: 'verify_failed' }),
      },
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
      overrides: {
        review_result: null,
        review_session_id: null,
        pending_push: 0,
      },
    },
  ];

  describe.each(ARMING_CASES)(
    'arming on escalation for kind=$kind (BASE_ATTRIBUTABLE_ESCALATION_KINDS)',
    ({ overrides, configureMocks }) => {
      it('arms stalled_retry_base_exhausted unconditionally on escalation, without consulting the live breadth check', async () => {
        configureMocks?.();
        // isRunFailureBreadthAttributable is never even consulted here — a
        // throw would surface as a test failure if arming depended on it.
        vi.mocked(isRunFailureBreadthAttributable).mockImplementation(() => {
          throw new Error('must not be called at escalation time');
        });
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
        expect(setReconcileExhausted).toHaveBeenCalledWith(
          1715,
          'org/repo',
          true,
        );
        expect(
          messages.find((m) => m.type === 'pr_stalled_escalated'),
        ).toBeDefined();
      });
    },
  );

  it('takes the base-recovery escape (kind=session_inert) once its latest run is breadth-attributable — a kind that could never arm the escape before this change', async () => {
    vi.mocked(isRunFailureBreadthAttributable).mockReturnValue(true);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 1,
      reconcile_exhausted: 1,
      reconcile_exhausted_set_at: 1000,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast, messages } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(getLatestTestRequestRunForSession).toHaveBeenCalledWith(
      'proj-1',
      'session-1',
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

  it('does not take the escape when the latest run is not breadth-attributable', async () => {
    vi.mocked(isRunFailureBreadthAttributable).mockReturnValue(false);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 1,
      reconcile_exhausted: 1,
      reconcile_exhausted_set_at: 500,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).not.toHaveBeenCalled();
    expect(clearTerminalPRFlags).not.toHaveBeenCalled();
  });

  it('never restores an escalated PR whose exhaustion was for a reason unrelated to base health, even once its latest run would clear breadth', async () => {
    vi.mocked(isRunFailureBreadthAttributable).mockReturnValue(true);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 0, // exhausted for an unrelated reason — never armed
      reconcile_exhausted: 1,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).not.toHaveBeenCalled();
    expect(clearTerminalPRFlags).not.toHaveBeenCalled();
    expect(isRunFailureBreadthAttributable).not.toHaveBeenCalled();
  });

  it('never restores a base-attributable-exhausted PR with no session to check a latest run for', async () => {
    vi.mocked(getLatestTestRequestRunForSession).mockReturnValue(undefined);
    const pr = makePR({
      stalled_pr_retry_count: 2,
      stalled_retry_base_exhausted: 1,
      reconcile_exhausted: 1,
      session_id: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr] as any);

    const { fn: broadcast } = makeBroadcast();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });

    await reconciler.reconcileOnce();

    expect(resetStalledPRRetryCountForBaseRecovery).not.toHaveBeenCalled();
    expect(clearTerminalPRFlags).not.toHaveBeenCalled();
  });
});
