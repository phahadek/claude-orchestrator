import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must precede imports of the modules under test) ───────────────────

vi.mock('../db/queries.js', () => ({
  getAllOpenPRs: vi.fn(),
  getRoutedCommentIds: vi.fn(),
  markCommentsRouted: vi.fn(),
  setPauseReason: vi.fn(),
  getSession: vi.fn(),
  getSetting: vi.fn().mockReturnValue(undefined),
}));

import {
  getAllOpenPRs,
  getRoutedCommentIds,
  markCommentsRouted,
  setPauseReason,
  getSession,
  getSetting,
} from '../db/queries.js';
import { ReviewerCommentsWatcher } from '../github/ReviewerCommentsWatcher.js';
import type { PullRequestRow } from '../db/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePR(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    notion_task_id: null,
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
  overrides: { send?: ReturnType<typeof vi.fn> } = {},
) {
  return { send: overrides.send ?? vi.fn() };
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

describe('ReviewerCommentsWatcher', () => {
  describe('new human comments are sent to the coding session', () => {
    it('aggregates review body, review comments, and issue comments and sends them', async () => {
      vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

      const github = makeGitHub({
        reviews: [
          {
            id: 1,
            state: 'COMMENTED',
            author: 'alice',
            body: 'Looks good overall',
            submittedAt: '',
          },
        ],
        reviewComments: [
          {
            id: 10,
            author: 'alice',
            body: 'Fix this line',
            createdAt: '',
            path: 'src/foo.ts',
            line: 5,
          },
        ],
        issueComments: [
          {
            id: 20,
            author: 'bob',
            body: 'Please update the README',
            createdAt: '',
          },
        ],
      });
      const sessions = makeSessionManager();
      const watcher = new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      );

      await watcher.pollAll();

      expect(sessions.send).toHaveBeenCalledOnce();
      const [sessionId, message] = sessions.send.mock.calls[0] as [
        string,
        string,
      ];
      expect(sessionId).toBe('session-abc');
      expect(message).toContain('PR #42');
      expect(message).toContain('alice');
      expect(message).toContain('Looks good overall');
      expect(message).toContain('Fix this line');
      expect(message).toContain('bob');
      expect(message).toContain('Please update the README');
    });

    it('skips PRs without a session_id', async () => {
      vi.mocked(getAllOpenPRs).mockReturnValue([makePR({ session_id: null })]);
      const github = makeGitHub();
      const sessions = makeSessionManager();
      await new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      ).pollAll();
      expect(sessions.send).not.toHaveBeenCalled();
    });

    it('skips PRs paused for non-watchable reasons', async () => {
      vi.mocked(getAllOpenPRs).mockReturnValue([
        makePR({ pause_reason: 'ci_failing' }),
      ]);
      const github = makeGitHub({
        reviewComments: [
          {
            id: 1,
            author: 'alice',
            body: 'hello',
            createdAt: '',
            path: null,
            line: null,
          },
        ],
      });
      const sessions = makeSessionManager();
      await new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      ).pollAll();
      expect(sessions.send).not.toHaveBeenCalled();
    });
  });

  describe('AI-authored comments are filtered out', () => {
    it('does not route comments authored by ai_reviewer_usernames', async () => {
      vi.mocked(getSetting).mockReturnValue(
        JSON.stringify(['ai-reviewer-bot']),
      );
      vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

      const github = makeGitHub({
        reviews: [
          {
            id: 1,
            state: 'COMMENTED',
            author: 'ai-reviewer-bot',
            body: 'AI comment',
            submittedAt: '',
          },
          {
            id: 2,
            state: 'COMMENTED',
            author: 'human-dev',
            body: 'Human comment',
            submittedAt: '',
          },
        ],
        reviewComments: [
          {
            id: 10,
            author: 'ai-reviewer-bot',
            body: 'AI inline',
            createdAt: '',
            path: 'x.ts',
            line: 1,
          },
        ],
        issueComments: [
          {
            id: 20,
            author: 'ai-reviewer-bot',
            body: 'AI issue comment',
            createdAt: '',
          },
        ],
      });
      const sessions = makeSessionManager();
      await new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      ).pollAll();

      expect(sessions.send).toHaveBeenCalledOnce();
      const [, message] = sessions.send.mock.calls[0] as [string, string];
      expect(message).toContain('Human comment');
      expect(message).not.toContain('AI comment');
      expect(message).not.toContain('AI inline');
      expect(message).not.toContain('AI issue comment');
    });

    it('does not route anything when all comments are AI-authored', async () => {
      vi.mocked(getSetting).mockReturnValue(JSON.stringify(['bot']));
      vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
      const github = makeGitHub({
        reviews: [
          {
            id: 1,
            state: 'COMMENTED',
            author: 'bot',
            body: 'AI says hi',
            submittedAt: '',
          },
        ],
      });
      const sessions = makeSessionManager();
      await new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      ).pollAll();
      expect(sessions.send).not.toHaveBeenCalled();
    });
  });

  describe('already-routed comments are not re-sent', () => {
    it('skips comment IDs present in getRoutedCommentIds()', async () => {
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
            body: 'Already sent review',
            submittedAt: '',
          },
        ],
        reviewComments: [
          {
            id: 10,
            author: 'alice',
            body: 'Already sent inline',
            createdAt: '',
            path: 'x.ts',
            line: 1,
          },
        ],
        issueComments: [
          {
            id: 20,
            author: 'alice',
            body: 'Already sent issue',
            createdAt: '',
          },
        ],
      });
      const sessions = makeSessionManager();
      await new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      ).pollAll();
      expect(sessions.send).not.toHaveBeenCalled();
      expect(markCommentsRouted).not.toHaveBeenCalled();
    });

    it('only sends new comments when some are already routed', async () => {
      vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
      vi.mocked(getRoutedCommentIds).mockReturnValue(new Set(['rv_1']));

      const github = makeGitHub({
        reviews: [
          {
            id: 1,
            state: 'COMMENTED',
            author: 'alice',
            body: 'Old review body',
            submittedAt: '',
          },
          {
            id: 2,
            state: 'COMMENTED',
            author: 'alice',
            body: 'New review body',
            submittedAt: '',
          },
        ],
      });
      const sessions = makeSessionManager();
      await new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      ).pollAll();

      expect(sessions.send).toHaveBeenCalledOnce();
      const [, message] = sessions.send.mock.calls[0] as [string, string];
      expect(message).toContain('New review body');
      expect(message).not.toContain('Old review body');
      expect(markCommentsRouted).toHaveBeenCalledWith(42, 'owner/repo', [
        'rv_2',
      ]);
    });
  });

  describe('CHANGES_REQUESTED clears awaiting_human_approval', () => {
    it('transitions awaiting_human_approval → human_changes_requested when CHANGES_REQUESTED review found', async () => {
      const pr = makePR({ pause_reason: 'awaiting_human_approval' });
      vi.mocked(getAllOpenPRs).mockReturnValue([pr]);

      const github = makeGitHub({
        reviews: [
          {
            id: 1,
            state: 'CHANGES_REQUESTED',
            author: 'alice',
            body: 'Please fix tests',
            submittedAt: '',
          },
        ],
      });
      const sessions = makeSessionManager();
      await new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      ).pollAll();

      expect(setPauseReason).toHaveBeenCalledWith(
        42,
        'owner/repo',
        'human_changes_requested',
      );
    });

    it('does NOT transition when review state is COMMENTED (not CHANGES_REQUESTED)', async () => {
      const pr = makePR({ pause_reason: 'awaiting_human_approval' });
      vi.mocked(getAllOpenPRs).mockReturnValue([pr]);

      const github = makeGitHub({
        reviews: [
          {
            id: 1,
            state: 'COMMENTED',
            author: 'alice',
            body: 'LGTM mostly',
            submittedAt: '',
          },
        ],
      });
      const sessions = makeSessionManager();
      await new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      ).pollAll();

      expect(setPauseReason).not.toHaveBeenCalled();
    });

    it('does NOT transition when CHANGES_REQUESTED is from an AI reviewer', async () => {
      vi.mocked(getSetting).mockReturnValue(JSON.stringify(['ai-bot']));
      const pr = makePR({ pause_reason: 'awaiting_human_approval' });
      vi.mocked(getAllOpenPRs).mockReturnValue([pr]);

      const github = makeGitHub({
        reviews: [
          {
            id: 1,
            state: 'CHANGES_REQUESTED',
            author: 'ai-bot',
            body: 'AI says fix it',
            submittedAt: '',
          },
        ],
      });
      const sessions = makeSessionManager();
      await new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      ).pollAll();

      expect(setPauseReason).not.toHaveBeenCalled();
    });
  });

  describe('dead session handling', () => {
    it('skips routing when session is done', async () => {
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
            body: 'hi',
            createdAt: '',
            path: null,
            line: null,
          },
        ],
      });
      const sessions = makeSessionManager();
      await new ReviewerCommentsWatcher(
        github as never,
        sessions as never,
      ).pollAll();
      expect(sessions.send).not.toHaveBeenCalled();
      expect(markCommentsRouted).not.toHaveBeenCalled();
    });
  });
});
