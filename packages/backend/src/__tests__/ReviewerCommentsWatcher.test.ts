import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must precede imports of the modules under test) ───────────────────

vi.mock('../db/queries.js', () => ({
  getAllOpenPRs: vi.fn(),
  getRoutedCommentIds: vi.fn(),
  markCommentsPending: vi.fn(),
  enqueueFeedbackItem: vi.fn(),
  setPauseReason: vi.fn(),
  getSession: vi.fn(),
  getSetting: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn().mockReturnValue({ id: 'proj-1' }),
}));

import {
  getAllOpenPRs,
  getRoutedCommentIds,
  markCommentsPending,
  enqueueFeedbackItem,
  setPauseReason,
  getSession,
  getSetting,
} from '../db/queries.js';
import {
  ReviewerCommentsWatcher,
  isBotAuthor,
} from '../github/ReviewerCommentsWatcher.js';
import type { PullRequestRow } from '../db/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePR(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: null,
    session_id: 'session-abc',
    repo: 'owner/repo',
    title: 'Test PR',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    synced_at: '2026-01-01T00:00:00Z',
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'abc123',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    ...overrides,
  };
}

function makeGitHub(
  overrides: {
    reviews?: Awaited<
      ReturnType<
        InstanceType<
          typeof import('../github/GitHubClient.js').GitHubClient
        >['listPRReviews']
      >
    >;
    reviewComments?: Awaited<
      ReturnType<
        InstanceType<
          typeof import('../github/GitHubClient.js').GitHubClient
        >['listPRReviewComments']
      >
    >;
    issueComments?: Awaited<
      ReturnType<
        InstanceType<
          typeof import('../github/GitHubClient.js').GitHubClient
        >['listPRIssueComments']
      >
    >;
  } = {},
) {
  return {
    listPRReviews: vi.fn().mockResolvedValue(overrides.reviews ?? []),
    listPRReviewComments: vi
      .fn()
      .mockResolvedValue(overrides.reviewComments ?? []),
    listPRIssueComments: vi
      .fn()
      .mockResolvedValue(overrides.issueComments ?? []),
  };
}

function makeSessionManager(
  overrides: {
    send?: ReturnType<typeof vi.fn>;
    sendOrResume?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    send: overrides.send ?? vi.fn(),
    sendOrResume:
      overrides.sendOrResume ?? vi.fn().mockResolvedValue('session-abc'),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSetting).mockReturnValue(undefined);
  vi.mocked(getRoutedCommentIds).mockReturnValue(new Set());
  vi.mocked(getSession).mockReturnValue({
    session_id: 'session-abc',
    status: 'running',
  } as unknown as ReturnType<typeof import('../db/queries.js').getSession>);
});

// ── Quiescence buffer ─────────────────────────────────────────────────────────

