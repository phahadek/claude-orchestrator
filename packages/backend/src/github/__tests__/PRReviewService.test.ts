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

    expect(mockBackend.updateStatus).toHaveBeenCalledWith('task-123', '👀 In Review');
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

    expect(mockBackend.updateStatus).toHaveBeenCalledWith('task-123', '👀 In Review');
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
