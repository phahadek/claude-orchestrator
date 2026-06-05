import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdinChunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString());
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 12345,
  });
  return { proc, stdinChunks, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execFile: vi.fn(),
}));

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  insertPermissionEvent: vi.fn(),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  getDenialsBySession: vi.fn(() => []),
  getRules: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  insertSessionAudit: vi.fn(),
  getPRByNotionTaskId: vi.fn(() => null),
  incrementTokens: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  getSession: vi.fn(() => null),
  getProjectRowById: vi.fn(() => null),
  insertLocalBranch: vi.fn(),
  setSessionMetadata: vi.fn(),
  setSessionTags: vi.fn(),
  getSessionTags: vi.fn(() => []),
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  incrementCompactionCount: vi.fn(),
}));

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

import { AgentSession } from '../session/AgentSession';
import type { NotionClient } from '../notion/NotionClient';

function fakeNotionClient(): NotionClient {
  return {
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  } as unknown as NotionClient;
}

const WORKTREE = 'C:\\Users\\phadek\\IdeaProjects\\project\\.claude\\worktrees\\abc';

// Helper: emit an assistant event with a single tool_use block
function makeAssistantToolUseEvent(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId = 'tu-1',
) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg-1',
      content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }],
    },
  });
}

describe('AgentSession — in-flight worktree-escape detection', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('sends a warning when Write targets a path outside the worktree', async () => {
    const session = new AgentSession(
      'sess-escape',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeNotionClient(),
      WORKTREE,
    );

    const runPromise = session.run();

    mockProc.stdout.push(
      makeAssistantToolUseEvent('Write', {
        file_path: 'C:\\Users\\phadek\\outside\\file.ts',
        content: '',
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    // A warning message should be injected into stdin
    const warns = mockProc.stdinChunks.filter(
      (c) => c.includes('⚠️') && c.includes('Worktree escape detected'),
    );
    expect(warns.length).toBeGreaterThan(0);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('does NOT send a warning when Bash redirects to /dev/null', async () => {
    const session = new AgentSession(
      'sess-devnull',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeNotionClient(),
      WORKTREE,
    );

    const runPromise = session.run();

    // Initial stdin chunk is the session prompt
    const initialLen = mockProc.stdinChunks.length;

    mockProc.stdout.push(
      makeAssistantToolUseEvent('Bash', { command: 'npm run build > /dev/null 2>&1' }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    // No extra warning should be injected
    const newChunks = mockProc.stdinChunks.slice(initialLen);
    const warns = newChunks.filter(
      (c) => c.includes('⚠️') && c.includes('Worktree escape detected'),
    );
    expect(warns).toHaveLength(0);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('deduplicates warnings for the same tool_use_id across streaming chunks', async () => {
    const session = new AgentSession(
      'sess-dedup',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeNotionClient(),
      WORKTREE,
    );

    const runPromise = session.run();

    // Emit the same message_id / tool_use_id twice (streaming dedup scenario)
    const event = makeAssistantToolUseEvent(
      'Write',
      { file_path: 'C:\\Users\\phadek\\outside\\file.ts', content: '' },
      'tu-dedup',
    );
    mockProc.stdout.push(event + '\n');
    await new Promise((r) => setTimeout(r, 10));
    mockProc.stdout.push(event + '\n');
    await new Promise((r) => setTimeout(r, 50));

    const warns = mockProc.stdinChunks.filter(
      (c) => c.includes('⚠️') && c.includes('Worktree escape detected'),
    );
    // Must warn exactly once per unique tool_use_id
    expect(warns).toHaveLength(1);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('does NOT send a warning when Write is inside the worktree', async () => {
    const session = new AgentSession(
      'sess-inside',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeNotionClient(),
      WORKTREE,
    );

    const runPromise = session.run();
    const initialLen = mockProc.stdinChunks.length;

    mockProc.stdout.push(
      makeAssistantToolUseEvent('Write', {
        file_path: `${WORKTREE}\\src\\index.ts`,
        content: '',
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    const newChunks = mockProc.stdinChunks.slice(initialLen);
    const warns = newChunks.filter(
      (c) => c.includes('⚠️') && c.includes('Worktree escape detected'),
    );
    expect(warns).toHaveLength(0);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });
});
