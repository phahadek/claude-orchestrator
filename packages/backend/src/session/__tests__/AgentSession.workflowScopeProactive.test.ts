import { describe, it, expect, vi } from 'vitest';
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
    setSessionPauseReason: vi.fn(),
    insertPauseInterval: vi.fn(),
    getLatestTestRequestRun: vi.fn().mockReturnValue({
      id: 'run-1',
      project_id: 'proj',
      content_hash: 'hash',
      state: 'passed',
      output: '',
      started_at: 0,
      finished_at: 1,
    }),
  }),
);

vi.mock('../analyzeGating', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzeGating')>();
  return {
    ...actual,
    computeWholeTreeContentHash: vi.fn().mockResolvedValue('hash'),
  };
});

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  GITHUB_REPO: 'owner/repo',
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: { corporate_mode_enabled: false },
  getProjectById: vi.fn(() => undefined),
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
    if (cmd === 'git diff --name-only dev...feature/my-task')
      return 'packages/backend/src/foo.ts\n';
    if (cmd === 'git push -u origin feature/my-task') return '';
    throw new Error(`unexpected: ${cmd}`);
  }),
  execFile: vi.fn((...args: unknown[]) => {
    (args[args.length - 1] as (err: unknown, out: unknown) => void)(null, {
      stdout: '',
      stderr: '',
    });
  }),
  exec: vi.fn((...args: unknown[]) => {
    (args[args.length - 1] as (err: unknown, out: unknown) => void)(null, {
      stdout: '',
      stderr: '',
    });
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
import { getPRBySessionId, setSessionPauseReason } from '../../db/queries';
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

function makeGithubClient(overrides: Record<string, unknown> = {}) {
  return {
    createPR: vi.fn().mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
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

describe('<pr-body> marker — proactive workflow-scope diff check', () => {
  it('short-circuits into workflow_scope_denied without attempting the push when the branch diff matches the denylist', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git diff --name-only dev...feature/my-task')
        return '.github/workflows/build.yml\n';
      if (cmd === 'git push -u origin feature/my-task')
        throw new Error('should not be called');
      throw new Error(`unexpected: ${cmd}`);
    });

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);

    emitAssistantWithMarker(session, VALID_BODY);
    await new Promise((r) => setImmediate(r));

    // No push attempted, no PR created.
    const pushCalls = vi
      .mocked(execSync)
      .mock.calls.filter(([cmd]) =>
        (cmd as string).startsWith('git push -u origin'),
      );
    expect(pushCalls).toHaveLength(0);
    expect(ghClient.createPR).not.toHaveBeenCalled();

    // Paused immediately as workflow_scope_denied.
    expect(setSessionPauseReason).toHaveBeenCalledOnce();
    const [sessionId, rawReason] = vi.mocked(setSessionPauseReason).mock
      .calls[0];
    expect(sessionId).toBe('test-session-id');
    const parsed = JSON.parse(rawReason);
    expect(parsed.reason).toBe('workflow_scope_denied');
    expect(parsed.severity).toBe('needs_attention');
  });

  it('proceeds to push when the branch diff does not touch a denylisted path', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(setSessionPauseReason).mockClear();
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      if (cmd === 'git diff --name-only dev...feature/my-task')
        return 'packages/backend/src/foo.ts\n';
      if (cmd === 'git push -u origin feature/my-task') return '';
      throw new Error(`unexpected: ${cmd}`);
    });

    const ghClient = makeGithubClient();
    const session = makeSession(ghClient);

    emitAssistantWithMarker(session, VALID_BODY);
    await new Promise((r) => setImmediate(r));

    const pushCalls = vi
      .mocked(execSync)
      .mock.calls.filter(([cmd]) =>
        (cmd as string).startsWith('git push -u origin'),
      );
    expect(pushCalls.length).toBeGreaterThan(0);
    expect(ghClient.createPR).toHaveBeenCalled();
  });
});
