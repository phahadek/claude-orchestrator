import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../github/PRFileValidator', () => ({
  validatePRFiles: vi.fn().mockReturnValue({ valid: true, bannedFiles: [] }),
}));

vi.mock('../github/PRFileReverter', () => ({
  revertBannedFiles: vi.fn().mockResolvedValue({
    commitSha: null,
    reverted: [],
    syncedTo: null,
  }),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { runFilePollutionCheck } from './filePollutionCheck';
import { validatePRFiles } from '../github/PRFileValidator';
import { revertBannedFiles } from '../github/PRFileReverter';
import { recordEvent } from '../audit/AuditLog';
import type { GitHubClient } from '../github/GitHubClient';

function makeGitHub(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): GitHubClient {
  return {
    fetchPR: vi.fn().mockResolvedValue({ headSha: 'head-sha-1' }),
    getPRFiles: vi.fn().mockResolvedValue(['src/index.ts']),
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

const BASE_OPTS = {
  worktreePath: '/tmp/worktree',
  repo: 'owner/repo',
  prNumber: 42,
  baseBranch: 'dev',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  taskId: 'task-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validatePRFiles).mockReturnValue({ valid: true, bannedFiles: [] });
  vi.mocked(revertBannedFiles).mockResolvedValue({
    commitSha: null,
    reverted: [],
    syncedTo: null,
  });
});

// ── Basic no-violation path ───────────────────────────────────────────────────

describe('runFilePollutionCheck — no violations', () => {
  it('records file_pollution_checked and returns revertCommitSha: null when files are clean', async () => {
    const github = makeGitHub();
    const result = await runFilePollutionCheck({ github, ...BASE_OPTS });

    expect(result.revertCommitSha).toBeNull();
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'file_pollution_checked',
        payload: expect.objectContaining({ banned_files_found: 0 }),
      }),
    );
    expect(vi.mocked(revertBannedFiles)).not.toHaveBeenCalled();
  });

  it('does not call createIssueComment when no files are reverted', async () => {
    const github = makeGitHub();
    await runFilePollutionCheck({ github, ...BASE_OPTS });
    expect(
      vi.mocked(github.createIssueComment as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });
});

// ── Violation + revert path ───────────────────────────────────────────────────

describe('runFilePollutionCheck — banned file found and reverted', () => {
  beforeEach(() => {
    vi.mocked(validatePRFiles).mockReturnValue({
      valid: false,
      bannedFiles: ['CLAUDE.md'],
      reason: 'hard_banned',
    });
    vi.mocked(revertBannedFiles).mockResolvedValue({
      commitSha: 'revert-abc123',
      reverted: ['CLAUDE.md'],
      syncedTo: null,
    });
  });

  it('calls revertBannedFiles with the banned file list', async () => {
    const github = makeGitHub();
    await runFilePollutionCheck({ github, ...BASE_OPTS });

    expect(vi.mocked(revertBannedFiles)).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/tmp/worktree',
        baseBranch: 'dev',
        bannedFiles: ['CLAUDE.md'],
        prNumber: 42,
        repo: 'owner/repo',
      }),
    );
  });

  it('records file_pollution_reverted with correct payload', async () => {
    const github = makeGitHub();
    await runFilePollutionCheck({ github, ...BASE_OPTS });

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'file_pollution_reverted',
        actor_type: 'system',
        actor_id: 'sess-1',
        payload: {
          files: ['CLAUDE.md'],
          pr_number: 42,
          commit_sha: 'revert-abc123',
        },
      }),
    );
  });

  it('returns revertCommitSha from the revert', async () => {
    const github = makeGitHub();
    const result = await runFilePollutionCheck({ github, ...BASE_OPTS });
    expect(result.revertCommitSha).toBe('revert-abc123');
  });

  it('calls onReverted callback with reverted file list', async () => {
    const github = makeGitHub();
    const onReverted = vi.fn();
    await runFilePollutionCheck({ github, ...BASE_OPTS, onReverted });
    expect(onReverted).toHaveBeenCalledWith(['CLAUDE.md']);
  });

  it('posts a GitHub comment containing the reverted filename', async () => {
    const github = makeGitHub();
    await runFilePollutionCheck({ github, ...BASE_OPTS });
    // createIssueComment is called fire-and-forget; give it a tick to resolve
    await Promise.resolve();
    expect(
      vi.mocked(github.createIssueComment as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(
      'owner/repo',
      42,
      expect.stringContaining('CLAUDE.md'),
    );
  });
});

// ── Loop guard ────────────────────────────────────────────────────────────────

