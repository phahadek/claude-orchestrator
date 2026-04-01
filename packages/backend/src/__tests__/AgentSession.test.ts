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
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
}));

import { AgentSession } from '../session/AgentSession';
import { spawn } from 'child_process';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';
import { getRules, getEventsBySession, updateSessionStatus } from '../db/queries';
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

  // ── AC: resumeSessionId prepends --resume to spawn args ─────────────────
  it('prepends --resume <id> to spawn args when resumeSessionId is set', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);

    const session = new AgentSession(
      'new-id',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      'orig-session-id',
    );

    const runPromise = session.run();

    // spawn is called synchronously at the start of run(), so args are available now
    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const resumeIdx = spawnArgs.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(spawnArgs[resumeIdx + 1]).toBe('orig-session-id');

    // Clean up — push null to close readline, then emit exit
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('does not send initial prompt to stdin when resumeSessionId is set', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);

    const session = new AgentSession(
      'new-id',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      'orig-session-id',
    );

    session.run();

    // Resumed sessions skip the initial prompt — stdin should be empty at start
    expect(mockProc.stdinChunks).toHaveLength(0);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
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

  // ── AC: customPrompt is used instead of generated prompt ─────────────────
  it('sends customPrompt to stdin instead of the generated Notion prompt', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);

    const customPrompt = 'My custom review prompt content';
    // Pass customPrompt as 8th arg, sessionType as 9th
    const session = new AgentSession(
      'custom-prompt-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      undefined,
      customPrompt,
    );

    session.run();

    // The custom prompt should be sent to stdin, not the generated "Fetch both Notion pages" text
    expect(mockProc.stdinChunks.some((c) => c.includes(customPrompt))).toBe(true);
    expect(mockProc.stdinChunks.some((c) => c.includes('Fetch both Notion pages'))).toBe(false);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
  });

  // ── AC: sessionType=review skips Notion calls in handleCleanExit ──────────
  it('skips notionClient.updateStatus and attachPR when sessionType is review', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    // Return an event with no PR URL so we focus on updateStatus
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const session = new AgentSession(
      'review-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      undefined,
      undefined,
      'review',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(notion.updateStatus).not.toHaveBeenCalled();
    expect(notion.attachPR).not.toHaveBeenCalled();

    const ended = messages.find((m) => m.type === 'session_ended');
    expect(ended).toBeDefined();
  });

  // ── AC: sessionType=standard still calls notionClient.updateStatus ────────
  it('calls notionClient.updateStatus on clean exit when sessionType is standard', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const session = new AgentSession(
      'standard-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const runPromise = session.run();

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(notion.updateStatus).toHaveBeenCalledWith('task-id', '👀 In Review');
  });
});
