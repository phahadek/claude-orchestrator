import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/queries', () =>
  mockDbQueries({
    upsertSessionEvent: vi.fn().mockReturnValue(1),
    updateSessionStatus: vi.fn(),
    markSessionDone: vi.fn(),
    markSessionIdle: vi.fn(),
    getEventsBySession: vi.fn().mockReturnValue([]),
    insertPermissionDenial: vi.fn(),
    upsertPullRequest: vi.fn(),
    incrementTokens: vi.fn(),
    incrementCompactionCount: vi.fn(),
    setContextOccupancy: vi.fn(),
    setSessionModel: vi.fn(),
    setSessionModelSettingKey: vi.fn(),
    setSessionEffortSettingKey: vi.fn(),
    setSessionMetadata: vi.fn(),
    getPRBySessionId: vi.fn().mockReturnValue(null),
    setHeadSha: vi.fn(),
    setPauseReason: vi.fn(),
    insertPauseInterval: vi.fn(),
  }),
);

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: { corporate_mode_enabled: false },
  getProjectById: vi.fn().mockReturnValue(null),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../filePollutionCheck', () => ({
  runFilePollutionCheck: vi.fn().mockResolvedValue({ revertCommitSha: null }),
}));

vi.mock('../../github/PRBodyValidator', () => ({
  validatePRBody: vi.fn().mockReturnValue({ valid: true, missingSections: [] }),
  buildValidationComment: vi.fn().mockReturnValue(''),
}));