describe('runFilePollutionCheck — loop guard', () => {
  it('skips the check when headSha equals lastRevertSha', async () => {
    vi.mocked(validatePRFiles).mockReturnValue({
      valid: false,
      bannedFiles: ['CLAUDE.md'],
      reason: 'hard_banned',
    });

    const github = makeGitHub({
      fetchPR: vi.fn().mockResolvedValue({ headSha: 'revert-sha-fixed' }),
    });

    const result = await runFilePollutionCheck({
      github,
      ...BASE_OPTS,
      lastRevertSha: 'revert-sha-fixed',
    });

    expect(vi.mocked(revertBannedFiles)).not.toHaveBeenCalled();
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
    expect(result.revertCommitSha).toBeNull();
  });

  it('does not skip when headSha differs from lastRevertSha', async () => {
    vi.mocked(validatePRFiles).mockReturnValue({
      valid: false,
      bannedFiles: ['CLAUDE.md'],
      reason: 'hard_banned',
    });
    vi.mocked(revertBannedFiles).mockResolvedValue({
      commitSha: 'new-revert-sha',
      reverted: ['CLAUDE.md'],
      syncedTo: null,
    });

    const github = makeGitHub({
      fetchPR: vi.fn().mockResolvedValue({ headSha: 'session-sha-001' }),
    });

    const result = await runFilePollutionCheck({
      github,
      ...BASE_OPTS,
      lastRevertSha: 'old-revert-sha',
    });

    expect(vi.mocked(revertBannedFiles)).toHaveBeenCalledOnce();
    expect(result.revertCommitSha).toBe('new-revert-sha');
  });

  it('does not skip when lastRevertSha is null', async () => {
    vi.mocked(validatePRFiles).mockReturnValue({
      valid: false,
      bannedFiles: ['CLAUDE.md'],
      reason: 'hard_banned',
    });
    vi.mocked(revertBannedFiles).mockResolvedValue({
      commitSha: 'revert-sha',
      reverted: ['CLAUDE.md'],
      syncedTo: null,
    });

    const github = makeGitHub();
    const result = await runFilePollutionCheck({
      github,
      ...BASE_OPTS,
      lastRevertSha: null,
    });

    expect(vi.mocked(revertBannedFiles)).toHaveBeenCalledOnce();
    expect(result.revertCommitSha).toBe('revert-sha');
  });
});

// ── registerRevertSync callback ───────────────────────────────────────────────

describe('runFilePollutionCheck — registerRevertSync', () => {
  it('calls registerRevertSync before revertBannedFiles', async () => {
    vi.mocked(validatePRFiles).mockReturnValue({
      valid: false,
      bannedFiles: ['CLAUDE.md'],
      reason: 'hard_banned',
    });
    vi.mocked(revertBannedFiles).mockResolvedValue({
      commitSha: 'sha-1',
      reverted: ['CLAUDE.md'],
      syncedTo: null,
    });

    const callOrder: string[] = [];
    const registerRevertSync = vi.fn().mockImplementation(() => {
      callOrder.push('register');
    });
    vi.mocked(revertBannedFiles).mockImplementation(async () => {
      callOrder.push('revert');
      return { commitSha: 'sha-1', reverted: ['CLAUDE.md'], syncedTo: null };
    });

    const github = makeGitHub();
    await runFilePollutionCheck({ github, ...BASE_OPTS, registerRevertSync });

    expect(registerRevertSync).toHaveBeenCalledWith(
      42,
      'owner/repo',
      expect.any(Promise),
    );
    expect(callOrder.indexOf('register')).toBeLessThan(
      callOrder.indexOf('revert'),
    );
  });
});

// ── No-op when revertBannedFiles returns no commit ────────────────────────────

describe('runFilePollutionCheck — revert no-op', () => {
  it('does not record file_pollution_reverted when revertBannedFiles returns null commitSha', async () => {
    vi.mocked(validatePRFiles).mockReturnValue({
      valid: false,
      bannedFiles: ['CLAUDE.md'],
      reason: 'hard_banned',
    });
    vi.mocked(revertBannedFiles).mockResolvedValue({
      commitSha: null,
      reverted: [],
      syncedTo: null,
    });

    const onReverted = vi.fn();
    const github = makeGitHub();
    const result = await runFilePollutionCheck({
      github,
      ...BASE_OPTS,
      onReverted,
    });

    expect(result.revertCommitSha).toBeNull();
    expect(onReverted).not.toHaveBeenCalled();
    const revertedEvents = vi
      .mocked(recordEvent)
      .mock.calls.filter(([e]) => e.event_type === 'file_pollution_reverted');
    expect(revertedEvents).toHaveLength(0);
  });
});

// ── headSha propagated in audit event ────────────────────────────────────────

describe('runFilePollutionCheck — headSha in audit event', () => {
  it('includes headSha from fetchPR in file_pollution_checked event', async () => {
    const github = makeGitHub({
      fetchPR: vi.fn().mockResolvedValue({ headSha: 'expected-sha' }),
    });
    await runFilePollutionCheck({ github, ...BASE_OPTS });

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'file_pollution_checked',
        payload: expect.objectContaining({ head_sha: 'expected-sha' }),
      }),
    );
  });

  it('returns headSha in the result', async () => {
    const github = makeGitHub({
      fetchPR: vi.fn().mockResolvedValue({ headSha: 'result-sha' }),
    });
    const result = await runFilePollutionCheck({ github, ...BASE_OPTS });
    expect(result.headSha).toBe('result-sha');
  });
});

// ── Silent-failure observability ──────────────────────────────────────────────

describe('runFilePollutionCheck — file_pollution_check_failed audit event', () => {
  it('emits file_pollution_check_failed when getPRFiles throws', async () => {
    const error = new Error('GitHub API rate limit');
    const github = makeGitHub({
      getPRFiles: vi.fn().mockRejectedValue(error),
    });

    await runFilePollutionCheck({ github, ...BASE_OPTS });

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'file_pollution_check_failed',
        actor_type: 'system',
        actor_id: 'sess-1',
        project_id: 'proj-1',
        task_id: 'task-1',
        payload: expect.objectContaining({
          pr_number: 42,
          repo: 'owner/repo',
          error: expect.stringContaining('rate limit'),
        }),
      }),
    );
  });

  it('does not emit file_pollution_check_failed on the happy path', async () => {
    const github = makeGitHub();
    await runFilePollutionCheck({ github, ...BASE_OPTS });

    const failedEvents = vi
      .mocked(recordEvent)
      .mock.calls.filter(
        ([e]) => e.event_type === 'file_pollution_check_failed',
      );
    expect(failedEvents).toHaveLength(0);
  });
});
