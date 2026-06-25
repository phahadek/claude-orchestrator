import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/queries', () => ({
  getIdleSessionsWithResolvedPRs: vi.fn(),
  markSessionDone: vi.fn(),
  updateSessionStatus: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Subject ───────────────────────────────────────────────────────────────────

import * as queries from '../../db/queries';
import { runBootIdleReconciliation } from '../bootIdleReconciliation';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runBootIdleReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when no idle sessions with resolved PRs exist', () => {
    vi.mocked(queries.getIdleSessionsWithResolvedPRs).mockReturnValue([]);
    runBootIdleReconciliation();
    expect(queries.markSessionDone).not.toHaveBeenCalled();
    expect(queries.updateSessionStatus).not.toHaveBeenCalled();
  });

  it('concludes coding session idle→done for a merged PR without review session', () => {
    vi.mocked(queries.getIdleSessionsWithResolvedPRs).mockReturnValue([
      {
        session_id: 'coding-session-id',
        task_id: 'task-1',
        project_id: 'proj-1',
        pr_state: 'merged',
        pr_number: 42,
        repo: 'owner/repo',
        pr_url: 'https://github.com/owner/repo/pull/42',
        review_session_id: null,
      },
    ]);

    runBootIdleReconciliation();

    expect(queries.markSessionDone).toHaveBeenCalledWith(
      'coding-session-id',
      expect.any(Number),
      'https://github.com/owner/repo/pull/42',
      'boot_idle_merged_pr',
    );
    expect(queries.markSessionDone).toHaveBeenCalledTimes(1);
    expect(queries.updateSessionStatus).not.toHaveBeenCalled();
  });

  it('concludes both coding and review sessions idle→done for a merged PR', () => {
    vi.mocked(queries.getIdleSessionsWithResolvedPRs).mockReturnValue([
      {
        session_id: 'coding-session-id',
        task_id: 'task-1',
        project_id: 'proj-1',
        pr_state: 'merged',
        pr_number: 42,
        repo: 'owner/repo',
        pr_url: 'https://github.com/owner/repo/pull/42',
        review_session_id: 'review-session-id',
      },
    ]);

    runBootIdleReconciliation();

    expect(queries.markSessionDone).toHaveBeenCalledTimes(2);
    expect(queries.markSessionDone).toHaveBeenCalledWith(
      'coding-session-id',
      expect.any(Number),
      'https://github.com/owner/repo/pull/42',
      'boot_idle_merged_pr',
    );
    expect(queries.markSessionDone).toHaveBeenCalledWith(
      'review-session-id',
      expect.any(Number),
      'https://github.com/owner/repo/pull/42',
      'boot_idle_merged_pr',
    );
    expect(queries.updateSessionStatus).not.toHaveBeenCalled();
  });

  it('concludes coding session idle→error for a closed PR without review session', () => {
    vi.mocked(queries.getIdleSessionsWithResolvedPRs).mockReturnValue([
      {
        session_id: 'coding-session-id',
        task_id: 'task-1',
        project_id: 'proj-1',
        pr_state: 'closed',
        pr_number: 99,
        repo: 'owner/repo',
        pr_url: 'https://github.com/owner/repo/pull/99',
        review_session_id: null,
      },
    ]);

    runBootIdleReconciliation();

    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'coding-session-id',
      'error',
      expect.any(Number),
    );
    expect(queries.updateSessionStatus).toHaveBeenCalledTimes(1);
    expect(queries.markSessionDone).not.toHaveBeenCalled();
  });

  it('concludes both coding and review sessions idle→error for a closed PR', () => {
    vi.mocked(queries.getIdleSessionsWithResolvedPRs).mockReturnValue([
      {
        session_id: 'coding-session-id',
        task_id: 'task-1',
        project_id: 'proj-1',
        pr_state: 'closed',
        pr_number: 99,
        repo: 'owner/repo',
        pr_url: 'https://github.com/owner/repo/pull/99',
        review_session_id: 'review-session-id',
      },
    ]);

    runBootIdleReconciliation();

    expect(queries.updateSessionStatus).toHaveBeenCalledTimes(2);
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'coding-session-id',
      'error',
      expect.any(Number),
    );
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'review-session-id',
      'error',
      expect.any(Number),
    );
    expect(queries.markSessionDone).not.toHaveBeenCalled();
  });

  it('handles null review_session_id without error', () => {
    vi.mocked(queries.getIdleSessionsWithResolvedPRs).mockReturnValue([
      {
        session_id: 'coding-session-id',
        task_id: 'task-1',
        project_id: 'proj-1',
        pr_state: 'merged',
        pr_number: 7,
        repo: 'owner/repo',
        pr_url: 'https://github.com/owner/repo/pull/7',
        review_session_id: null,
      },
    ]);

    expect(() => runBootIdleReconciliation()).not.toThrow();
    expect(queries.markSessionDone).toHaveBeenCalledTimes(1);
  });

  it('processes multiple rows and leaves no idle sessions', () => {
    vi.mocked(queries.getIdleSessionsWithResolvedPRs).mockReturnValue([
      {
        session_id: 'session-merged',
        task_id: 'task-1',
        project_id: 'proj-1',
        pr_state: 'merged',
        pr_number: 1,
        repo: 'owner/repo',
        pr_url: 'https://github.com/owner/repo/pull/1',
        review_session_id: 'review-merged',
      },
      {
        session_id: 'session-closed',
        task_id: 'task-2',
        project_id: 'proj-1',
        pr_state: 'closed',
        pr_number: 2,
        repo: 'owner/repo',
        pr_url: 'https://github.com/owner/repo/pull/2',
        review_session_id: 'review-closed',
      },
    ]);

    runBootIdleReconciliation();

    expect(queries.markSessionDone).toHaveBeenCalledTimes(2);
    expect(queries.markSessionDone).toHaveBeenCalledWith(
      'session-merged',
      expect.any(Number),
      'https://github.com/owner/repo/pull/1',
      'boot_idle_merged_pr',
    );
    expect(queries.markSessionDone).toHaveBeenCalledWith(
      'review-merged',
      expect.any(Number),
      'https://github.com/owner/repo/pull/1',
      'boot_idle_merged_pr',
    );

    expect(queries.updateSessionStatus).toHaveBeenCalledTimes(2);
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'session-closed',
      'error',
      expect.any(Number),
    );
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'review-closed',
      'error',
      expect.any(Number),
    );
  });
});
