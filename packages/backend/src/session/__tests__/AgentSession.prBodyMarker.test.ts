import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/queries', () => ({
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
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSessionTags: vi.fn().mockReturnValue([]),
  setSessionTags: vi.fn(),
  resetTaskCrashCount: vi.fn(),
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
import {
  upsertPullRequest,
  getPRBySessionId,
  markSessionDone,
  markSessionIdle,
  setPauseReason,
} from '../../db/queries';
import { validatePRBody } from '../../github/PRBodyValidator';
import { recordEvent } from '../../audit/AuditLog';
import { execSync } from 'child_process';
import { runtimeSettings } from '../../config';

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
    updatePR: vi.fn().mockResolvedValue({
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
    fetchPR: vi.fn().mockResolvedValue({ headSha: 'abc123', nodeId: 'node1' }),
    ensureLabelExists: vi.fn().mockResolvedValue(undefined),
    addLabelToPR: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue(undefined),
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

function sendEvent(session: AgentSession, event: Record<string, unknown>) {
  (
    session as unknown as {
      handleRawEvent: (e: Record<string, unknown>) => void;
    }
  ).handleRawEvent(event);
}

function emitAssistantWithMarker(
  session: AgentSession,
  body: string,
  msgId = 'msg_pr_body',
) {
  sendEvent(session, {
    type: 'assistant',
    message: {
      id: msgId,
      content: [
        { type: 'text', text: `Done!\n\n<pr-body>\n${body}\n</pr-body>` },
      ],
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('<pr-body> marker — createPR path', () => {
  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(validatePRBody).mockReturnValue({
      valid: true,
      missingSections: [],
    });
    vi.mocked(getPRBySessionId).mockReturnValue(null);
  });

  it('calls githubClient.createPR() when a valid marker is detected', async () => {
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    expect(ghClient.createPR).toHaveBeenCalledWith(
      'owner/repo',
      expect.objectContaining({
        title: 'feat: my-task',
        body: VALID_BODY.trim(),
        head: 'feature/my-task',
        base: 'dev',
        draft: true,
      }),
    );
  });

  it('upserts the PR row via handlePRDetected after createPR', async () => {
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        pr_number: 42,
        pr_url: PR_URL,
        session_id: 'test-session-id',
      }),
    );
  });

  it('does NOT call createPR when githubClient is absent', async () => {
    const session = makeSession(undefined);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).not.toHaveBeenCalled();
  });

  it('does NOT create a second PR when prDetectedLive is already true', async () => {
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);

    emitAssistantWithMarker(session, VALID_BODY, 'msg_001');
    await new Promise((r) => setImmediate(r));

    // Second emission — different message ID but prDetectedLive is now true
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      base_branch: 'dev',
    } as never);

    emitAssistantWithMarker(session, VALID_BODY, 'msg_002');
    await new Promise((r) => setImmediate(r));

    // createPR only called once; second emission hits the updatePR path
    expect(ghClient.createPR).toHaveBeenCalledTimes(1);
    expect(ghClient.updatePR).toHaveBeenCalledTimes(1);
  });
});

describe('<pr-body> marker — validation failure path', () => {
  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
  });

  it('re-prompts the session and does NOT create a PR when body is invalid', async () => {
    vi.mocked(validatePRBody).mockReturnValue({
      valid: false,
      missingSections: ['## Summary', '## Files Changed'],
    });

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);

    // Access the internal runner to observe sendMessage calls
    const runner = (
      session as unknown as {
        runner: { sendMessage: ReturnType<typeof vi.fn> };
      }
    ).runner;

    emitAssistantWithMarker(session, 'incomplete body', 'msg_bad');
    await new Promise((r) => setImmediate(r));

    expect(ghClient.createPR).not.toHaveBeenCalled();
    expect(upsertPullRequest).not.toHaveBeenCalled();
    expect(runner.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('## Summary'),
    );
  });
});

