import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  updatePRState: vi.fn(),
}));

import { PRMergeWatcher } from './PRMergeWatcher';
import { getAllOpenPRs, updatePRState } from '../db/queries';
import type { GitHubClient } from './GitHubClient';
import type { SessionManager } from '../session/SessionManager';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow } from '../db/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockGitHub(): GitHubClient {
  return {
    getPRState: vi.fn().mockResolvedValue('open'),
  } as unknown as GitHubClient;
}

function makeMockSessions(): SessionManager {
  return {
    kill: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager;
}

function makeMockNotion(): NotionClient {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotionClient;
}

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
    review_result: JSON.stringify({ verdict: 'approved', dimensions: [], summary: 'Looks good' }),
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_session_id: 'review-session',
    review_iteration: 1,
    head_sha: null,
    last_reviewed_sha: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── poll() ────────────────────────────────────────────────────────────────────

describe('PRMergeWatcher.poll()', () => {
  it('does not call getPRState when there are no open PRs', async () => {
    vi.mocked(getAllOpenPRs).mockReturnValue([]);
    const github = makeMockGitHub();

    const watcher = new PRMergeWatcher(github, makeMockSessions(), makeMockNotion(), () => {});
    await watcher.poll();

    expect(vi.mocked(github.getPRState)).not.toHaveBeenCalled();
  });

  it('calls getPRState for each open PR', async () => {
    const pr = makePRRow();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();

    const watcher = new PRMergeWatcher(github, makeMockSessions(), makeMockNotion(), () => {});
    await watcher.poll();

    expect(vi.mocked(github.getPRState)).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('checks PRs with no review verdict (review_result IS NULL)', async () => {
    const pr = makePRRow({ review_result: null });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();

    const watcher = new PRMergeWatcher(github, makeMockSessions(), makeMockNotion(), () => {});
    await watcher.poll();

    expect(vi.mocked(github.getPRState)).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('checks PRs with needs_changes verdict', async () => {
    const pr = makePRRow({ review_result: JSON.stringify({ verdict: 'needs_changes', dimensions: [], summary: 'Fix required' }) });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();

    const watcher = new PRMergeWatcher(github, makeMockSessions(), makeMockNotion(), () => {});
    await watcher.poll();

    expect(vi.mocked(github.getPRState)).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('checks PRs with error verdict', async () => {
    const pr = makePRRow({ review_result: JSON.stringify({ verdict: 'error', dimensions: [], summary: 'Review failed' }) });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();

    const watcher = new PRMergeWatcher(github, makeMockSessions(), makeMockNotion(), () => {});
    await watcher.poll();

    expect(vi.mocked(github.getPRState)).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('merged PR without approved verdict still triggers session kill and Notion update', async () => {
    const pr = makePRRow({ review_result: null, session_id: 'coding-session', review_session_id: 'review-session' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue('merged');
    const sessions = makeMockSessions();
    const notion = makeMockNotion();

    const watcher = new PRMergeWatcher(github, sessions, notion, () => {});
    await watcher.poll();

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(42, 'owner/repo', 'merged');
    expect(vi.mocked(sessions.kill)).toHaveBeenCalledWith('coding-session');
    expect(vi.mocked(sessions.kill)).toHaveBeenCalledWith('review-session');
    expect(vi.mocked(notion.updateStatus)).toHaveBeenCalledWith('task-abc', '✅ Done');
  });

  it('merged PR with needs_changes verdict triggers session kill and Notion update', async () => {
    const pr = makePRRow({ review_result: JSON.stringify({ verdict: 'needs_changes' }) });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue('merged');
    const sessions = makeMockSessions();
    const notion = makeMockNotion();

    const watcher = new PRMergeWatcher(github, sessions, notion, () => {});
    await watcher.poll();

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(42, 'owner/repo', 'merged');
    expect(vi.mocked(sessions.kill)).toHaveBeenCalledWith('coding-session');
    expect(vi.mocked(notion.updateStatus)).toHaveBeenCalledWith('task-abc', '✅ Done');
  });

  it('calls handleMerged when GitHub state is merged', async () => {
    const pr = makePRRow();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue('merged');
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(github, sessions, makeMockNotion(), () => {});
    await watcher.poll();

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(42, 'owner/repo', 'merged');
    expect(vi.mocked(sessions.kill)).toHaveBeenCalledWith('coding-session');
    expect(vi.mocked(sessions.kill)).toHaveBeenCalledWith('review-session');
  });

  it('broadcasts pr_closed and updates state when GitHub state is closed', async () => {
    const pr = makePRRow();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue('closed');

    const messages: ServerMessage[] = [];
    const watcher = new PRMergeWatcher(github, makeMockSessions(), makeMockNotion(), (msg) => messages.push(msg));
    await watcher.poll();

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(42, 'owner/repo', 'closed');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'pr_closed', prNumber: 42, repo: 'owner/repo' });
  });
});

// ── handleMerged() ────────────────────────────────────────────────────────────

describe('PRMergeWatcher.handleMerged()', () => {
  it('updates PR state to merged', async () => {
    const pr = makePRRow();
    const watcher = new PRMergeWatcher(makeMockGitHub(), makeMockSessions(), makeMockNotion(), () => {});
    await watcher.handleMerged(pr, 'abc123');

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(42, 'owner/repo', 'merged');
  });

  it('broadcasts pr_merged with sha', async () => {
    const pr = makePRRow();
    const messages: ServerMessage[] = [];
    const watcher = new PRMergeWatcher(makeMockGitHub(), makeMockSessions(), makeMockNotion(), (msg) => messages.push(msg));
    await watcher.handleMerged(pr, 'deadbeef');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'pr_merged', prNumber: 42, repo: 'owner/repo', sha: 'deadbeef' });
  });

  it('calls NotionClient.updateStatus with Done', async () => {
    const pr = makePRRow({ notion_task_id: 'task-xyz' });
    const notion = makeMockNotion();
    const watcher = new PRMergeWatcher(makeMockGitHub(), makeMockSessions(), notion, () => {});
    await watcher.handleMerged(pr, null);

    expect(vi.mocked(notion.updateStatus)).toHaveBeenCalledWith('task-xyz', '✅ Done');
  });
});
