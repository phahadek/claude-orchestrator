import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/queries', () => ({
  getIdleSessionsWithResolvedPRs: vi.fn(),
  markSessionDone: vi.fn(),
  updateSessionStatus: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getIdleSessionsWithResolvedPRs,
  markSessionDone,
  updateSessionStatus,
} from '../../db/queries';
import { runBootIdleReconciliation } from '../bootIdleReconciliation';
import type { IdleSessionWithResolvedPR } from '../../db/queries';

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runBootIdleReconciliation', () => {
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
