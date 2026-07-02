import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/queries', () => ({
  getDeadSessionsAtBoot: vi.fn().mockReturnValue([]),
  getIdleSessionsWithResolvedPRs: vi.fn().mockReturnValue([]),
  getIdleReviewSessionsWithTerminalCodingOrPR: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  updateSessionStatus: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getDeadSessionsAtBoot,
  getIdleSessionsWithResolvedPRs,
  markSessionDone,
  updateSessionStatus,
} from '../../db/queries';
import { runBootIdleReconciliation } from '../bootIdleReconciliation';
import type {
  IdleSessionWithResolvedPR,
  DeadSessionAtBoot,
} from '../../db/queries';

function makeRow(
  overrides: Partial<IdleSessionWithResolvedPR> = {},
): IdleSessionWithResolvedPR {
  return {
    session_id: 'coding-session-id',
    task_id: 'task-1',
    project_id: 'project-1',
    pr_state: 'merged',
    pr_number: 42,
    repo: 'org/repo',
    pr_url: 'https://github.com/org/repo/pull/42',
    review_session_id: null,
    ...overrides,
  };
}

function makeDeadRow(
  overrides: Partial<DeadSessionAtBoot> = {},
): DeadSessionAtBoot {
  return {
    session_id: 'dead-session-id',
    status: 'starting',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDeadSessionsAtBoot).mockReturnValue([]);
  vi.mocked(getIdleSessionsWithResolvedPRs).mockReturnValue([]);
});

describe('runBootIdleReconciliation — Pass 0 (dead-at-boot)', () => {
  it('does nothing when there are no starting/running sessions at boot', () => {
    vi.mocked(getDeadSessionsAtBoot).mockReturnValue([]);
    runBootIdleReconciliation();
    expect(updateSessionStatus).not.toHaveBeenCalled();
  });

  it('errors a dead session that is not live in SessionManager.sessions', () => {
    vi.mocked(getDeadSessionsAtBoot).mockReturnValue([
      makeDeadRow({ session_id: 'dead-1', status: 'starting' }),
    ]);
    runBootIdleReconciliation(() => false);
    expect(updateSessionStatus).toHaveBeenCalledWith(
      'dead-1',
      'error',
      expect.any(Number),
    );
  });

  it('never transitions a session that is live in SessionManager.sessions to error', () => {
    vi.mocked(getDeadSessionsAtBoot).mockReturnValue([
      makeDeadRow({ session_id: 'resumed-session', status: 'running' }),
    ]);
    // Simulates a session resumeOrphanSessions() just respawned — live in memory.
    runBootIdleReconciliation((sessionId) => sessionId === 'resumed-session');
    expect(updateSessionStatus).not.toHaveBeenCalled();
  });

  it('defaults to treating every row as not-live when no predicate is supplied', () => {
    vi.mocked(getDeadSessionsAtBoot).mockReturnValue([
      makeDeadRow({ session_id: 'dead-2', status: 'starting' }),
    ]);
    runBootIdleReconciliation();
    expect(updateSessionStatus).toHaveBeenCalledWith(
      'dead-2',
      'error',
      expect.any(Number),
    );
  });

  it('errors only the not-live rows out of a mixed batch', () => {
    vi.mocked(getDeadSessionsAtBoot).mockReturnValue([
      makeDeadRow({ session_id: 'live-1', status: 'running' }),
      makeDeadRow({ session_id: 'dead-3', status: 'starting' }),
    ]);
    runBootIdleReconciliation((sessionId) => sessionId === 'live-1');
    expect(updateSessionStatus).toHaveBeenCalledTimes(1);
    expect(updateSessionStatus).toHaveBeenCalledWith(
      'dead-3',
      'error',
      expect.any(Number),
    );
  });
});

