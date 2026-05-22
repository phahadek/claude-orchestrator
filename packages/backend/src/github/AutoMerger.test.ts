import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must precede imports of the modules under test) ───────────────────

const { projectFixture, runtimeSettingsFixture } = vi.hoisted(() => ({
  projectFixture: {
    id: 'proj-1',
    name: 'Project 1',
    githubRepo: 'owner/repo',
    projectDir: '/tmp',
    contextUrl: 'https://notion.so/ctx',
    boardId: 'board-1',
    taskSource: 'notion' as const,
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: true,
  },
  runtimeSettingsFixture: {
    ci_poll_interval_seconds: 30,
    ci_poll_max_minutes: 30,
  },
}));

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  setPauseReason: vi.fn(),
  updateMergeState: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === 'owner/repo' ? projectFixture : undefined,
  ),
  runtimeSettings: runtimeSettingsFixture,
}));

vi.mock('../routes/tasks.js', () => ({
  emitTaskUpdated: vi.fn(),
}));

import { AutoMerger } from './AutoMerger';
import { getPRByNumber, setPauseReason, updateMergeState } from '../db/queries';
import type { GitHubClient } from './GitHubClient';
import type { PRMergeWatcher } from './PRMergeWatcher';
import type { PullRequestRow } from '../db/types';
import type { MergeabilityCategory } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    notion_task_id: 'task-abc',
    session_id: 'coding-session',
    repo: 'owner/repo',
    title: 'feat: test',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: JSON.stringify({
      verdict: 'approved',
      dimensions: [],
      summary: 'ok',
    }),
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_session_id: 'review-session',
    review_iteration: 1,
    head_sha: 'sha-abc',
    last_reviewed_sha: 'sha-abc',
    node_id: 'PR_node',
    mergeable: 1,
    merge_state: 'clean',
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    ...overrides,
  };
}

function makeMergeability(
  category: MergeabilityCategory['category'],
  failingChecks: Array<{ name: string; conclusion: string }> = [],
): MergeabilityCategory {
  return {
    category,
    mergeState: category === 'clean' ? 'clean' : category,
    rawMergeableState: category === 'clean' ? 'clean' : category,
    failingChecks,
  };
}

function makeMockGitHub(
  pollResults: Array<
    Awaited<ReturnType<GitHubClient['fetchPRStatusConditional']>>
  >,
): GitHubClient {
  const fetchSpy = vi.fn();
  for (const r of pollResults) fetchSpy.mockResolvedValueOnce(r);
  return {
    fetchPRStatusConditional: fetchSpy,
    mergePR: vi
      .fn()
      .mockResolvedValue({ merged: true, message: 'ok', sha: 'merged-sha' }),
    categorizeMergeability: vi
      .fn()
      .mockResolvedValue(makeMergeability('clean')),
  } as unknown as GitHubClient;
}

function makeMockWatcher(): PRMergeWatcher {
  return {
    handleMerged: vi.fn().mockResolvedValue(undefined),
  } as unknown as PRMergeWatcher;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Short intervals so polling tests don't drag.
  runtimeSettingsFixture.ci_poll_interval_seconds = 1;
  runtimeSettingsFixture.ci_poll_max_minutes = 1;
});

// ── attempt() — early-exit guards ────────────────────────────────────────────

describe('AutoMerger.attempt() — guards', () => {
  it('skips when project has autoMergeEnabled=false', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();

    // Re-mock project with disabled flag for this test
    const { getProjectByGithubRepo } = await import('../config.js');
    vi.mocked(getProjectByGithubRepo).mockReturnValueOnce({
      ...projectFixture,
      autoMergeEnabled: false,
    });

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.fetchPRStatusConditional).not.toHaveBeenCalled();
    expect(github.mergePR).not.toHaveBeenCalled();
  });

  it('skips when PR has a pre-existing pause_reason', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({ pause_reason: 'stuck_timeout' }),
    );
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.fetchPRStatusConditional).not.toHaveBeenCalled();
  });

  it('proceeds into polling loop when bypassToggle=true and autoMergeEnabled=false', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const { getProjectByGithubRepo } = await import('../config.js');
    vi.mocked(getProjectByGithubRepo).mockReturnValueOnce({
      ...projectFixture,
      autoMergeEnabled: false,
    });

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo', { bypassToggle: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(github.mergePR).toHaveBeenCalledTimes(1);
    expect(watcher.handleMerged).toHaveBeenCalled();
  });

  it('skips polling when autoMergeEnabled=false and no bypassToggle (regression guard)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();

    const { getProjectByGithubRepo } = await import('../config.js');
    vi.mocked(getProjectByGithubRepo).mockReturnValueOnce({
      ...projectFixture,
      autoMergeEnabled: false,
    });

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.fetchPRStatusConditional).not.toHaveBeenCalled();
    expect(github.mergePR).not.toHaveBeenCalled();
  });

  it('de-duplicates concurrent attempt() calls for the same PR', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    merger.attempt(42, 'owner/repo'); // duplicate — should be ignored
    await new Promise((r) => setTimeout(r, 50));

    expect(github.mergePR).toHaveBeenCalledTimes(1);
  });
});

// ── attempt() — CI green path ────────────────────────────────────────────────

describe('AutoMerger.attempt() — CI green', () => {
  it('squash-merges and delegates to PRMergeWatcher.handleMerged on clean', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.mergePR).toHaveBeenCalledWith(42, 'feat: test', 'owner/repo');
    expect(watcher.handleMerged).toHaveBeenCalled();
    expect(setPauseReason).not.toHaveBeenCalled();
  });
});

// ── attempt() — CI red and other failure modes ───────────────────────────────

describe('AutoMerger.attempt() — failure modes', () => {
  it('pauses with ci_failing on ci_failed category', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('ci_failed'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).toHaveBeenCalledWith(42, 'owner/repo', 'ci_failing');
    expect(github.mergePR).not.toHaveBeenCalled();
  });

  it('pauses with pr_closed when PR state becomes closed during polling', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'closed',
        mergeability: makeMergeability('unknown'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).toHaveBeenCalledWith(42, 'owner/repo', 'pr_closed');
    expect(github.mergePR).not.toHaveBeenCalled();
  });

  it('pauses with auto_merge_failed on blocked category', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('blocked'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'auto_merge_failed',
    );
    expect(updateMergeState).toHaveBeenCalled();
  });

  it('leaves conflict category to existing handling (no pause_reason set)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('conflict'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).not.toHaveBeenCalled();
    expect(github.mergePR).not.toHaveBeenCalled();
  });

  it('populates failing_checks in DB when ci_failed category has failing check names', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('ci_failed', [
          { name: 'lint', conclusion: 'failure' },
          { name: 'unit-tests', conclusion: 'failure' },
        ]),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).toHaveBeenCalledWith(42, 'owner/repo', 'ci_failing');
    expect(updateMergeState).toHaveBeenCalledWith(
      42,
      'owner/repo',
      0,
      'ci_failed',
      ['lint', 'unit-tests'],
    );
  });
});
