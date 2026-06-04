import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/queries', () => ({
  upsertSessionEvent: vi.fn().mockReturnValue(1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  getEventsBySession: vi.fn().mockReturnValue([]),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
  incrementCompactionCount: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
}));

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  GITHUB_REPO: 'owner/repo',
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: { corporate_mode_enabled: false },
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn().mockReturnValue(0),
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

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === 'git branch --show-current') return 'feature/my-task\n';
    if (cmd === 'git remote get-url origin')
      return 'https://github.com/owner/repo.git\n';
    if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
      return 'refs/remotes/origin/dev\n';
    if (cmd === 'git push -u origin feature/my-task') return '';
    throw new Error(`unexpected: ${cmd}`);
  }),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    hasSpawnError: false,
  })),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { AgentSession } from '../AgentSession';
import { upsertPullRequest, getPRBySessionId, setSessionPauseReason } from '../../db/queries';
import { recordEvent, countPushFailureEvents } from '../../audit/AuditLog';
import { execSync } from 'child_process';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_BODY = `## Summary
Changes description.

## Notion Task
https://notion.so/task-123

## Automated Tests
No test changes.

## Files Changed
- src/foo.ts: updated foo
`;

const PR_URL = 'https://github.com/owner/repo/pull/42';

function makeGithubClient(overrides: Record<string, unknown> = {}) {
  return {
    createPR: vi.fn().mockResolvedValue({
      number: 42,
      html_url: PR_URL,
      title: 'feat: my-task',
      body: VALID_BODY,
      head: { ref: 'feature/my-task', sha: 'abc123' },
      base: { ref: 'dev' },
      state: 'open',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      draft: true,
    }),
    updatePR: vi.fn().mockResolvedValue({}),
    fetchPR: vi.fn().mockResolvedValue({ headSha: 'abc123', nodeId: 'node1' }),
    ensureLabelExists: vi.fn().mockResolvedValue(undefined),
    addLabelToPR: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSession(githubClient?: ReturnType<typeof makeGithubClient>) {
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

function emitAssistantWithMarker(session: AgentSession, body: string) {
  (
    session as unknown as {
      handleRawEvent: (e: Record<string, unknown>) => void;
    }
  ).handleRawEvent({
    type: 'assistant',
    message: {
      id: 'msg_pr_body',
      content: [
        { type: 'text', text: `Done!\n\n<pr-body>\n${body}\n</pr-body>` },
      ],
    },
  });
}

function getRunner(session: AgentSession) {
  return (
    session as unknown as { runner: { sendMessage: ReturnType<typeof vi.fn> } }
  ).runner;
}

// ── Push failure → bounded retry ─────────────────────────────────────────────

describe('<pr-body> marker — push failure bounded retry', () => {
  beforeEach(() => {
    vi.mocked(recordEvent).mockClear();
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(countPushFailureEvents).mockReturnValue(0);
    // Reset execSync to happy-path by default
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task') return '';
      throw new Error(`unexpected: ${cmd}`);
    });
  });

  it('routes retry sendMessage and records pr_creation_failed(stage push) on first failure', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task')
        throw new Error('remote: Repository not found.');
      throw new Error(`unexpected: ${cmd}`);
    });
    // Simulate: after recording, count becomes 1 (within bound)
    vi.mocked(countPushFailureEvents).mockReturnValue(1);

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    const runner = getRunner(session);

    emitAssistantWithMarker(session, VALID_BODY);
    await new Promise((r) => setImmediate(r));

    // No createPR should have been called
    expect(ghClient.createPR).not.toHaveBeenCalled();
    // Failure event recorded with stage push
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_creation_failed',
        payload: expect.objectContaining({ stage: 'push' }),
      }),
    );
    // Retry message sent
    expect(runner.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('git push -u origin feature/my-task'),
    );
  });

  it('does NOT call sendMessage when push has failed 2+ times (past bound)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task')
        throw new Error('remote: Repository not found.');
      throw new Error(`unexpected: ${cmd}`);
    });
    // Simulate 3 prior push failure events (> limit of 2)
    vi.mocked(countPushFailureEvents).mockReturnValue(3);

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    const runner = getRunner(session);

    emitAssistantWithMarker(session, VALID_BODY);
    await new Promise((r) => setImmediate(r));

    expect(ghClient.createPR).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_creation_failed',
        payload: expect.objectContaining({ stage: 'push' }),
      }),
    );
    // No retry message
    expect(runner.sendMessage).not.toHaveBeenCalled();
  });

  it('sets session pause_reason=pr_creation_failed when push retries are exhausted', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task')
        throw new Error('remote: Repository not found.');
      throw new Error(`unexpected: ${cmd}`);
    });
    vi.mocked(countPushFailureEvents).mockReturnValue(3); // past limit

    const session = makeSession(makeGithubClient());
    emitAssistantWithMarker(session, VALID_BODY);
    await new Promise((r) => setImmediate(r));

    expect(setSessionPauseReason).toHaveBeenCalledWith(
      'test-session-id',
      'pr_creation_failed',
    );
  });

  it('retry count is derived from recorded events (persisted across re-prompts)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task')
        throw new Error('auth error');
      throw new Error(`unexpected: ${cmd}`);
    });

    // First invocation: count=1 (within bound) → should send retry
    vi.mocked(countPushFailureEvents).mockReturnValue(1);
    const session1 = makeSession(makeGithubClient());
    const runner1 = getRunner(session1);
    emitAssistantWithMarker(session1, VALID_BODY);
    await new Promise((r) => setImmediate(r));
    expect(runner1.sendMessage).toHaveBeenCalledTimes(1);

    // Second invocation (simulating re-prompt): count=2 (still within bound) → send retry
    vi.mocked(countPushFailureEvents).mockReturnValue(2);
    const session2 = makeSession(makeGithubClient());
    const runner2 = getRunner(session2);
    emitAssistantWithMarker(session2, VALID_BODY);
    await new Promise((r) => setImmediate(r));
    expect(runner2.sendMessage).toHaveBeenCalledTimes(1);

    // Third invocation: count=3 (past bound) → no retry
    vi.mocked(countPushFailureEvents).mockReturnValue(3);
    const session3 = makeSession(makeGithubClient());
    const runner3 = getRunner(session3);
    emitAssistantWithMarker(session3, VALID_BODY);
    await new Promise((r) => setImmediate(r));
    expect(runner3.sendMessage).not.toHaveBeenCalled();
  });
});