describe('quiescence buffer', () => {
  it('does not enqueue until the quiescence window elapses', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
    const github = makeGitHub({
      issueComments: [
        {
          id: 1,
          author: 'alice',
          authorType: 'User',
          body: 'LGTM',
          createdAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );

    await watcher.pollAll();

    // Before window elapses: nothing enqueued, nothing marked pending
    expect(enqueueFeedbackItem).not.toHaveBeenCalled();
    expect(markCommentsPending).not.toHaveBeenCalled();

    // After window elapses: one inbox item enqueued
    await vi.advanceTimersByTimeAsync(120_001);

    expect(enqueueFeedbackItem).toHaveBeenCalledOnce();
    const [sid, source, payload] = vi.mocked(enqueueFeedbackItem).mock
      .calls[0] as [string, string, string];
    expect(sid).toBe('session-abc');
    expect(source).toBe('human:alice');
    expect(payload).toContain('LGTM');

    vi.useRealTimers();
  });

  it('resets the window on each new comment from the same source', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub();
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );

    // Poll 1: alice leaves comment 1
    vi.mocked(github.listPRIssueComments).mockResolvedValueOnce([
      { id: 1, author: 'alice', authorType: 'User', body: 'first', createdAt: '' },
    ]);
    await watcher.pollAll();

    // Advance 60s (window not yet expired)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enqueueFeedbackItem).not.toHaveBeenCalled();

    // Poll 2: alice leaves comment 2 — window resets
    vi.mocked(github.listPRIssueComments).mockResolvedValueOnce([
      { id: 1, author: 'alice', authorType: 'User', body: 'first', createdAt: '' },
      { id: 2, author: 'alice', authorType: 'User', body: 'second', createdAt: '' },
    ]);
    await watcher.pollAll();

    // Another 60s (only 60s into new window — still not expired)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enqueueFeedbackItem).not.toHaveBeenCalled();

    // Full 120s from the last comment — now flushes
    await vi.advanceTimersByTimeAsync(60_001);
    expect(enqueueFeedbackItem).toHaveBeenCalledOnce();

    const [, , payload] = vi.mocked(enqueueFeedbackItem).mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(payload).toContain('first');
    expect(payload).toContain('second');

    vi.useRealTimers();
  });

  it('flushes as ONE batch per source even when comments arrive across multiple polls', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub();
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );

    vi.mocked(github.listPRIssueComments).mockResolvedValueOnce([
      { id: 10, author: 'bob', authorType: 'User', body: 'comment A', createdAt: '' },
    ]);
    await watcher.pollAll();

    vi.mocked(github.listPRIssueComments).mockResolvedValueOnce([
      { id: 10, author: 'bob', authorType: 'User', body: 'comment A', createdAt: '' },
      { id: 11, author: 'bob', authorType: 'User', body: 'comment B', createdAt: '' },
    ]);
    await watcher.pollAll();

    await vi.advanceTimersByTimeAsync(120_001);

    // Exactly one inbox item — both comments in the same batch
    expect(enqueueFeedbackItem).toHaveBeenCalledOnce();
    const [, source, payload] = vi.mocked(enqueueFeedbackItem).mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(source).toBe('human:bob');
    expect(payload).toContain('comment A');
    expect(payload).toContain('comment B');

    vi.useRealTimers();
  });

  it('sends separate inbox items for different sources', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub({
      issueComments: [
        { id: 1, author: 'alice', authorType: 'User', body: 'Alice note', createdAt: '' },
        { id: 2, author: 'bob', authorType: 'User', body: 'Bob note', createdAt: '' },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );

    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);

    expect(enqueueFeedbackItem).toHaveBeenCalledTimes(2);
    const sources = vi
      .mocked(enqueueFeedbackItem)
      .mock.calls.map((c) => (c as [string, string, string])[1]);
    expect(sources).toContain('human:alice');
    expect(sources).toContain('human:bob');

    vi.useRealTimers();
  });
});

// ── Review grouping ───────────────────────────────────────────────────────────

describe('review grouping', () => {
  it('groups inline comments under their parent review by pull_request_review_id', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub({
      reviews: [
        {
          id: 99,
          state: 'CHANGES_REQUESTED',
          author: 'alice',
          authorType: 'User',
          body: 'Please fix the logic',
          submittedAt: '',
        },
      ],
      reviewComments: [
        {
          id: 201,
          author: 'alice',
          authorType: 'User',
          body: 'This line is wrong',
          createdAt: '',
          path: 'src/foo.ts',
          line: 10,
          pullRequestReviewId: 99,
        },
        {
          id: 202,
          author: 'alice',
          authorType: 'User',
          body: 'Also fix this',
          createdAt: '',
          path: 'src/bar.ts',
          line: 5,
          pullRequestReviewId: 99,
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );

    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);

    expect(enqueueFeedbackItem).toHaveBeenCalledOnce();
    const payload = (vi.mocked(enqueueFeedbackItem).mock.calls[0] as [
      string,
      string,
      string,
    ])[2];
    // Review body comes before inline comments
    const reviewIdx = payload.indexOf('Please fix the logic');
    const inline1Idx = payload.indexOf('This line is wrong');
    const inline2Idx = payload.indexOf('Also fix this');
    expect(reviewIdx).toBeLessThan(inline1Idx);
    expect(reviewIdx).toBeLessThan(inline2Idx);
    // Inline comments reference their file locations
    expect(payload).toContain('src/foo.ts:10');
    expect(payload).toContain('src/bar.ts:5');

    vi.useRealTimers();
  });
});

// ── Dedup / mark-only-on-flush ────────────────────────────────────────────────

describe('comments are marked pending only on flush', () => {
  it('does not call markCommentsPending during the quiescence window', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
    const github = makeGitHub({
      issueComments: [
        { id: 5, author: 'alice', authorType: 'User', body: 'hello', createdAt: '' },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );

    await watcher.pollAll();
    expect(markCommentsPending).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_001);
    expect(markCommentsPending).toHaveBeenCalledOnce();
    expect(markCommentsPending).toHaveBeenCalledWith(42, 'owner/repo', ['ic_5']);

    vi.useRealTimers();
  });

  it('a mid-window poll re-discovers the same comment (not yet in DB) and deduplicates in buffer', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub();
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );

    // Both polls see the same comment (not yet routed in DB)
    vi.mocked(github.listPRIssueComments).mockResolvedValue([
      { id: 7, author: 'alice', authorType: 'User', body: 'please fix', createdAt: '' },
    ]);

    await watcher.pollAll();
    await watcher.pollAll(); // re-discovers ic_7 — buffer must not duplicate it

    await vi.advanceTimersByTimeAsync(120_001);

    // Still exactly ONE inbox item, with ONE comment (not duplicated)
    expect(enqueueFeedbackItem).toHaveBeenCalledOnce();
    expect(markCommentsPending).toHaveBeenCalledWith(42, 'owner/repo', ['ic_7']);

    vi.useRealTimers();
  });
});