vi.mock('../../github/CommitAttributionWatcher', () => ({
  checkCommitAttribution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  isPRCreateCommand,
  extractTextFromToolResultEvent,
} from '../AgentSession';
import { AgentSession } from '../AgentSession';
import { upsertPullRequest } from '../../db/queries';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(githubClient?: unknown): AgentSession {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'test-session-id',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    '/tmp/worktree',
    'task-123',
    undefined,
    undefined,
    'standard',
    undefined,
    githubClient as never,
  );
}

function sendEvent(session: AgentSession, event: Record<string, unknown>) {
  (
    session as unknown as {
      handleRawEvent: (e: Record<string, unknown>) => void;
    }
  ).handleRawEvent(event);
}

// ── Unit tests: isPRCreateCommand ─────────────────────────────────────────────

describe('isPRCreateCommand', () => {
  it('returns true for a standard gh pr create command', () => {
    expect(
      isPRCreateCommand(
        'Bash',
        'gh pr create --draft --base dev --body-file /tmp/pr-body.md',
      ),
    ).toBe(true);
  });

  it('returns true for bare gh pr create', () => {
    expect(isPRCreateCommand('Bash', 'gh pr create')).toBe(true);
  });

  it('returns false for gh pr view', () => {
    expect(isPRCreateCommand('Bash', 'gh pr view 123')).toBe(false);
  });

  it('returns false for gh pr list', () => {
    expect(isPRCreateCommand('Bash', 'gh pr list')).toBe(false);
  });

  it('returns false for a partial match inside a longer token (path)', () => {
    expect(isPRCreateCommand('Bash', '/usr/local/bin/gh pr create')).toBe(true);
    // Ensure "ghost pr create" does NOT match — gh must be a complete token
    expect(isPRCreateCommand('Bash', 'ghost pr create')).toBe(false);
  });

  it('returns false for non-Bash tool names', () => {
    expect(
      isPRCreateCommand('mcp__github__create_pull_request', 'gh pr create'),
    ).toBe(false);
    expect(isPRCreateCommand('Write', 'gh pr create')).toBe(false);
  });
});

// ── Unit tests: extractTextFromToolResultEvent ────────────────────────────────

describe('extractTextFromToolResultEvent', () => {
  it('extracts text from a string content field', () => {
    expect(
      extractTextFromToolResultEvent({
        content: 'https://github.com/owner/repo/pull/42',
      }),
    ).toBe('https://github.com/owner/repo/pull/42');
  });

  it('extracts and concatenates text from content block array', () => {
    const event = {
      content: [
        { type: 'text', text: 'Warning: 1 uncommitted change\n' },
        { type: 'text', text: 'https://github.com/owner/repo/pull/42' },
      ],
    };
    expect(extractTextFromToolResultEvent(event)).toBe(
      'Warning: 1 uncommitted change\nhttps://github.com/owner/repo/pull/42',
    );
  });

  it('returns empty string when content is missing', () => {
    expect(extractTextFromToolResultEvent({})).toBe('');
  });

  it('skips non-text blocks', () => {
    const event = {
      content: [
        { type: 'image', source: 'data:...' },
        { type: 'text', text: 'hello' },
      ],
    };
    expect(extractTextFromToolResultEvent(event)).toBe('hello');
  });
});

// ── Integration tests ─────────────────────────────────────────────────────────

const PR_URL = 'https://github.com/owner/repo/pull/153';

describe('gh pr create live detection via handleRawEvent', () => {
  const TOOL_USE_ID = 'toolu_bash_001';
  const CMD = 'gh pr create --draft --base dev --body-file /tmp/pr-body.md';

  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockClear();
  });

  function emitToolUse(session: AgentSession) {
    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_001',
        content: [
          {
            type: 'tool_use',
            id: TOOL_USE_ID,
            name: 'Bash',
            input: { command: CMD },
          },
        ],
      },
    });
  }

  function emitToolResult(session: AgentSession, content: unknown) {
    sendEvent(session, {
      type: 'tool_result',
      tool_use_id: TOOL_USE_ID,
      content,
    });
  }

  it('inserts PR row when tool_result contains a plain URL', async () => {
    const session = makeSession();
    emitToolUse(session);
    emitToolResult(session, PR_URL);

    await vi.runAllTimersAsync?.().catch(() => {});
    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        pr_number: 153,
        pr_url: PR_URL,
        session_id: 'test-session-id',
        task_id: 'task-123',
        repo: 'owner/repo',
      }),
    );
  });

  it('extracts URL from output that includes a leading warning line', async () => {
    const session = makeSession();
    emitToolUse(session);
    emitToolResult(session, `Warning: 1 uncommitted change\n${PR_URL}`);

    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 153, pr_url: PR_URL }),
    );
  });

  it('extracts URL from gh pr create --json url output', async () => {
    const session = makeSession();
    emitToolUse(session);
    emitToolResult(session, JSON.stringify({ url: PR_URL }));

    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 153, pr_url: PR_URL }),
    );
  });

  it('extracts URL from content block array (Warning + URL as blocks)', async () => {
    const session = makeSession();
    emitToolUse(session);
    emitToolResult(session, [
      { type: 'text', text: 'Warning: 1 uncommitted change\n' },
      { type: 'text', text: PR_URL },
    ]);

    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 153, pr_url: PR_URL }),
    );
  });

  it('does NOT insert a PR row for gh pr view', async () => {
    const session = makeSession();
    const VIEW_ID = 'toolu_bash_view';
    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_002',
        content: [
          {
            type: 'tool_use',
            id: VIEW_ID,
            name: 'Bash',
            input: { command: 'gh pr view 153' },
          },
        ],
      },
    });
    sendEvent(session, {
      type: 'tool_result',
      tool_use_id: VIEW_ID,
      content: PR_URL,
    });

    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).not.toHaveBeenCalled();
  });

  it('does NOT insert a second PR row when prDetectedLive is already true', async () => {
    const session = makeSession();
    emitToolUse(session);
    emitToolResult(session, PR_URL);
    await new Promise((r) => setImmediate(r));

    // Simulate a second gh pr create event (should be a no-op)
    const TOOL_USE_ID_2 = 'toolu_bash_002';
    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_003',
        content: [
          {
            type: 'tool_use',
            id: TOOL_USE_ID_2,
            name: 'Bash',
            input: { command: CMD },
          },
        ],
      },
    });
    sendEvent(session, {
      type: 'tool_result',
      tool_use_id: TOOL_USE_ID_2,
      content: 'https://github.com/owner/repo/pull/200',
    });
    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).toHaveBeenCalledTimes(1);
  });
});

// ── PR metadata backfill via fetchPR ──────────────────────────────────────────