describe('runBootIdleReconciliation — Pass 1/2 (idle sessions with resolved PRs)', () => {
  it('does nothing when no idle sessions with resolved PRs', () => {
    vi.mocked(getIdleSessionsWithResolvedPRs).mockReturnValue([]);
    runBootIdleReconciliation();
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(updateSessionStatus).not.toHaveBeenCalled();
  });

  it('concludes coding session idle→done for a merged PR', () => {
    vi.mocked(getIdleSessionsWithResolvedPRs).mockReturnValue([
      makeRow({ pr_state: 'merged', review_session_id: null }),
    ]);
    runBootIdleReconciliation();
    expect(markSessionDone).toHaveBeenCalledWith(
      'coding-session-id',
      expect.any(Number),
      'https://github.com/org/repo/pull/42',
      'boot_idle_merged_pr',
    );
    expect(updateSessionStatus).not.toHaveBeenCalled();
  });

  it('concludes coding session idle→error for a closed PR', () => {
    vi.mocked(getIdleSessionsWithResolvedPRs).mockReturnValue([
      makeRow({ pr_state: 'closed', review_session_id: null }),
    ]);
    runBootIdleReconciliation();
    expect(updateSessionStatus).toHaveBeenCalledWith(
      'coding-session-id',
      'error',
      expect.any(Number),
    );
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('also concludes paired review session idle→done when PR is merged', () => {
    vi.mocked(getIdleSessionsWithResolvedPRs).mockReturnValue([
      makeRow({ pr_state: 'merged', review_session_id: 'review-session-id' }),
    ]);
    runBootIdleReconciliation();
    expect(markSessionDone).toHaveBeenCalledTimes(2);
    expect(markSessionDone).toHaveBeenCalledWith(
      'coding-session-id',
      expect.any(Number),
      'https://github.com/org/repo/pull/42',
      'boot_idle_merged_pr',
    );
    expect(markSessionDone).toHaveBeenCalledWith(
      'review-session-id',
      expect.any(Number),
      'https://github.com/org/repo/pull/42',
      'boot_idle_merged_pr',
    );
  });

  it('also concludes paired review session idle→error when PR is closed', () => {
    vi.mocked(getIdleSessionsWithResolvedPRs).mockReturnValue([
      makeRow({ pr_state: 'closed', review_session_id: 'review-session-id' }),
    ]);
    runBootIdleReconciliation();
    expect(updateSessionStatus).toHaveBeenCalledTimes(2);
    expect(updateSessionStatus).toHaveBeenCalledWith(
      'coding-session-id',
      'error',
      expect.any(Number),
    );
    expect(updateSessionStatus).toHaveBeenCalledWith(
      'review-session-id',
      'error',
      expect.any(Number),
    );
  });

  it('skips review session conclusion when review_session_id is null (merged)', () => {
    vi.mocked(getIdleSessionsWithResolvedPRs).mockReturnValue([
      makeRow({ pr_state: 'merged', review_session_id: null }),
    ]);
    runBootIdleReconciliation();
    expect(markSessionDone).toHaveBeenCalledTimes(1);
    expect(markSessionDone).toHaveBeenCalledWith(
      'coding-session-id',
      expect.any(Number),
      'https://github.com/org/repo/pull/42',
      'boot_idle_merged_pr',
    );
  });

  it('skips review session conclusion when review_session_id is null (closed)', () => {
    vi.mocked(getIdleSessionsWithResolvedPRs).mockReturnValue([
      makeRow({ pr_state: 'closed', review_session_id: null }),
    ]);
    runBootIdleReconciliation();
    expect(updateSessionStatus).toHaveBeenCalledTimes(1);
    expect(updateSessionStatus).toHaveBeenCalledWith(
      'coding-session-id',
      'error',
      expect.any(Number),
    );
  });

  it('after reconciliation no idle review session remains for a merged PR', () => {
    const row = makeRow({
      pr_state: 'merged',
      review_session_id: 'review-session-id',
    });
    vi.mocked(getIdleSessionsWithResolvedPRs).mockReturnValue([row]);

    runBootIdleReconciliation();

    const reviewCalls = vi
      .mocked(markSessionDone)
      .mock.calls.filter((c) => c[0] === 'review-session-id');
    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0][1]).toBeGreaterThan(0);
  });
});
