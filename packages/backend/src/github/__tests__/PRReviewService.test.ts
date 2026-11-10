import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../DiffSource', () => ({ GitHubDiffSource: vi.fn() }));
vi.mock('../../db/queries', () => ({
  getEventsBySession: vi.fn().mockReturnValue([]),
  setPRReviewResult: vi.fn(),
  getPRByNumber: vi.fn(),
  setReviewSessionId: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  incrementReviewIteration: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setLocalBranchReviewResult: vi.fn(),
  getLocalBranchById: vi.fn(),
  getSession: vi.fn(),
  getPRIntentForPR: vi.fn().mockReturnValue(null),
  setPauseReason: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
}));
vi.mock('../../tasks/TaskWriteCommands', () => ({
  getCachedType: vi.fn().mockReturnValue('💻 Code'),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../tasks/TaskBackend', () => ({ getTaskBackend: vi.fn() }));
vi.mock('../../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
  parseExpectedSize: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../GitHubClient', () => ({
  computeSizeSignal: vi.fn().mockReturnValue({ label: 'S', passed: true }),
  isOversized: vi.fn().mockReturnValue(false),
  SIZE_ABSOLUTE_FLOOR: 0,
  SIZE_FILE_RATIO_LIMIT: 0,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { PRReviewService } from '../PRReviewService';
import type { TaskBackend } from '../../tasks/TaskBackend';
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import { getTaskBackend } from '../../tasks/TaskBackend';
import { getPRByNumber, setPauseReason } from '../../db/queries';
import { recordEvent } from '../../audit/AuditLog';
import type { PullRequestRow } from '../../db/types';
import type { DepthReviewService } from '../DepthReviewService';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGithubClient(): GitHubClient {
  return {
    markPRReady: vi.fn().mockResolvedValue(undefined),
    fetchPR: vi.fn(),
    fetchPRDiff: vi.fn(),
    getPRState: vi.fn(),
  } as unknown as GitHubClient;
}

function makeSessionManager(): SessionManager {
  return {} as unknown as SessionManager;
}

function makeTaskBackend(): TaskBackend {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue(''),
    fetchTasks: vi.fn().mockResolvedValue([]),
    type: 'notion',
  } as unknown as TaskBackend;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PRReviewService.handleApprovedVerdict — empty/whitespace projectId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips updateStatus when projectId is empty string and defaultProjectId is empty', async () => {
    const mockBackend = makeTaskBackend();
    const svc = new PRReviewService(
      makeGithubClient(),
      mockBackend,
      makeSessionManager(),
      '', // defaultProjectId = ''
    );

    await svc.handleApprovedVerdict(1, 'org/repo', 'task-123', '');

    expect(mockBackend.updateStatus).not.toHaveBeenCalled();
  });

  it('never calls getTaskBackend with empty string when projectId is empty', async () => {
    // No taskBackendOverride — would use getTaskBackend if the guard were absent
    const svc = new PRReviewService(
      makeGithubClient(),
      undefined, // no override — resolveBackend() calls getTaskBackend()
      makeSessionManager(),
      '',
    );

    await svc.handleApprovedVerdict(1, 'org/repo', 'task-123', '');

    expect(vi.mocked(getTaskBackend)).not.toHaveBeenCalledWith('');
    expect(vi.mocked(getTaskBackend)).not.toHaveBeenCalled();
  });

  it('calls updateStatus with correct args when projectId is valid', async () => {
    const mockBackend = makeTaskBackend();
    const svc = new PRReviewService(
      makeGithubClient(),
      mockBackend,
      makeSessionManager(),
      '',
    );

    await svc.handleApprovedVerdict(1, 'org/repo', 'task-123', 'project-1');

    expect(mockBackend.updateStatus).toHaveBeenCalledWith(
      'task-123',
      '👀 In Review',
    );
  });

  it('falls back to defaultProjectId when projectId is undefined', async () => {
    const mockBackend = makeTaskBackend();
    const svc = new PRReviewService(
      makeGithubClient(),
      mockBackend,
      makeSessionManager(),
      'default-project',
    );

    await svc.handleApprovedVerdict(1, 'org/repo', 'task-123');

    expect(mockBackend.updateStatus).toHaveBeenCalledWith(
      'task-123',
      '👀 In Review',
    );
  });

  it('skips updateStatus when taskId is null even with valid projectId', async () => {
    const mockBackend = makeTaskBackend();
    const svc = new PRReviewService(
      makeGithubClient(),
      mockBackend,
      makeSessionManager(),
      '',
    );

    await svc.handleApprovedVerdict(1, 'org/repo', null, 'project-1');

    expect(mockBackend.updateStatus).not.toHaveBeenCalled();
  });
});

describe('PRReviewService.handleApprovedVerdict — PR no longer open', () => {
  function makeSvc() {
    const mockBackend = makeTaskBackend();
    const github = makeGithubClient();
    const autoMerger = { attempt: vi.fn() };
    const svc = new PRReviewService(
      github,
      mockBackend,
      makeSessionManager(),
      'project-1',
    );
    svc.setDepthReviewService({} as unknown as DepthReviewService);
    (svc as unknown as { autoMerger: unknown }).autoMerger = autoMerger;
    return { svc, mockBackend, github, autoMerger };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['merged', 'closed'] as const)(
    'ignores an approved verdict for a %s PR with no side effects',
    async (state) => {
      vi.mocked(getPRByNumber).mockReturnValue({
        state,
      } as unknown as PullRequestRow);
      const { svc, mockBackend, github, autoMerger } = makeSvc();

      const result = await svc.handleApprovedVerdict(
        1,
        'org/repo',
        'task-123',
        'project-1',
      );

      expect(result).toBe(false);
      expect(mockBackend.updateStatus).not.toHaveBeenCalled();
      expect(setPauseReason).not.toHaveBeenCalled();
      expect(github.markPRReady).not.toHaveBeenCalled();
      expect(autoMerger.attempt).not.toHaveBeenCalled();
      const ignored = vi
        .mocked(recordEvent)
        .mock.calls.filter(
          ([evt]) => evt.event_type === 'review_verdict_ignored_pr_not_open',
        );
      expect(ignored).toHaveLength(1);
      expect(ignored[0][0].payload).toMatchObject({ state });
    },
  );

  it('keeps existing behaviour for an open PR', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      state: 'open',
    } as unknown as PullRequestRow);
    const { svc, mockBackend } = makeSvc();

    const result = await svc.handleApprovedVerdict(
      1,
      'org/repo',
      'task-123',
      'project-1',
    );

    expect(result).toBe(true);
    expect(mockBackend.updateStatus).toHaveBeenCalledWith(
      'task-123',
      '👀 In Review',
    );
    expect(setPauseReason).toHaveBeenCalledWith(
      1,
      'org/repo',
      'depth_review_pending',
    );
    expect(
      vi
        .mocked(recordEvent)
        .mock.calls.some(
          ([evt]) => evt.event_type === 'review_verdict_ignored_pr_not_open',
        ),
    ).toBe(false);
  });
});