// ── createPR transient retry ──────────────────────────────────────────────────

describe('<pr-body> marker — createPR transient retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(recordEvent).mockClear();
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(countPushFailureEvents).mockReturnValue(0);
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task') return '';
      throw new Error(`unexpected: ${cmd}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on 5xx and succeeds on third attempt', async () => {
    let calls = 0;
    const successResponse = {
      number: 42,
      html_url: PR_URL,
      title: 'feat: my-task',
      body: VALID_BODY,
      head: { ref: 'feature/my-task', sha: 'abc123' },
      base: { ref: 'dev' },
      state: 'open',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      draft: true,
    };
    const ghClient = makeGithubClient({
      createPR: vi.fn().mockImplementation(() => {
        calls++;
        if (calls < 3)
          return Promise.reject(new Error('503 Service Unavailable'));
        return Promise.resolve(successResponse);
      }),
    });

    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    // Drain the retry backoff timers
    await vi.runAllTimersAsync();

    expect(ghClient.createPR).toHaveBeenCalledTimes(3);
    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 42 }),
    );
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'pr_creation_failed' }),
    );
  });

  it('records pr_creation_failed(stage create) after 3 transient failures, no PR row', async () => {
    const ghClient = makeGithubClient({
      createPR: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')),
    });

    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    await vi.runAllTimersAsync();

    expect(ghClient.createPR).toHaveBeenCalledTimes(3);
    expect(upsertPullRequest).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_creation_failed',
        payload: expect.objectContaining({ stage: 'create' }),
      }),
    );
  });

  it('sets session pause_reason=pr_creation_failed after all transient retries exhausted', async () => {
    const ghClient = makeGithubClient({
      createPR: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')),
    });

    const session = makeSession(ghClient);
    vi.mocked(setSessionPauseReason).mockClear();
    emitAssistantWithMarker(session, VALID_BODY);

    await vi.runAllTimersAsync();

    expect(setSessionPauseReason).toHaveBeenCalledWith(
      'test-session-id',
      'pr_creation_failed',
    );
  });
});

// ── createPR 422 handling ─────────────────────────────────────────────────────

describe('<pr-body> marker — createPR 422 diversion', () => {
  beforeEach(() => {
    vi.mocked(recordEvent).mockClear();
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(countPushFailureEvents).mockReturnValue(0);
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task') return '';
      throw new Error(`unexpected: ${cmd}`);
    });
  });

  it('422 "head branch not found" → records push-stage failure and sends retry message', async () => {
    const ghClient = makeGithubClient({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error('422 Unprocessable Entity: head branch not found'),
        ),
    });
    vi.mocked(countPushFailureEvents).mockReturnValue(1);

    const session = makeSession(ghClient);
    const runner = getRunner(session);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    // Not retried as a create
    expect(ghClient.createPR).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_creation_failed',
        payload: expect.objectContaining({ stage: 'push' }),
      }),
    );
    expect(runner.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('git push -u origin feature/my-task'),
    );
  });

  it('422 "pull request already exists" → diverts to update path, no duplicate create', async () => {
    const ghClient = makeGithubClient({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error(
            '422 Validation Failed: A pull request already exists for owner:feature/my-task.',
          ),
        ),
    });
    // First call (early-return guard in handlePRBodyMarker): no existing PR.
    // Second call (inside createPRWithRetry after 422): returns existing PR.
    vi.mocked(getPRBySessionId)
      .mockReturnValueOnce(null)
      .mockReturnValue({
        pr_number: 99,
        repo: 'owner/repo',
        base_branch: 'dev',
      } as never);

    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    expect(ghClient.createPR).toHaveBeenCalledTimes(1);
    expect(ghClient.updatePR).toHaveBeenCalledWith('owner/repo', 99, {
      body: VALID_BODY.trim(),
    });
    expect(upsertPullRequest).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'pr_creation_failed' }),
    );
  });

  it('other 422 is terminal — records create-stage failure, not retried', async () => {
    const ghClient = makeGithubClient({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error('422 Validation Failed: some unknown client error'),
        ),
    });

    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    expect(ghClient.createPR).toHaveBeenCalledTimes(1);
    expect(upsertPullRequest).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_creation_failed',
        payload: expect.objectContaining({ stage: 'create' }),
      }),
    );
  });

  it('other 422 terminal — sets session pause_reason=pr_creation_failed', async () => {
    const ghClient = makeGithubClient({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error('422 Validation Failed: some unknown client error'),
        ),
    });

    const session = makeSession(ghClient);
    vi.mocked(setSessionPauseReason).mockClear();
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    expect(setSessionPauseReason).toHaveBeenCalledWith(
      'test-session-id',
      'pr_creation_failed',
    );
  });
});
