import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Mock child_process.spawn ───────────────────────────────────────────────
// We need to mock before importing AgentSession because it imports spawn
// at the module level.

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
}));

// Mock DB queries — these would hit a real SQLite db otherwise
vi.mock('../db/queries', () => ({
  insertEvent: vi.fn(),
  insertPermissionEvent: vi.fn(),
  updateSessionStatus: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  getRules: vi.fn(() => []),
}));

import { AgentSession } from '../session/AgentSession';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';
import { getRules } from '../db/queries';
import type { PermissionRule } from '../db/types';

function fakeNotionClient(): NotionClient {
  return {
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  } as unknown as NotionClient;
}

describe('AgentSession', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  // ── AC: Auto-allow writes { type: 'approve' } to stdin ──────────────────
  it('auto-allows and writes { type: "approve" } to stdin when rule matches allow', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession('s1', 'https://notion.so/task', 'https://notion.so/ctx', notion, '/tmp');

    vi.mocked(getRules).mockReturnValue([
      { id: 1, order_index: 0, pattern: 'Read', match_type: 'glob', decision: 'allow', label: null, enabled: 1 } as PermissionRule,
    ]);

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    // Emit a permission event on stdout
    mockProc.stdout.push(JSON.stringify({ type: 'permission', tool_name: 'Read', tool_input: {} }) + '\n');

    // Give the event loop time to process
    await new Promise((r) => setTimeout(r, 50));

    expect(mockProc.stdinChunks).toContain(JSON.stringify({ type: 'approve' }) + '\n');

    // Clean up — close the process
    mockProc.proc.emit('close', 0);
    await runPromise;
  });

  // ── AC: Auto-deny writes { type: 'deny', reason } to stdin ──────────────
  it('auto-denies and writes { type: "deny", reason } to stdin when rule matches deny', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession('s2', 'https://notion.so/task', 'https://notion.so/ctx', notion, '/tmp');

    vi.mocked(getRules).mockReturnValue([
      { id: 1, order_index: 0, pattern: 'Bash*', match_type: 'glob', decision: 'deny', label: null, enabled: 1 } as PermissionRule,
    ]);

    const runPromise = session.run();

    mockProc.stdout.push(JSON.stringify({ type: 'permission', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }) + '\n');
    await new Promise((r) => setTimeout(r, 50));

    const denyMsg = mockProc.stdinChunks.find((c) => c.includes('"deny"'));
    expect(denyMsg).toBeDefined();
    const parsed = JSON.parse(denyMsg!.trim());
    expect(parsed.type).toBe('deny');
    expect(parsed.reason).toBe('Auto-denied by rule');

    mockProc.proc.emit('close', 0);
    await runPromise;
  });

  // ── AC: approve() and deny() resolve pending permission promise ──────────
  it('approve() resolves pending permission and writes approve to stdin', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession('s3', 'https://notion.so/task', 'https://notion.so/ctx', notion, '/tmp');

    // No rules → escalates to UI
    vi.mocked(getRules).mockReturnValue([]);

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    mockProc.stdout.push(JSON.stringify({ type: 'permission', tool_name: 'Write', tool_input: {} }) + '\n');
    await new Promise((r) => setTimeout(r, 50));

    // Should have emitted a permission_request
    const permReq = messages.find((m) => m.type === 'permission_request');
    expect(permReq).toBeDefined();

    // Simulate user approving
    session.approve();
    await new Promise((r) => setTimeout(r, 50));

    expect(mockProc.stdinChunks).toContain(JSON.stringify({ type: 'approve' }) + '\n');

    mockProc.proc.emit('close', 0);
    await runPromise;
  });

  it('deny() resolves pending permission and writes deny with reason to stdin', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession('s4', 'https://notion.so/task', 'https://notion.so/ctx', notion, '/tmp');

    vi.mocked(getRules).mockReturnValue([]);

    const runPromise = session.run();

    mockProc.stdout.push(JSON.stringify({ type: 'permission', tool_name: 'Bash', tool_input: {} }) + '\n');
    await new Promise((r) => setTimeout(r, 50));

    session.deny('Not allowed');
    await new Promise((r) => setTimeout(r, 50));

    const denyMsg = mockProc.stdinChunks.find((c) => c.includes('"deny"'));
    expect(denyMsg).toBeDefined();
    const parsed = JSON.parse(denyMsg!.trim());
    expect(parsed.type).toBe('deny');
    expect(parsed.reason).toBe('Not allowed');

    mockProc.proc.emit('close', 0);
    await runPromise;
  });

  // ── AC: PR URL regex matches GitHub PR URLs ──────────────────────────────
  it('PR URL regex matches valid GitHub PR URLs', () => {
    const PR_URL_REGEX = /https:\/\/github\.com\/.+\/pull\/\d+/;

    expect(PR_URL_REGEX.test('https://github.com/owner/repo/pull/123')).toBe(true);
    expect(PR_URL_REGEX.test('https://github.com/my-org/my-repo/pull/1')).toBe(true);
    expect(PR_URL_REGEX.test('https://github.com/a/b/pull/99999')).toBe(true);
    expect(PR_URL_REGEX.test('https://github.com/owner/repo/issues/123')).toBe(false);
    expect(PR_URL_REGEX.test('https://gitlab.com/owner/repo/pull/123')).toBe(false);
    expect(PR_URL_REGEX.test('not a url')).toBe(false);
  });
});