describe('<pr-body> marker — idempotent update path', () => {
  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(validatePRBody).mockReturnValue({
      valid: true,
      missingSections: [],
    });
  });

  it('calls updatePR instead of createPR when a PR already exists for this session', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      base_branch: 'dev',
    } as never);

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);

    emitAssistantWithMarker(session, VALID_BODY, 'msg_update');
    await new Promise((r) => setImmediate(r));

    expect(ghClient.createPR).not.toHaveBeenCalled();
    expect(ghClient.updatePR).toHaveBeenCalledWith('owner/repo', 42, {
      body: VALID_BODY.trim(),
    });
  });

  it('records pr_body_updated_via_marker audit event on update', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      base_branch: 'dev',
    } as never);

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY, 'msg_audit');
    await new Promise((r) => setImmediate(r));

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'pr_body_updated_via_marker' }),
    );
  });

  it('does NOT re-process the same message ID twice (streaming dedup)', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);

    // Same message ID sent twice (simulates two streaming chunks for the same turn)
    emitAssistantWithMarker(session, VALID_BODY, 'msg_stream');
    emitAssistantWithMarker(session, VALID_BODY, 'msg_stream');
    await new Promise((r) => setImmediate(r));

    expect(ghClient.createPR).toHaveBeenCalledTimes(1);
  });
});

describe('<pr-body> marker — clean-exit ordering', () => {
  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(markSessionDone).mockClear();
    vi.mocked(markSessionIdle).mockClear();
    vi.mocked(validatePRBody).mockReturnValue({
      valid: true,
      missingSections: [],
    });
    vi.mocked(getPRBySessionId).mockReturnValue(null);
  });

  it('prBodyMarkerPromise is set (tracked) after marker emission', () => {
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    const promise = (
      session as unknown as { prBodyMarkerPromise: Promise<void> | null }
    ).prBodyMarkerPromise;
    expect(promise).toBeInstanceOf(Promise);
  });

  it('handleCleanExit awaits prBodyMarkerPromise before calling markSessionIdle', async () => {
    let resolveCreatePR!: (
      value: ReturnType<typeof makeGithubClient>['createPR'] extends (
        ...args: unknown[]
      ) => Promise<infer R>
        ? R
        : never,
    ) => void;
    const createPRDeferred = new Promise<{
      number: number;
      html_url: string;
      title: string;
      body: string;
      head: { ref: string; sha: string };
      base: { ref: string };
      state: string;
      created_at: string;
      updated_at: string;
      draft: boolean;
    }>((resolve) => {
      resolveCreatePR = resolve;
    });

    const ghClient = makeGithubClient({
      createPR: vi.fn().mockReturnValue(createPRDeferred),
    });
    const session = makeSession(ghClient);

    // Emit the marker — prBodyMarkerPromise is now pending (createPR not resolved yet)
    emitAssistantWithMarker(session, VALID_BODY);
    await new Promise((r) => setImmediate(r));

    // Start handleCleanExit without awaiting it yet
    const cleanExitPromise = (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    // Flush microtasks — handleCleanExit should be waiting on prBodyMarkerPromise
    await new Promise((r) => setImmediate(r));

    // markSessionIdle must NOT have been called yet (blocked on createPR)
    expect(vi.mocked(markSessionIdle)).not.toHaveBeenCalled();

    // Resolve the createPR so handlePRBodyMarker can complete
    resolveCreatePR({
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
    });

    // Now handleCleanExit should proceed and call markSessionIdle
    await cleanExitPromise;

    expect(vi.mocked(markSessionIdle)).toHaveBeenCalledTimes(1);
  });

  it('markSessionIdle receives the PR URL created via marker flow (not undefined)', async () => {
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    // Let createPR resolve
    await new Promise((r) => setImmediate(r));

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(vi.mocked(markSessionIdle)).toHaveBeenCalledWith(
      'test-session-id',
      expect.any(Number),
      PR_URL,
    );
  });
});

