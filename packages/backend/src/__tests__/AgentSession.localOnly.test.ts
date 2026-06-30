import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Mock child_process.spawn (before any imports that pull in AgentSession) ──

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

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execSync: vi.fn(),
}));

// ── Mock DB queries ────────────────────────────────────────────────────────────

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  updateSessionStatus: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
  setContextOccupancy: vi.fn(),
  insertSessionAudit: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  getProjectRowById: vi.fn(),
  insertLocalBranch: vi.fn(() => ({
    id: 1,
    project_id: 'proj-local',
    session_id: 'sess-local',
    branch_name: 'feature/my-task',
    base_branch: 'dev',
    status: 'open',
    review_result: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  })),
}));

// ── Mock localBranchHelpers ───────────────────────────────────────────────────

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(),
  hasNonEmptyDiff: vi.fn(),
}));

// ── Imports (after all vi.mock calls) ─────────────────────────────────────────

import { AgentSession } from '../session/AgentSession';
import { insertLocalBranch, getProjectRowById } from '../db/queries';
import {
  getCurrentBranch,
  hasNonEmptyDiff,
} from '../orchestration/localBranchHelpers';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { ServerMessage } from '../ws/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeTaskBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
  };
}

function makeLocalOnlyProject() {
  return {
    id: 'proj-local',
    name: 'Local Proj',
    project_dir: '/repos/local',
    context_url: null,
    github_repo: null,
    task_source: 'notion',
    git_mode: 'local-only',
    auto_launch_enabled: 0,
    auto_launch_milestone_id: null,
    auto_merge_enabled: 0,
    created_at: 1000,
    updated_at: 1000,
  };
}

function makeGithubProject() {
  return { ...makeLocalOnlyProject(), git_mode: 'github' };
}

/** Run a session to clean exit (exit code 0) and collect messages. */
async function runToCleanExit(session: AgentSession): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = [];
  session.on('message', (m: ServerMessage) => messages.push(m));

  const runPromise = session.run();

  mockProc.stdout.push(null);
  await new Promise((r) => setTimeout(r, 0));
  mockProc.proc.emit('exit', 0);
  await runPromise;

  return messages;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentSession — local-only submission detection', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('emits local_branch_submitted and inserts row on non-empty diff (gitMode: local-only)', async () => {
    const backend = fakeTaskBackend();
    vi.mocked(getProjectRowById).mockReturnValue(makeLocalOnlyProject() as any);
    vi.mocked(getCurrentBranch).mockResolvedValue('feature/my-task');
    vi.mocked(hasNonEmptyDiff).mockResolvedValue(true);

    const session = new AgentSession(
      'sess-local',
      'https://notion.so/task',
      'https://notion.so/ctx',
      backend,
      '/worktree/path',
      'task-id-123',
      undefined,
      undefined,
      'standard',
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      'proj-local',
    );

    const messages = await runToCleanExit(session);

    const submittedMsg = messages.find(
      (m) => m.type === 'local_branch_submitted',
    );
    expect(submittedMsg).toBeDefined();
    expect(submittedMsg).toMatchObject({
      type: 'local_branch_submitted',
      projectId: 'proj-local',
      sessionId: 'sess-local',
      branchName: 'feature/my-task',
      baseBranch: 'dev',
    });

    expect(insertLocalBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'proj-local',
        session_id: 'sess-local',
        branch_name: 'feature/my-task',
        base_branch: 'dev',
        status: 'open',
      }),
    );

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'task-id-123',
      '👀 In Review',
    );
  });

  it('emits no event and inserts no row when diff is empty (gitMode: local-only)', async () => {
    vi.mocked(getProjectRowById).mockReturnValue(makeLocalOnlyProject() as any);
    vi.mocked(getCurrentBranch).mockResolvedValue('feature/my-task');
    vi.mocked(hasNonEmptyDiff).mockResolvedValue(false);

    const session = new AgentSession(
      'sess-empty-diff',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree/path',
      'task-id-456',
      undefined,
      undefined,
      'standard',
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      'proj-local',
    );

    const messages = await runToCleanExit(session);

    const submittedMsg = messages.find(
      (m) => m.type === 'local_branch_submitted',
    );
    expect(submittedMsg).toBeUndefined();
    expect(insertLocalBranch).not.toHaveBeenCalled();
  });

  it('does not emit local_branch_submitted for gitMode: github sessions (regression)', async () => {
    vi.mocked(getProjectRowById).mockReturnValue(makeGithubProject() as any);
    vi.mocked(getCurrentBranch).mockResolvedValue('feature/my-task');
    vi.mocked(hasNonEmptyDiff).mockResolvedValue(true);

    const session = new AgentSession(
      'sess-github',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree/path',
      'task-id-789',
      undefined,
      undefined,
      'standard',
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      'proj-github',
    );

    const messages = await runToCleanExit(session);

    const submittedMsg = messages.find(
      (m) => m.type === 'local_branch_submitted',
    );
    expect(submittedMsg).toBeUndefined();
    expect(insertLocalBranch).not.toHaveBeenCalled();
  });
});