describe('PR title/branch backfill from URL-only detection', () => {
  const TOOL_USE_ID = 'toolu_bash_backfill';
  const CMD = 'gh pr create --draft --base dev --body-file /tmp/pr-body.md';

  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockClear();
  });

  function emitToolUse(session: AgentSession) {
    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_backfill',
        content: [
          {
            type: 'tool_use',
            id: TOOL_USE_ID,
            name: 'Bash',
            input: { command: CMD },
          },
        ],
      },
    });
  }

  function emitToolResult(session: AgentSession, content: unknown) {
    sendEvent(session, {
      type: 'tool_result',
      tool_use_id: TOOL_USE_ID,
      content,
    });
  }

  it('calls fetchPR once and merges title/head_branch/base_branch into the upsert', async () => {
    // headSha/body are included so the pre-existing headSha/body enrichment
    // fetch (see needsHeadSha/needsBodyValidation below) has nothing left to
    // do and does not issue a second fetchPR call.
    const fetchPR = vi.fn().mockResolvedValue({
      title: 'Fetched title',
      headBranch: 'feature/backfilled',
      headSha: 'abc123',
      baseBranch: 'dev',
      body: 'some body',
    });
    const session = makeSession({ fetchPR });
    emitToolUse(session);
    emitToolResult(session, PR_URL);

    await new Promise((r) => setImmediate(r));

    expect(fetchPR).toHaveBeenCalledTimes(1);
    expect(fetchPR).toHaveBeenCalledWith('owner/repo', 153);
    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        pr_number: 153,
        pr_url: PR_URL,
        title: 'Fetched title',
        head_branch: 'feature/backfilled',
        base_branch: 'dev',
      }),
    );
  });

  it('does not call the title-backfill fetchPR when the detected shape already carries a title', async () => {
    const fetchPR = vi.fn().mockResolvedValue({
      title: 'Should not be used',
      headBranch: 'nope',
      headSha: 'nope-sha',
      baseBranch: 'nope',
      body: 'nope-body',
    });
    const session = makeSession({ fetchPR });
    emitToolUse(session);
    // head.sha and body are also present so the pre-existing enrichment
    // fetch (unrelated to this task) doesn't fire either — isolating the
    // assertion to the title-backfill call this task adds.
    emitToolResult(
      session,
      JSON.stringify({
        html_url: PR_URL,
        title: 'Already known title',
        body: 'known body',
        head: { ref: 'known-branch', sha: 'known-sha' },
      }),
    );

    await new Promise((r) => setImmediate(r));

    expect(fetchPR).not.toHaveBeenCalled();
    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Already known title' }),
    );
  });

  it('upserts the URL-only row and continues when fetchPR throws', async () => {
    const fetchPR = vi.fn().mockRejectedValue(new Error('network error'));
    const session = makeSession({ fetchPR });
    emitToolUse(session);
    emitToolResult(session, PR_URL);

    await new Promise((r) => setImmediate(r));

    // Called by both the title-backfill path and the pre-existing
    // headSha/body enrichment path — both fail the same way and are
    // independently non-fatal, so the row still upserts URL-only.
    expect(fetchPR).toHaveBeenCalled();
    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        pr_number: 153,
        pr_url: PR_URL,
        title: null,
        head_branch: null,
        base_branch: null,
      }),
    );
  });

  it('handles a GitHubRateLimitError from fetchPR without failing PR detection', async () => {
    class GitHubRateLimitError extends Error {
      constructor() {
        super('rate limited');
        this.name = 'GitHubRateLimitError';
      }
    }
    const fetchPR = vi.fn().mockRejectedValue(new GitHubRateLimitError());
    const session = makeSession({ fetchPR });
    emitToolUse(session);
    emitToolResult(session, PR_URL);

    await new Promise((r) => setImmediate(r));

    expect(fetchPR).toHaveBeenCalled();
    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        pr_number: 153,
        pr_url: PR_URL,
        title: null,
      }),
    );
  });
});

// ── Regression: MCP path still works ─────────────────────────────────────────

describe('MCP mcp__github__create_pull_request path (regression)', () => {
  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockClear();
  });

  it('inserts PR row via MCP tool_result content blocks', async () => {
    const session = makeSession();
    const MCP_ID = 'toolu_mcp_001';
    const prShape = {
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      title: 'My PR',
      state: 'open',
      draft: true,
    };

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_mcp',
        content: [
          {
            type: 'tool_use',
            id: MCP_ID,
            name: 'mcp__github__create_pull_request',
            input: {},
          },
        ],
      },
    });
    sendEvent(session, {
      type: 'tool_result',
      tool_use_id: MCP_ID,
      content: [{ type: 'text', text: JSON.stringify(prShape) }],
    });

    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        pr_number: 42,
        pr_url: 'https://github.com/owner/repo/pull/42',
        title: 'My PR',
        draft: 1,
      }),
    );
  });
});