describe('<pr-body> marker — structured logging', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(recordEvent).mockClear();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(validatePRBody).mockReturnValue({
      valid: true,
      missingSections: [],
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task') return '';
      throw new Error(`unexpected execSync: ${cmd}`);
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  function loggedMessages(): string[] {
    return consoleSpy.mock.calls
      .filter(
        (args) =>
          typeof args[1] === 'string' &&
          (args[1].startsWith('PR creation') ||
            args[1].startsWith('<pr-body>')),
      )
      .map((args) => args.slice(1).join(' '));
  }

  it('logs "PR creation succeeded" with PR number on success', async () => {
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    const msgs = loggedMessages();
    expect(msgs.some((m) => m.startsWith('PR creation succeeded:'))).toBe(true);
    expect(msgs.some((m) => m.includes('#42'))).toBe(true);
  });

  it('logs "PR creation failed: validation" with missing section names', async () => {
    vi.mocked(validatePRBody).mockReturnValue({
      valid: false,
      missingSections: ['## Summary', '## Files Changed'],
    });

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, 'bad body', 'msg_val_log');

    await new Promise((r) => setImmediate(r));

    const msgs = loggedMessages();
    expect(
      msgs.some(
        (m) =>
          m.startsWith('PR creation failed: validation') &&
          m.includes('## Summary') &&
          m.includes('## Files Changed'),
      ),
    ).toBe(true);
  });

  it('logs "PR creation failed: duplicate PR" with existing PR number on 422 already-exists', async () => {
    // First call (in handlePRBodyMarker) returns null so we proceed to createPR.
    // Second call (inside createPRWithRetry after 422) returns the known PR.
    vi.mocked(getPRBySessionId)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        pr_number: 7,
        repo: 'owner/repo',
        base_branch: 'dev',
      } as never);

    const ghClient = makeGithubClient({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'GitHub API error 422: A pull request already exists for owner:feature/my-task.',
          ),
        ),
    });
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY, 'msg_dup');

    await new Promise((r) => setImmediate(r));

    const msgs = loggedMessages();
    expect(
      msgs.some(
        (m) =>
          m.startsWith('PR creation failed: duplicate PR') && m.includes('#7'),
      ),
    ).toBe(true);
  });

  it('logs "PR creation failed: duplicate PR" with #? when no DB record exists for 422 already-exists', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(null);

    const ghClient = makeGithubClient({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'GitHub API error 422: A pull request already exists for owner:feature/my-task.',
          ),
        ),
    });
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY, 'msg_dup_no_db');

    await new Promise((r) => setImmediate(r));

    const msgs = loggedMessages();
    expect(
      msgs.some(
        (m) =>
          m.startsWith('PR creation failed: duplicate PR') &&
          m.includes('feature/my-task'),
      ),
    ).toBe(true);
  });

  it('logs "PR creation failed: branch ... not found on origin" on 404', async () => {
    const ghClient = makeGithubClient({
      createPR: vi
        .fn()
        .mockRejectedValue(new Error('GitHub API error 404: Not Found')),
    });
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY, 'msg_404');

    await new Promise((r) => setImmediate(r));

    const msgs = loggedMessages();
    expect(
      msgs.some(
        (m) =>
          m.startsWith('PR creation failed: branch') &&
          m.includes('feature/my-task') &&
          m.includes('not found on origin'),
      ),
    ).toBe(true);
  });

  it('logs "PR creation failed: GitHub auth/permission denied" and mentions GITHUB_TOKEN on 401', async () => {
    const ghClient = makeGithubClient({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error('GitHub API error 401: Requires authentication'),
        ),
    });
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY, 'msg_401');

    await new Promise((r) => setImmediate(r));

    const msgs = loggedMessages();
    expect(
      msgs.some(
        (m) =>
          m.startsWith('PR creation failed: GitHub auth/permission denied') &&
          m.includes('GITHUB_TOKEN'),
      ),
    ).toBe(true);
  });

  it('logs "PR creation failed: GitHub auth/permission denied" on 403', async () => {
    const ghClient = makeGithubClient({
      createPR: vi
        .fn()
        .mockRejectedValue(new Error('GitHub API error 403: Forbidden')),
    });
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY, 'msg_403');

    await new Promise((r) => setImmediate(r));

    const msgs = loggedMessages();
    expect(
      msgs.some(
        (m) =>
          m.startsWith('PR creation failed: GitHub auth/permission denied') &&
          m.includes('GITHUB_TOKEN'),
      ),
    ).toBe(true);
  });

  it('logs "PR creation failed: GitHub server error (transient" on 5xx and retries', async () => {
    const ghClient = makeGithubClient({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error('GitHub API error 503: Service Unavailable'),
        ),
    });
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY, 'msg_5xx');

    // Let enough microtasks pass for at least the first attempt + log
    await new Promise((r) => setImmediate(r));

    const msgs = loggedMessages();
    expect(
      msgs.some((m) =>
        m.startsWith('PR creation failed: GitHub server error (transient'),
      ),
    ).toBe(true);
  });

  it('logs "PR creation failed: git push" with branch name when push fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task')
        throw new Error('remote: Repository not found.');
      throw new Error(`unexpected execSync: ${cmd}`);
    });

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY, 'msg_push_fail');

    await new Promise((r) => setImmediate(r));

    const msgs = loggedMessages();
    expect(
      msgs.some(
        (m) =>
          m.startsWith('PR creation failed: git push') &&
          m.includes('feature/my-task'),
      ),
    ).toBe(true);
  });
});

