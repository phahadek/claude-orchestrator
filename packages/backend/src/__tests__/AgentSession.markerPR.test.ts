import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Mock child_process (before imports that pull in AgentSession) ──────────────

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk: unknown, _enc: unknown, cb: () => void) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 12345,
    exitCode: null,
  });
  return { proc, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;
let mockExecSync: ReturnType<typeof vi.fn>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execFile: vi.fn(),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// ── Mock DB queries ────────────────────────────────────────────────────────────

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
  incrementCompactionCount: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSession: vi.fn(() => null),
  getProjectRowById: vi.fn(() => null),
  insertLocalBranch: vi.fn(),
}));

// ── Mock config — getProjectById controlled per test ──────────────────────────

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return {
    ...actual,
    ALLOWED_TOOLS: [],
    GITHUB_REPO: 'fallback/repo',
    runtimeSettings: { sessionMode: 'cli' },
    getProjectById: vi.fn(),
  };
});

// ── Mock other dependencies ───────────────────────────────────────────────────

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/some-task'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));

vi.mock('../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi.fn().mockImplementation(() => ({
    investigate: vi.fn(async () => {}),
  })),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

// ── Imports (after all vi.mock calls) ─────────────────────────────────────────

import { AgentSession } from '../session/AgentSession';
import { getProjectById } from '../config';
import type { GitHubClient } from '../github/GitHubClient';
import type { TaskBackend } from '../tasks/TaskBackend';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_PR_BODY = `## Summary
Fix the base branch bug.

## Notion Task
https://notion.so/task-123

## Automated Tests
No test changes.

## Files Changed
- packages/backend/src/session/AgentSession.ts`;

function fakeTaskBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
  };
}

function fakeGithubClient(
  createdPR: Partial<{
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
  }> = {},
): GitHubClient {
  const defaults = {
    number: 42,
    html_url: 'https://github.com/owner/repo/pull/42',
    title: 'feat: my-task',
    body: VALID_PR_BODY,
    head: { ref: 'feature/my-task', sha: 'abc123' },
    base: { ref: createdPR.base?.ref ?? 'dev' },
    state: 'open',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    draft: true,
  };
  return {
    createPR: vi.fn(async () => ({ ...defaults, ...createdPR })),
    updatePR: vi.fn(async () => ({})),
  } as unknown as GitHubClient;
}

/** Emit an assistant text event containing <pr-body> marker and wait for processing. */
async function emitPRBodyMarker(
  proc: ReturnType<typeof createMockProc>,
  body: string,
  messageId = 'msg-marker-1',
) {
  const event = JSON.stringify({
    type: 'assistant',
    message: {
      id: messageId,
      content: [
        {
          type: 'text',
          text: `Here is the PR body:\n<pr-body>${body}</pr-body>`,
        },
      ],
    },
  });
  proc.stdout.push(event + '\n');
  await new Promise((r) => setTimeout(r, 80));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentSession — handlePRBodyMarker base branch resolution', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    mockExecSync = vi.fn((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      throw new Error(`unexpected execSync: ${cmd}`);
    });
    vi.clearAllMocks();
    // Re-register execSync behaviour after clearAllMocks
    mockExecSync = vi.fn((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'feature/my-task\n';
      if (cmd === 'git remote get-url origin')
        return 'https://github.com/owner/repo.git\n';
      throw new Error(`unexpected execSync: ${cmd}`);
    });
  });

  it('uses project.baseBranch (dev) from config — not origin/HEAD', async () => {
    vi.mocked(getProjectById).mockReturnValue({
      id: 'proj-dev',
      name: 'Dev Project',
      baseBranch: 'dev',
    } as ReturnType<typeof getProjectById>);

    const github = fakeGithubClient({ base: { ref: 'dev' } });
    const session = new AgentSession(
      'sess-marker-dev',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree',
      'task-1',
      undefined,
      undefined,
      'standard',
      undefined,
      github,
      [],
      undefined,
      undefined,
      'proj-dev',
    );

    const runPromise = session.run();
    await emitPRBodyMarker(mockProc, VALID_PR_BODY);

    expect(github.createPR).toHaveBeenCalledWith(
      'owner/repo',
      expect.objectContaining({ base: 'dev' }),
    );

    // Verify origin/HEAD was never queried
    const execCalls = (mockExecSync as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(execCalls.some((c) => c.includes('symbolic-ref'))).toBe(false);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('uses project.baseBranch (main) for a project whose integration branch is main', async () => {
    vi.mocked(getProjectById).mockReturnValue({
      id: 'proj-main',
      name: 'Main Project',
      baseBranch: 'main',
    } as ReturnType<typeof getProjectById>);

    const github = fakeGithubClient({ base: { ref: 'main' } });
    const session = new AgentSession(
      'sess-marker-main',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree',
      'task-2',
      undefined,
      undefined,
      'standard',
      undefined,
      github,
      [],
      undefined,
      undefined,
      'proj-main',
    );

    const runPromise = session.run();
    await emitPRBodyMarker(mockProc, VALID_PR_BODY, 'msg-marker-2');

    expect(github.createPR).toHaveBeenCalledWith(
      'owner/repo',
      expect.objectContaining({ base: 'main' }),
    );

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('falls back to dev when getProjectById returns undefined', async () => {
    vi.mocked(getProjectById).mockReturnValue(undefined);

    const github = fakeGithubClient({ base: { ref: 'dev' } });
    const session = new AgentSession(
      'sess-marker-fallback',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree',
      'task-3',
      undefined,
      undefined,
      'standard',
      undefined,
      github,
      [],
      undefined,
      undefined,
      '',
    );

    const runPromise = session.run();
    await emitPRBodyMarker(mockProc, VALID_PR_BODY, 'msg-marker-3');

    expect(github.createPR).toHaveBeenCalledWith(
      'owner/repo',
      expect.objectContaining({ base: 'dev' }),
    );

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });
});