// ── Existing filter behaviour (unchanged) ─────────────────────────────────────

describe('new human comments reach the inbox', () => {
  it('aggregates review body, review comments, and issue comments into one inbox item', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub({
      reviews: [
        {
          id: 1,
          state: 'COMMENTED',
          author: 'alice',
          authorType: 'User',
          body: 'Looks good overall',
          submittedAt: '',
        },
      ],
      reviewComments: [
        {
          id: 10,
          author: 'alice',
          authorType: 'User',
          body: 'Fix this line',
          createdAt: '',
          path: 'src/foo.ts',
          line: 5,
          pullRequestReviewId: null,
        },
      ],
      issueComments: [
        {
          id: 20,
          author: 'alice',
          authorType: 'User',
          body: 'Please update the README',
          createdAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );

    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);

    // All three alice comments → one inbox item
    expect(enqueueFeedbackItem).toHaveBeenCalledOnce();
    const [sessionId, source, payload] = vi.mocked(enqueueFeedbackItem).mock
      .calls[0] as [string, string, string];
    expect(sessionId).toBe('session-abc');
    expect(source).toBe('human:alice');
    expect(payload).toContain('PR #42');
    expect(payload).toContain('Looks good overall');
    expect(payload).toContain('Fix this line');
    expect(payload).toContain('Please update the README');

    vi.useRealTimers();
  });

  it('skips PRs without a session_id', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR({ session_id: null })]);
    const github = makeGitHub();
    await new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    ).pollAll();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(enqueueFeedbackItem).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('skips PRs paused for non-watchable reasons', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([
      makePR({ pause_reason: 'ci_failing' }),
    ]);
    const github = makeGitHub({
      reviewComments: [
        {
          id: 1,
          author: 'alice',
          authorType: 'User',
          body: 'hello',
          createdAt: '',
          path: null,
          line: null,
          pullRequestReviewId: null,
        },
      ],
    });
    await new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    ).pollAll();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(enqueueFeedbackItem).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('AI-authored comments are filtered out', () => {
  it('does not route comments authored by ai_reviewer_usernames', async () => {
    vi.useFakeTimers();
    vi.mocked(getSetting).mockReturnValue(JSON.stringify(['ai-reviewer-bot']));
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub({
      reviews: [
        {
          id: 1,
          state: 'COMMENTED',
          author: 'ai-reviewer-bot',
          authorType: 'User',
          body: 'AI comment',
          submittedAt: '',
        },
        {
          id: 2,
          state: 'COMMENTED',
          author: 'human-dev',
          authorType: 'User',
          body: 'Human comment',
          submittedAt: '',
        },
      ],
      reviewComments: [
        {
          id: 10,
          author: 'ai-reviewer-bot',
          authorType: 'User',
          body: 'AI inline',
          createdAt: '',
          path: 'x.ts',
          line: 1,
          pullRequestReviewId: null,
        },
      ],
      issueComments: [
        {
          id: 20,
          author: 'ai-reviewer-bot',
          authorType: 'User',
          body: 'AI issue comment',
          createdAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);

    expect(enqueueFeedbackItem).toHaveBeenCalledOnce();
    const payload = (vi.mocked(enqueueFeedbackItem).mock.calls[0] as [
      string,
      string,
      string,
    ])[2];
    expect(payload).toContain('Human comment');
    expect(payload).not.toContain('AI comment');
    expect(payload).not.toContain('AI inline');
    expect(payload).not.toContain('AI issue comment');

    vi.useRealTimers();
  });

  it('does not route anything when all comments are AI-authored', async () => {
    vi.useFakeTimers();
    vi.mocked(getSetting).mockReturnValue(JSON.stringify(['bot']));
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
    const github = makeGitHub({
      reviews: [
        {
          id: 1,
          state: 'COMMENTED',
          author: 'bot',
          authorType: 'User',
          body: 'AI says hi',
          submittedAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(enqueueFeedbackItem).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe('bot-authored comments are filtered out', () => {
  it('does not route a comment authored by github-actions[bot] (login ends with [bot])', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub({
      issueComments: [
        {
          id: 1,
          author: 'github-actions[bot]',
          authorType: 'Bot',
          body: 'CI failed on branch',
          createdAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(enqueueFeedbackItem).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('does not route a comment authored by a Bot-type account', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub({
      reviewComments: [
        {
          id: 2,
          author: 'some-automation',
          authorType: 'Bot',
          body: 'Automated check result',
          createdAt: '',
          path: 'src/index.ts',
          line: 10,
          pullRequestReviewId: null,
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(enqueueFeedbackItem).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('still routes a human-authored comment while filtering bot comments', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub({
      issueComments: [
        {
          id: 1,
          author: 'github-actions[bot]',
          authorType: 'Bot',
          body: 'Bot noise',
          createdAt: '',
        },
        {
          id: 2,
          author: 'alice',
          authorType: 'User',
          body: 'Human feedback',
          createdAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);

    expect(enqueueFeedbackItem).toHaveBeenCalledOnce();
    const payload = (vi.mocked(enqueueFeedbackItem).mock.calls[0] as [
      string,
      string,
      string,
    ])[2];
    expect(payload).toContain('Human feedback');
    expect(payload).not.toContain('Bot noise');

    vi.useRealTimers();
  });

  it('deny-list suppresses a named non-bot author', async () => {
    vi.useFakeTimers();
    vi.mocked(getSetting).mockImplementation((key: string) => {
      if (key === 'bot_comment_deny_list') return JSON.stringify(['renovate']);
      return undefined;
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub({
      issueComments: [
        {
          id: 1,
          author: 'renovate',
          authorType: 'User',
          body: 'Dependency update available',
          createdAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(enqueueFeedbackItem).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('allow-list overrides bot filter for a bot-login author', async () => {
    vi.useFakeTimers();
    vi.mocked(getSetting).mockImplementation((key: string) => {
      if (key === 'bot_comment_allow_list')
        return JSON.stringify(['trusted-bot[bot]']);
      return undefined;
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    const github = makeGitHub({
      issueComments: [
        {
          id: 1,
          author: 'trusted-bot[bot]',
          authorType: 'Bot',
          body: 'Trusted automation comment',
          createdAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);

    expect(enqueueFeedbackItem).toHaveBeenCalledOnce();
    const payload = (vi.mocked(enqueueFeedbackItem).mock.calls[0] as [
      string,
      string,
      string,
    ])[2];
    expect(payload).toContain('Trusted automation comment');

    vi.useRealTimers();
  });
});

describe('already-routed comments are not re-sent', () => {
  it('skips comment IDs present in getRoutedCommentIds()', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
    vi.mocked(getRoutedCommentIds).mockReturnValue(
      new Set(['rv_1', 'rc_10', 'ic_20']),
    );

    const github = makeGitHub({
      reviews: [
        {
          id: 1,
          state: 'COMMENTED',
          author: 'alice',
          authorType: 'User',
          body: 'Already sent review',
          submittedAt: '',
        },
      ],
      reviewComments: [
        {
          id: 10,
          author: 'alice',
          authorType: 'User',
          body: 'Already sent inline',
          createdAt: '',
          path: 'x.ts',
          line: 1,
          pullRequestReviewId: null,
        },
      ],
      issueComments: [
        {
          id: 20,
          author: 'alice',
          authorType: 'User',
          body: 'Already sent issue',
          createdAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(enqueueFeedbackItem).not.toHaveBeenCalled();
    expect(markCommentsPending).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('only sends new comments when some are already routed', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
    vi.mocked(getRoutedCommentIds).mockReturnValue(new Set(['rv_1']));

    const github = makeGitHub({
      reviews: [
        {
          id: 1,
          state: 'COMMENTED',
          author: 'alice',
          authorType: 'User',
          body: 'Old review body',
          submittedAt: '',
        },
        {
          id: 2,
          state: 'COMMENTED',
          author: 'alice',
          authorType: 'User',
          body: 'New review body',
          submittedAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);

    expect(enqueueFeedbackItem).toHaveBeenCalledOnce();
    const payload = (vi.mocked(enqueueFeedbackItem).mock.calls[0] as [
      string,
      string,
      string,
    ])[2];
    expect(payload).toContain('New review body');
    expect(payload).not.toContain('Old review body');
    expect(markCommentsPending).toHaveBeenCalledWith(42, 'owner/repo', ['rv_2']);

    vi.useRealTimers();
  });
});

describe('CHANGES_REQUESTED clears awaiting_human_approval', () => {
  it('transitions awaiting_human_approval → human_changes_requested when CHANGES_REQUESTED review found', async () => {
    vi.useFakeTimers();
    const pr = makePR({ pause_reason: 'awaiting_human_approval' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);

    const github = makeGitHub({
      reviews: [
        {
          id: 1,
          state: 'CHANGES_REQUESTED',
          author: 'alice',
          authorType: 'User',
          body: 'Please fix tests',
          submittedAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();

    // setPauseReason happens immediately (not deferred)
    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'human_changes_requested',
    );

    vi.useRealTimers();
  });

  it('does NOT transition when review state is COMMENTED (not CHANGES_REQUESTED)', async () => {
    vi.useFakeTimers();
    const pr = makePR({ pause_reason: 'awaiting_human_approval' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);

    const github = makeGitHub({
      reviews: [
        {
          id: 1,
          state: 'COMMENTED',
          author: 'alice',
          authorType: 'User',
          body: 'LGTM mostly',
          submittedAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();

    expect(setPauseReason).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('does NOT transition when CHANGES_REQUESTED is from an AI reviewer', async () => {
    vi.useFakeTimers();
    vi.mocked(getSetting).mockReturnValue(JSON.stringify(['ai-bot']));
    const pr = makePR({ pause_reason: 'awaiting_human_approval' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);

    const github = makeGitHub({
      reviews: [
        {
          id: 1,
          state: 'CHANGES_REQUESTED',
          author: 'ai-bot',
          authorType: 'User',
          body: 'AI says fix it',
          submittedAt: '',
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();

    expect(setPauseReason).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe('dead session handling', () => {
  it('discards the buffered batch when session is done at flush time', async () => {
    vi.useFakeTimers();
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
    vi.mocked(getSession).mockReturnValue({
      session_id: 'session-abc',
      status: 'done',
    } as never);
    const github = makeGitHub({
      reviewComments: [
        {
          id: 1,
          author: 'alice',
          authorType: 'User',
          body: 'hi',
          createdAt: '',
          path: null,
          line: null,
          pullRequestReviewId: null,
        },
      ],
    });
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      makeSessionManager() as never,
    );
    await watcher.pollAll();
    await vi.advanceTimersByTimeAsync(120_001);

    expect(enqueueFeedbackItem).not.toHaveBeenCalled();
    expect(markCommentsPending).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ── isBotAuthor unit tests ────────────────────────────────────────────────────

describe('isBotAuthor', () => {
  const empty = new Set<string>();

  it('returns true for login ending with [bot]', () => {
    expect(isBotAuthor('github-actions[bot]', 'Bot', empty, empty)).toBe(true);
  });

  it('returns true for Bot-type account regardless of login', () => {
    expect(isBotAuthor('some-service', 'Bot', empty, empty)).toBe(true);
  });

  it('returns false for a regular User account', () => {
    expect(isBotAuthor('alice', 'User', empty, empty)).toBe(false);
  });

  it('deny-list suppresses a named author not otherwise flagged', () => {
    const deny = new Set(['renovate']);
    expect(isBotAuthor('renovate', 'User', deny, empty)).toBe(true);
  });

  it('allow-list overrides the bot filter for a bot-login', () => {
    const allow = new Set(['trusted-bot[bot]']);
    expect(isBotAuthor('trusted-bot[bot]', 'Bot', empty, allow)).toBe(false);
  });

  it('allow-list overrides the deny-list', () => {
    const deny = new Set(['special']);
    const allow = new Set(['special']);
    expect(isBotAuthor('special', 'User', deny, allow)).toBe(false);
  });
});