describe('<pr-body> marker — backend push before createPR', () => {
  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(recordEvent).mockClear();
    vi.mocked(execSync).mockClear();
    vi.mocked(validatePRBody).mockReturnValue({
      valid: true,
      missingSections: [],
    });
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    // Reset execSync to default happy-path behaviour
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task') return '';
      throw new Error(`unexpected execSync: ${cmd}`);
    });
  });

  it('pushes the branch before calling createPR', async () => {
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    const pushCall = vi
      .mocked(execSync)
      .mock.calls.find((args) =>
        String(args[0]).startsWith('git push -u origin'),
      );
    expect(pushCall).toBeDefined();
    expect(ghClient.createPR).toHaveBeenCalledTimes(1);

    // push must precede createPR — check call order via mock.invocationCallOrder
    const pushOrder = vi
      .mocked(execSync)
      .mock.invocationCallOrder.find((_, i) =>
        String(vi.mocked(execSync).mock.calls[i]?.[0]).startsWith('git push'),
      );
    const createOrder = vi.mocked(ghClient.createPR).mock
      .invocationCallOrder[0];
    expect(pushOrder).toBeDefined();
    expect(createOrder).toBeDefined();
    expect(pushOrder!).toBeLessThan(createOrder!);
  });

  it('upserts PR row after successful push + createPR', async () => {
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 42, session_id: 'test-session-id' }),
    );
  });

  it('records pr_creation_failed (stage push) and skips createPR when push fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task')
        throw new Error('remote: Repository not found.');
      throw new Error(`unexpected execSync: ${cmd}`);
    });

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    expect(ghClient.createPR).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_creation_failed',
        payload: expect.objectContaining({ stage: 'push' }),
      }),
    );
  });

  it('records pr_creation_failed (stage create) and leaves no PR row when createPR fails', async () => {
    const ghClient = makeGithubClient({
      createPR: vi.fn().mockRejectedValue(new Error('422 Validation Failed')),
    });
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY);

    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_creation_failed',
        payload: expect.objectContaining({ stage: 'create' }),
      }),
    );
  });

  it('does NOT re-push when an existing PR is found (idempotent update path)', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      base_branch: 'dev',
    } as never);

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);
    emitAssistantWithMarker(session, VALID_BODY, 'msg_idem');

    await new Promise((r) => setImmediate(r));

    const pushCall = vi
      .mocked(execSync)
      .mock.calls.find((args) =>
        String(args[0]).startsWith('git push -u origin'),
      );
    expect(pushCall).toBeUndefined();
    expect(ghClient.createPR).not.toHaveBeenCalled();
    expect(ghClient.updatePR).toHaveBeenCalledTimes(1);
  });

  it('records pr_creation_failed (stage branch) and re-prompts when worktree is in detached HEAD', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return ''; // detached HEAD
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      throw new Error(`unexpected execSync: ${cmd}`);
    });

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);

    const runner = (
      session as unknown as {
        runner: { sendMessage: ReturnType<typeof vi.fn> };
      }
    ).runner;

    emitAssistantWithMarker(session, VALID_BODY, 'msg_detached');

    await new Promise((r) => setImmediate(r));

    expect(ghClient.createPR).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_creation_failed',
        payload: expect.objectContaining({ stage: 'branch' }),
      }),
    );
    expect(runner.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('detached HEAD'),
    );
  });
});

