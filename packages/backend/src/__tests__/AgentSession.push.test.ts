import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Mock child_process.spawn (must come before imports of AgentSession) ──────

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk: unknown, _enc: unknown, cb: () => void) { cb(); } });
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

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  updateSessionStatus: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
  insertSessionAudit: vi.fn(),
  setSessionModel: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
}));

import { AgentSession, isPushCommand } from '../session/AgentSession';
import { getPRBySessionId } from '../db/queries';
import type { NotionClient } from '../notion/NotionClient';

function fakeNotionClient(): NotionClient {
  return {
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  } as unknown as NotionClient;
}

/** Emit an assistant event with a Bash tool_use block, then a matching tool_result. */
async function simulateBashPush(stdout: Readable, toolUseId: string, command: string) {
  const assistantEvent = {
    type: 'assistant',
    message: {
      id: 'msg-1',
      model: 'claude-sonnet',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command },
        },
      ],
    },
  };
  stdout.push(JSON.stringify(assistantEvent) + '\n');

  await new Promise((r) => setTimeout(r, 10));

  const toolResultEvent = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'text', text: 'Everything up-to-date' }],
  };
  stdout.push(JSON.stringify(toolResultEvent) + '\n');

  await new Promise((r) => setTimeout(r, 20));
}

/** Emit an assistant event with mcp__github__push_files tool_use, then a matching tool_result. */
async function simulatePushFiles(stdout: Readable, toolUseId: string) {
  const assistantEvent = {
    type: 'assistant',
    message: {
      id: 'msg-push-files',
      model: 'claude-sonnet',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'mcp__github__push_files',
          input: { files: [] },
        },
      ],
    },
  };
  stdout.push(JSON.stringify(assistantEvent) + '\n');

  await new Promise((r) => setTimeout(r, 10));

  const toolResultEvent = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'text', text: 'Files pushed.' }],
  };
  stdout.push(JSON.stringify(toolResultEvent) + '\n');

  await new Promise((r) => setTimeout(r, 20));
}

// ── isPushCommand unit tests ──────────────────────────────────────────────────

describe('isPushCommand', () => {
  it('returns true for Bash git push commands', () => {
    expect(isPushCommand('Bash', 'git push origin feature/foo')).toBe(true);
    expect(isPushCommand('Bash', 'git push --force-with-lease origin feature/test')).toBe(true);
    expect(isPushCommand('Bash', 'git  push origin main')).toBe(true);
  });

  it('returns true for mcp__github__push_files', () => {
    expect(isPushCommand('mcp__github__push_files', '')).toBe(true);
    expect(isPushCommand('mcp__github__push_files', 'irrelevant input')).toBe(true);
  });

  it('returns false for git status', () => {
    expect(isPushCommand('Bash', 'git status')).toBe(false);
  });

  it('returns false for git push --dry-run', () => {
    expect(isPushCommand('Bash', 'git push --dry-run origin main')).toBe(false);
  });

  it('returns false for unrelated tool names', () => {
    expect(isPushCommand('mcp__github__create_pull_request', '')).toBe(false);
    expect(isPushCommand('Write', 'git push')).toBe(false);
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentSession — push detection', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('emits push_detected when a git push Bash tool call is detected', async () => {
    const session = new AgentSession(
      'push-session-1',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeNotionClient(),
      '/tmp',
      'task-id',
    );

    const pushEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushEvents.push(e));

    const runPromise = session.run();

    await simulateBashPush(mockProc.stdout, 'tool-id-1', 'git push origin feature/my-branch');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(pushEvents).toHaveLength(1);
    expect(pushEvents[0]).toMatchObject({ sessionId: 'push-session-1' });
  });

  it('broadcasts push_detected WS message when git push is detected', async () => {
    vi.mocked(getPRBySessionId).mockReturnValueOnce({
      pr_number: 7,
      repo: 'owner/repo',
    } as any);

    const session = new AgentSession(
      'push-session-2',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeNotionClient(),
      '/tmp',
      'task-id',
    );

    const messages: unknown[] = [];
    session.on('message', (m: unknown) => messages.push(m));

    const runPromise = session.run();

    await simulateBashPush(mockProc.stdout, 'tool-id-2', 'git push --force-with-lease origin feature/test');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    const pushMsg = messages.find((m: any) => m.type === 'push_detected');
    expect(pushMsg).toBeDefined();
    expect(pushMsg).toMatchObject({ type: 'push_detected', sessionId: 'push-session-2', prNumber: 7, repo: 'owner/repo' });
  });

  it('does NOT emit push_detected for git push --dry-run', async () => {
    const session = new AgentSession(
      'push-session-3',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeNotionClient(),
      '/tmp',
      'task-id',
    );

    const pushEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushEvents.push(e));

    const runPromise = session.run();

    await simulateBashPush(mockProc.stdout, 'tool-id-3', 'git push --dry-run origin feature/test');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(pushEvents).toHaveLength(0);
  });

  it('does NOT emit push_detected for unrelated Bash commands', async () => {
    const session = new AgentSession(
      'push-session-4',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeNotionClient(),
      '/tmp',
      'task-id',
    );

    const pushEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushEvents.push(e));

    const runPromise = session.run();

    await simulateBashPush(mockProc.stdout, 'tool-id-4', 'git status');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(pushEvents).toHaveLength(0);
  });

  it('emits push_detected when mcp__github__push_files tool_result is received', async () => {
    const session = new AgentSession(
      'push-session-mcp',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeNotionClient(),
      '/tmp',
      'task-id',
    );

    const pushEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushEvents.push(e));

    const runPromise = session.run();

    await simulatePushFiles(mockProc.stdout, 'tool-mcp-push-1');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(pushEvents).toHaveLength(1);
    expect(pushEvents[0]).toMatchObject({ sessionId: 'push-session-mcp' });
  });

  it('does NOT emit push_detected when tool_result does not match a pending push command', async () => {
    const session = new AgentSession(
      'push-session-5',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeNotionClient(),
      '/tmp',
      'task-id',
    );

    const pushEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushEvents.push(e));

    const runPromise = session.run();

    // Emit tool_result with an ID that was never in pendingBashCommands
    const toolResultEvent = {
      type: 'tool_result',
      tool_use_id: 'unknown-tool-id',
      content: [{ type: 'text', text: 'result' }],
    };
    mockProc.stdout.push(JSON.stringify(toolResultEvent) + '\n');
    await new Promise((r) => setTimeout(r, 20));

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(pushEvents).toHaveLength(0);
  });
});