// ── Integration test: upsertPullRequest returns null ──────────────────────────
// When the repo is not configured in any project, upsertPullRequest returns null.
// handlePRDetected must NOT broadcast pr_created or emit pr_opened in that case,
// so StuckSessionMonitor sees no PR row and routes to idle (not done) when the
// subprocess is still alive — closing the premature-markSessionDone path.

describe('<pr-body> marker — upsertPullRequest returns null (repo not configured)', () => {
  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockReturnValue(null);
    vi.mocked(validatePRBody).mockReturnValue({
      valid: true,
      missingSections: [],
    });
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git symbolic-ref refs/remotes/origin/HEAD')
        return 'refs/remotes/origin/dev\n';
      if (cmd === 'git push -u origin feature/my-task') return '';
      throw new Error(`unexpected execSync: ${cmd}`);
    });
  });

  it('does NOT broadcast pr_created when upsertPullRequest returns null', async () => {
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);

    const broadcastedTypes: string[] = [];
    session.on('message', (msg: { type: string }) =>
      broadcastedTypes.push(msg.type),
    );

    emitAssistantWithMarker(session, VALID_BODY);
    await new Promise((r) => setImmediate(r));

    expect(broadcastedTypes).not.toContain('pr_created');
  });

  it('does NOT emit pr_opened when upsertPullRequest returns null', async () => {
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);

    const prOpenedSpy = vi.fn();
    session.on('pr_opened', prOpenedSpy);

    emitAssistantWithMarker(session, VALID_BODY);
    await new Promise((r) => setImmediate(r));

    expect(prOpenedSpy).not.toHaveBeenCalled();
  });

  it('still calls githubClient.createPR even when upsert will reject the insert', async () => {
    // The PR creation itself succeeds on GitHub-side; only our DB upsert returns null.
    // The PR remains accessible on GitHub but is not tracked in our DB.
    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);

    emitAssistantWithMarker(session, VALID_BODY);
    await new Promise((r) => setImmediate(r));

    expect(ghClient.createPR).toHaveBeenCalledTimes(1);
    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 42 }),
    );
  });
});

// ── Live-detection path: body validation ─────────────────────────────────────
// Regression tests for the false positive where handlePRDetected validated
// prShape.body (empty on the gh pr create stream path) instead of the real
// GitHub body — mirroring the PR #347 incident of 2026-06-10.

function makeFreshPR(body: string | null) {
  return {
    nodeId: 'node1',
    id: 42,
    title: 'feat: my-task',
    body,
    url: PR_URL,
    apiUrl: 'https://api.github.com/repos/owner/repo/pulls/42',
    headBranch: 'feature/my-task',
    headSha: 'abc123',
    baseBranch: 'dev',
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergeableState: null,
    draft: true,
  };
}

function emitLiveDetectedPR(
  session: AgentSession,
  prUrl = PR_URL,
  toolUseId = 'toolu_ghcreate',
) {
  sendEvent(session, {
    type: 'assistant',
    message: {
      id: 'msg_gh_create',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: {
            command:
              'gh pr create --title "feat: my-task" --body-file /tmp/body.md',
          },
        },
      ],
    },
  });
  sendEvent(session, {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: prUrl + '\n',
  });
}

describe('live-detected PR — PR body validation', () => {
  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockReturnValue(1 as never);
    vi.mocked(recordEvent).mockClear();
    vi.mocked(setPauseReason).mockClear();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(validatePRBody).mockReturnValue({
      valid: true,
      missingSections: [],
    });
    (
      runtimeSettings as { corporate_mode_enabled: boolean }
    ).corporate_mode_enabled = false;
  });

  afterEach(() => {
    (
      runtimeSettings as { corporate_mode_enabled: boolean }
    ).corporate_mode_enabled = false;
  });

  it('does NOT record pr_body_invalid_warning when fetched GitHub body is compliant (regression: PR #347)', async () => {
    const ghClient = makeGithubClient({
      fetchPR: vi.fn().mockResolvedValue(makeFreshPR(VALID_BODY)),
    });
    // Simulate the old bug: validatePRBody(null) returns all-missing, but
    // validatePRBody(VALID_BODY) returns valid — fix ensures the fetched body is used.
    vi.mocked(validatePRBody).mockImplementation((body) => {
      if (!body) {
        return {
          valid: false,
          missingSections: [
            '## Summary',
            '## Notion Task',
            '## Automated Tests',
            '## Files Changed',
          ],
        };
      }
      return { valid: true, missingSections: [] };
    });

    const session = makeSession(ghClient);
    emitLiveDetectedPR(session);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const bodyInvalidCalls = vi
      .mocked(recordEvent)
      .mock.calls.filter(
        (args) =>
          args[0]?.event_type === 'pr_body_invalid' ||
          args[0]?.event_type === 'pr_body_invalid_warning',
      );
    expect(bodyInvalidCalls).toHaveLength(0);
  });

  it('records pr_body_invalid_warning with correct missing sections when fetched body is non-compliant', async () => {
    const missing = ['## Summary', '## Files Changed'];
    const ghClient = makeGithubClient({
      fetchPR: vi.fn().mockResolvedValue(makeFreshPR('incomplete body')),
    });
    vi.mocked(validatePRBody).mockReturnValue({
      valid: false,
      missingSections: missing,
    });

    const session = makeSession(ghClient);
    emitLiveDetectedPR(session);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_body_invalid_warning',
        payload: expect.objectContaining({
          missing_sections: missing,
          pr_number: 42,
        }),
      }),
    );
  });

  it('does NOT record a violation when GitHub fetch fails (fail-open)', async () => {
    const ghClient = makeGithubClient({
      fetchPR: vi
        .fn()
        .mockRejectedValue(
          new Error('GitHub API error 503: Service Unavailable'),
        ),
    });

    const session = makeSession(ghClient);
    emitLiveDetectedPR(session);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const bodyInvalidCalls = vi
      .mocked(recordEvent)
      .mock.calls.filter(
        (args) =>
          args[0]?.event_type === 'pr_body_invalid' ||
          args[0]?.event_type === 'pr_body_invalid_warning',
      );
    expect(bodyInvalidCalls).toHaveLength(0);
  });

  it('sets pause reason in corporate mode when fetched body is non-compliant', async () => {
    const missing = ['## Summary', '## Notion Task'];
    const ghClient = makeGithubClient({
      fetchPR: vi.fn().mockResolvedValue(makeFreshPR('incomplete body')),
    });
    vi.mocked(validatePRBody).mockReturnValue({
      valid: false,
      missingSections: missing,
    });
    (
      runtimeSettings as { corporate_mode_enabled: boolean }
    ).corporate_mode_enabled = true;

    const session = makeSession(ghClient);
    emitLiveDetectedPR(session);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'pr_body_invalid',
    );
  });

  it('does NOT set pause reason from empty stream body in corporate mode (false-positive prevention)', async () => {
    const ghClient = makeGithubClient({
      fetchPR: vi.fn().mockResolvedValue(makeFreshPR(VALID_BODY)),
    });
    vi.mocked(validatePRBody).mockReturnValue({
      valid: true,
      missingSections: [],
    });
    (
      runtimeSettings as { corporate_mode_enabled: boolean }
    ).corporate_mode_enabled = true;

    const session = makeSession(ghClient);
    emitLiveDetectedPR(session);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'pr_body_invalid',
    );
  });
});
