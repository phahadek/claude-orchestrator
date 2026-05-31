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
  execFile: vi.fn(),
}));

// Mock DB queries — these would hit a real SQLite db otherwise
vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  insertPermissionEvent: vi.fn(),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  getRules: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  insertSessionAudit: vi.fn(),
  incrementTokens: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  getSession: vi.fn(() => null),
  getProjectRowById: vi.fn(() => null),
  insertLocalBranch: vi.fn(),
  setSessionMetadata: vi.fn(),
}));

// Mock local branch helpers to avoid real git calls in tests
vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/some-task'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));

// Mock NoOpInvestigator so we can verify dispatch without real sessions
vi.mock('../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi.fn().mockImplementation(() => ({
    investigate: vi.fn(async () => {}),
  })),
}));

// Mock AuditLog to avoid real SQLite writes and to spy on recordEvent calls
vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { AgentSession } from '../session/AgentSession';
import { spawn } from 'child_process';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';
import {
  getRules,
  getEventsBySession,
  upsertSessionEvent,
  markSessionDone,
  getPRBySessionId,
  getPRByNumber,
  setPauseReason,
} from '../db/queries';
import { parseNotionPageIdDashed } from '../session/AgentSession';
import { NoOpInvestigator } from '../github/NoOpInvestigator';
import { hasNonEmptyDiff } from '../orchestration/localBranchHelpers';
import { recordEvent } from '../audit/AuditLog';

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

  // ── AC: permission events are broadcast as session_event (engine removed) ─
  // The permission engine (auto-allow/deny rules, UI escalation) was removed
  // in favour of --permission-mode acceptEdits + --allowed-tools. `permission`
  // events from the CLI are now treated as regular system events — stored in
  // DB and broadcast as session_event to the UI.
  it('broadcasts permission event as session_event when CLI emits it', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession(
      's1',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
    );

    vi.mocked(getRules).mockReturnValue([]);

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    mockProc.stdout.push(
      JSON.stringify({
        type: 'permission',
        tool_name: 'Read',
        tool_input: {},
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    // permission events are broadcast as session_event (type=system)
    const sessionEvents = messages.filter((m) => m.type === 'session_event');
    expect(sessionEvents).toHaveLength(1);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('does NOT write approve/deny to stdin for permission events (engine removed)', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession(
      's2',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
    );

    vi.mocked(getRules).mockReturnValue([]);

    const runPromise = session.run();

    mockProc.stdout.push(
      JSON.stringify({
        type: 'permission',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    // Only the initial prompt should have been written — no approve/deny response
    expect(mockProc.stdinChunks).toHaveLength(1);
    expect(mockProc.stdinChunks[0]).toContain('"role":"user"');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  // ── AC: approve() and deny() are safe no-ops ─────────────────────────────
  // These were removed when the interactive permission engine was replaced by
  // --permission-mode acceptEdits. They must not throw when called.
  it('approve() is a safe no-op and does not write to stdin', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession(
      's3',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
    );

    vi.mocked(getRules).mockReturnValue([]);

    const runPromise = session.run();
    const initialChunks = mockProc.stdinChunks.length;

    expect(() => session.approve()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    // No extra data written to stdin by approve()
    expect(mockProc.stdinChunks).toHaveLength(initialChunks);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('deny() is a safe no-op and does not write to stdin', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession(
      's4',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
    );

    vi.mocked(getRules).mockReturnValue([]);

    const runPromise = session.run();
    const initialChunks = mockProc.stdinChunks.length;

    expect(() => session.deny('Not allowed')).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    // No extra data written to stdin by deny()
    expect(mockProc.stdinChunks).toHaveLength(initialChunks);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
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

    expect(PR_URL_REGEX.test('https://github.com/owner/repo/pull/123')).toBe(
      true,
    );
    expect(PR_URL_REGEX.test('https://github.com/my-org/my-repo/pull/1')).toBe(
      true,
    );
    expect(PR_URL_REGEX.test('https://github.com/a/b/pull/99999')).toBe(true);
    expect(PR_URL_REGEX.test('https://github.com/owner/repo/issues/123')).toBe(
      false,
    );
    expect(PR_URL_REGEX.test('https://gitlab.com/owner/repo/pull/123')).toBe(
      false,
    );
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
    expect(mockProc.stdinChunks.some((c) => c.includes(customPrompt))).toBe(
      true,
    );
    expect(
      mockProc.stdinChunks.some((c) => c.includes('Fetch both Notion pages')),
    ).toBe(false);

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

  // ── AC: dedup — two assistant events with same message.id update existing row ──
  it('when two assistant events share the same message.id, upserts (updates) existing row', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    // First upsert returns row ID 42; subsequent calls return 1 (not reached for second call)
    vi.mocked(upsertSessionEvent).mockReturnValueOnce(42).mockReturnValue(1);

    const session = new AgentSession(
      's-dedup',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );
    const runPromise = session.run();

    const msgA1 = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg-A', content: [{ type: 'text', text: 'partial' }] },
    });
    const msgA2 = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg-A', content: [{ type: 'text', text: 'full text' }] },
    });

    mockProc.stdout.push(msgA1 + '\n');
    mockProc.stdout.push(msgA2 + '\n');
    await new Promise((r) => setTimeout(r, 50));

    const calls = vi.mocked(upsertSessionEvent).mock.calls;
    // First call: no existingId — insert
    expect(calls[0][1]).toBeUndefined();
    expect(calls[0][0].message_id).toBe('msg-A');
    // Second call: existingId = 42 — update
    expect(calls[1][1]).toBe(42);
    expect(calls[1][0].message_id).toBe('msg-A');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  // ── AC: dedup — events without message.id are always inserted as new rows ──
  it('events without a message.id are always inserted as new rows', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(upsertSessionEvent).mockReturnValue(1);

    const session = new AgentSession(
      's-no-id',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );
    const runPromise = session.run();

    // Two system events (no message.id)
    mockProc.stdout.push(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n',
    );
    mockProc.stdout.push(
      JSON.stringify({ type: 'system', subtype: 'success' }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    const calls = vi.mocked(upsertSessionEvent).mock.calls;
    // Both calls must have existingId = undefined (always insert)
    expect(calls[0][1]).toBeUndefined();
    expect(calls[1][1]).toBeUndefined();
    // Neither should have a message_id
    expect(calls[0][0].message_id).toBeNull();
    expect(calls[1][0].message_id).toBeNull();

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  // ── AC: system-only user events — stored in DB but NOT broadcast ────────────
  it('stores system-only user event in DB but does NOT broadcast it', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(upsertSessionEvent).mockReturnValue(1);

    const session = new AgentSession(
      's-filter',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );
    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    const systemOnlyEvent = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content:
          '<system-reminder>CLAUDE.md bootstrap content</system-reminder>',
      },
    });
    mockProc.stdout.push(systemOnlyEvent + '\n');
    await new Promise((r) => setTimeout(r, 50));

    // Must be stored in DB
    expect(vi.mocked(upsertSessionEvent)).toHaveBeenCalled();
    const storedPayload =
      vi.mocked(upsertSessionEvent).mock.calls[0][0].payload;
    expect(storedPayload).toBe(systemOnlyEvent);

    // Must NOT be broadcast as session_event
    const sessionEvents = messages.filter((m) => m.type === 'session_event');
    expect(sessionEvents).toHaveLength(0);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('stores AND broadcasts user event with real human message', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(upsertSessionEvent).mockReturnValue(1);

    const session = new AgentSession(
      's-real-msg',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );
    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    const realUserEvent = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Please implement the feature.' },
    });
    mockProc.stdout.push(realUserEvent + '\n');
    await new Promise((r) => setTimeout(r, 50));

    // Must be stored in DB
    expect(vi.mocked(upsertSessionEvent)).toHaveBeenCalled();

    // Must be broadcast as session_event
    const sessionEvents = messages.filter((m) => m.type === 'session_event');
    expect(sessionEvents).toHaveLength(1);
    expect((sessionEvents[0] as { content: string }).content).toBe(
      realUserEvent,
    );

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  // ── AC: handleCleanExit() calls updateStatus In Review only when PR URL found ──
  it('calls notionClient.updateStatus In Review when a PR URL is found at exit', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'standard-pr-session',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'PR: https://github.com/owner/repo/pull/7',
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);

    const session = new AgentSession(
      'standard-pr-session',
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

  // ── AC: handleCleanExit() does NOT regress a merged PR back to In Review ──
  // After a Merge click, the merge flow sets the local PR row to state='merged'
  // and the Notion task to '✅ Done'. handleCleanExit then fires for the ended
  // session and must NOT write '👀 In Review' on top of that.
  it('does NOT call updateStatus In Review when the PR row is already merged', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'merged-pr-session',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'PR: https://github.com/owner/repo/pull/9',
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue({
      pr_number: 9,
      repo: 'owner/repo',
      state: 'merged',
    } as never);

    const session = new AgentSession(
      'merged-pr-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(notion.updateStatus).not.toHaveBeenCalled();
    const statusBroadcasts = messages.filter(
      (m) => m.type === 'task_status_changed',
    );
    expect(statusBroadcasts).toHaveLength(0);
  });

  it('does NOT call updateStatus In Review when the PR row is closed', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'closed-pr-session',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'PR: https://github.com/owner/repo/pull/10',
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue({
      pr_number: 10,
      repo: 'owner/repo',
      state: 'closed',
    } as never);

    const session = new AgentSession(
      'closed-pr-session',
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

    expect(notion.updateStatus).not.toHaveBeenCalled();
  });

  // ── AC: handleCleanExit() does NOT call updateStatus In Review when no PR ──
  it('does NOT call notionClient.updateStatus In Review when no PR URL found at exit', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const session = new AgentSession(
      'no-pr-session',
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

    expect(notion.updateStatus).not.toHaveBeenCalledWith(
      'task-id',
      '👀 In Review',
    );
  });

  // ── AC: pr_opened emitted from handlePRCreatedFromContent (live path) ───────
  it('emits pr_opened from the live detection path when mcp__github__create_pull_request tool_result is seen', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);

    const session = new AgentSession(
      'live-pr-session',
      'https://notion.so/task-live',
      'https://notion.so/ctx-live',
      notion,
      '/tmp',
      'task-live-id',
    );

    const prOpenedEvents: unknown[] = [];
    session.on('pr_opened', (job: unknown) => prOpenedEvents.push(job));

    const runPromise = session.run();

    // Step 1: emit assistant event with mcp__github__create_pull_request tool_use
    const toolUseId = 'tu-abc-123';
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-pr-live',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'mcp__github__create_pull_request',
            input: {},
          },
        ],
      },
    });
    mockProc.stdout.push(assistantEvent + '\n');
    await new Promise((r) => setTimeout(r, 50));

    // Step 2: emit tool_result event with a GitHub PR JSON response
    const prJson = JSON.stringify({
      number: 77,
      html_url: 'https://github.com/myorg/myrepo/pull/77',
      title: 'My PR',
      body: null,
      head: { ref: 'feature/foo' },
      base: { ref: 'dev' },
      state: 'open',
      created_at: '2026-04-02T00:00:00Z',
      updated_at: '2026-04-02T00:00:00Z',
    });
    const toolResultEvent = JSON.stringify({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [{ type: 'text', text: prJson }],
    });
    mockProc.stdout.push(toolResultEvent + '\n');
    await new Promise((r) => setTimeout(r, 50));

    expect(prOpenedEvents).toHaveLength(1);
    const job = prOpenedEvents[0] as {
      prNumber: number;
      repo: string;
      taskId: string;
    };
    expect(job.prNumber).toBe(77);
    expect(job.repo).toBe('myorg/myrepo');
    expect(job.taskId).toBe('task-live-id');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  // ── AC: pr_opened NOT emitted twice when live detection fired ─────────────
  it('does NOT emit pr_opened a second time from handleCleanExit when live detection already fired', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    // Return a session event that also contains a PR URL so handleCleanExit would
    // normally emit pr_opened — but it must not because prDetectedLive is true.
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'no-double-pr',
        event_type: 'text',
        payload: 'PR: https://github.com/myorg/myrepo/pull/77',
        timestamp: Date.now(),
        message_id: null,
      },
    ]);

    const session = new AgentSession(
      'no-double-pr',
      'https://notion.so/task-nodbl',
      'https://notion.so/ctx-nodbl',
      notion,
      '/tmp',
      'task-nodbl-id',
    );

    const prOpenedEvents: unknown[] = [];
    session.on('pr_opened', (job: unknown) => prOpenedEvents.push(job));

    const runPromise = session.run();

    // Trigger live PR detection
    const toolUseId = 'tu-nodbl-456';
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-nodbl',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'mcp__github__create_pull_request',
            input: {},
          },
        ],
      },
    });
    mockProc.stdout.push(assistantEvent + '\n');
    await new Promise((r) => setTimeout(r, 50));

    const prJson = JSON.stringify({
      number: 77,
      html_url: 'https://github.com/myorg/myrepo/pull/77',
      title: 'My PR',
      body: null,
      head: { ref: 'feature/foo' },
      base: { ref: 'dev' },
      state: 'open',
      created_at: '2026-04-02T00:00:00Z',
      updated_at: '2026-04-02T00:00:00Z',
    });
    const toolResultEvent = JSON.stringify({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [{ type: 'text', text: prJson }],
    });
    mockProc.stdout.push(toolResultEvent + '\n');
    await new Promise((r) => setTimeout(r, 50));

    // Live path fired — exactly one emission so far
    expect(prOpenedEvents).toHaveLength(1);

    // Now the session exits — handleCleanExit runs and must NOT emit again
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    // Still only one emission
    expect(prOpenedEvents).toHaveLength(1);
  });

  // ── AC: push_detected fires when Bash tool result matches git push ────────
  it('emits push_detected when a Bash tool_use with git push command completes', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    // handlePushDetected only broadcasts the WS message when a PR row exists
    // for this session — provide a stub row so the broadcast path is exercised.
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
    } as never);

    const session = new AgentSession(
      'push-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const pushEvents: unknown[] = [];
    session.on('push_detected', (payload: unknown) => pushEvents.push(payload));

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    const bashToolUseId = 'bash-tu-001';

    // Step 1: assistant event with Bash tool_use containing git push
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-bash',
        content: [
          {
            type: 'tool_use',
            id: bashToolUseId,
            name: 'Bash',
            input: { command: 'git push origin feature/my-branch' },
          },
        ],
      },
    });
    mockProc.stdout.push(assistantEvent + '\n');
    await new Promise((r) => setTimeout(r, 50));

    // Step 2: tool_result for the Bash call
    const toolResultEvent = JSON.stringify({
      type: 'tool_result',
      tool_use_id: bashToolUseId,
      content: [{ type: 'text', text: 'Everything up-to-date' }],
    });
    mockProc.stdout.push(toolResultEvent + '\n');
    await new Promise((r) => setTimeout(r, 50));

    // push_detected should have fired
    expect(pushEvents).toHaveLength(1);
    expect((pushEvents[0] as { sessionId: string }).sessionId).toBe(
      'push-session',
    );

    // And broadcast as ServerMessage
    const pushMsgs = messages.filter((m) => m.type === 'push_detected');
    expect(pushMsgs).toHaveLength(1);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('does NOT emit push_detected for non-push Bash commands', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);

    const session = new AgentSession(
      'no-push-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const pushEvents: unknown[] = [];
    session.on('push_detected', (payload: unknown) => pushEvents.push(payload));

    const runPromise = session.run();

    const bashToolUseId = 'bash-tu-002';
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-bash-status',
        content: [
          {
            type: 'tool_use',
            id: bashToolUseId,
            name: 'Bash',
            input: { command: 'git status' },
          },
        ],
      },
    });
    mockProc.stdout.push(assistantEvent + '\n');

    const toolResultEvent = JSON.stringify({
      type: 'tool_result',
      tool_use_id: bashToolUseId,
      content: [{ type: 'text', text: 'On branch feature/foo' }],
    });
    mockProc.stdout.push(toolResultEvent + '\n');
    await new Promise((r) => setTimeout(r, 50));

    expect(pushEvents).toHaveLength(0);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  // ── AC: handleCleanExit() does NOT upsert or emit pr_opened for merged PR ──
  it('does NOT call upsertPullRequest or emit pr_opened when existingPrState is merged', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'merged-upsert-session',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'PR: https://github.com/owner/repo/pull/20',
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue({
      pr_number: 20,
      repo: 'owner/repo',
      state: 'merged',
    } as never);

    const session = new AgentSession(
      'merged-upsert-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const prOpenedEvents: unknown[] = [];
    session.on('pr_opened', (job: unknown) => prOpenedEvents.push(job));

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    const { upsertPullRequest } = await import('../db/queries');
    expect(upsertPullRequest).not.toHaveBeenCalled();
    expect(prOpenedEvents).toHaveLength(0);
  });

  it('does NOT call upsertPullRequest or emit pr_opened when existingPrState is closed', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'closed-upsert-session',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'PR: https://github.com/owner/repo/pull/21',
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue({
      pr_number: 21,
      repo: 'owner/repo',
      state: 'closed',
    } as never);

    const session = new AgentSession(
      'closed-upsert-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const prOpenedEvents: unknown[] = [];
    session.on('pr_opened', (job: unknown) => prOpenedEvents.push(job));

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    const { upsertPullRequest } = await import('../db/queries');
    expect(upsertPullRequest).not.toHaveBeenCalled();
    expect(prOpenedEvents).toHaveLength(0);
  });

  it('DOES call upsertPullRequest and emit pr_opened when existingPrState is open', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'open-upsert-session',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'PR: https://github.com/owner/repo/pull/22',
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue({
      pr_number: 22,
      repo: 'owner/repo',
      state: 'open',
    } as never);

    const session = new AgentSession(
      'open-upsert-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const prOpenedEvents: unknown[] = [];
    session.on('pr_opened', (job: unknown) => prOpenedEvents.push(job));

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    const { upsertPullRequest } = await import('../db/queries');
    expect(upsertPullRequest).toHaveBeenCalled();
    expect(prOpenedEvents).toHaveLength(1);
  });

  // ── AC: pr_opened emitted in handleCleanExit() after upsertPullRequest() ──
  it('emits pr_opened event in handleCleanExit() when a PR URL is found at exit', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'pr-session',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'Done! PR: https://github.com/owner/repo/pull/42',
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);

    const session = new AgentSession(
      'pr-session',
      'https://notion.so/task-abc',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'taskabc123',
    );

    const prOpenedEvents: unknown[] = [];
    session.on('pr_opened', (job: unknown) => prOpenedEvents.push(job));

    const runPromise = session.run();

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(prOpenedEvents).toHaveLength(1);
    const job = prOpenedEvents[0] as {
      prNumber: number;
      repo: string;
      taskId: string;
    };
    expect(job.prNumber).toBe(42);
    expect(job.repo).toBe('owner/repo');
    expect(job.taskId).toBe('taskabc123');
  });

  // ── AC: in-session 529/500 detection ────────────────────────────────────────

  it('fires api_overloaded_paused when an error event matching overloaded_error arrives', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'sess-overload',
        event_type: 'error',
        payload: JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);

    const session = new AgentSession(
      'sess-overload',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    mockProc.stdout.push(
      JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    const overloadedMsg = messages.find(
      (m) => m.type === 'api_overloaded_paused',
    );
    expect(overloadedMsg).toBeDefined();
    expect(
      (overloadedMsg as { type: string; sessionId: string }).sessionId,
    ).toBe('sess-overload');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('calls setPauseReason with api_overloaded when session has a paired PR', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getPRBySessionId).mockReturnValue({
      id: 1,
      pr_number: 77,
      pr_url: 'https://github.com/owner/repo/pull/77',
      task_id: null,
      session_id: 'sess-with-pr',
      repo: 'owner/repo',
      title: 'Test PR',
      body: null,
      head_branch: 'feature/x',
      base_branch: 'dev',
      state: 'open',
      draft: 0,
      review_result: null,
      review_at: null,
      created_at: null,
      updated_at: null,
      synced_at: new Date().toISOString(),
      review_session_id: null,
      review_iteration: 0,
      head_sha: null,
      last_reviewed_sha: null,
      node_id: null,
      mergeable: null,
      merge_state: null,
      merge_state_checked_at: null,
      failing_checks: null,
      pending_push: 0,
      pause_reason: null,
    });
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'sess-with-pr',
        event_type: 'error',
        payload: JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);

    const sendMock = vi.fn();
    const sessionManager = { send: sendMock };

    const session = new AgentSession(
      'sess-with-pr',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      undefined,
      undefined,
      'standard',
      sessionManager,
    );

    const runPromise = session.run();

    mockProc.stdout.push(
      JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      77,
      'owner/repo',
      'api_overloaded',
    );
    expect(sendMock).toHaveBeenCalledWith(
      'sess-with-pr',
      expect.stringContaining('529'),
    );

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('does NOT call setPauseReason but still broadcasts and sends message when session has no paired PR', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'sess-no-pr',
        event_type: 'error',
        payload: JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'Internal server error' },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);

    const sendMock = vi.fn();
    const sessionManager = { send: sendMock };

    const session = new AgentSession(
      'sess-no-pr',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      undefined,
      undefined,
      'standard',
      sessionManager,
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    mockProc.stdout.push(
      JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'Internal server error' },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalled();
    const overloadedMsg = messages.find(
      (m) => m.type === 'api_overloaded_paused',
    );
    expect(overloadedMsg).toBeDefined();

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  // ── AC: clean-exit with PR — markSessionDone sets status+pr_url atomically ─
  it('calls markSessionDone with prUrl when a PR URL is found at clean exit', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'done-pr-session',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'PR opened: https://github.com/owner/repo/pull/99',
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);

    const session = new AgentSession(
      'done-pr-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(vi.mocked(markSessionDone)).toHaveBeenCalledWith(
      'done-pr-session',
      expect.any(Number),
      'https://github.com/owner/repo/pull/99',
    );

    const ended = messages.find((m) => m.type === 'session_ended');
    expect(ended).toBeDefined();
    expect((ended as { status: string }).status).toBe('done');
  });

  // ── AC: clean-exit without PR — markSessionDone still called ─────────────
  it('calls markSessionDone with null prUrl when no PR URL found at clean exit', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const session = new AgentSession(
      'done-no-pr-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(vi.mocked(markSessionDone)).toHaveBeenCalledWith(
      'done-no-pr-session',
      expect.any(Number),
      null,
    );

    const ended = messages.find((m) => m.type === 'session_ended');
    expect(ended).toBeDefined();
    expect((ended as { status: string }).status).toBe('done');
  });

  // ── AC: review pipeline error cannot abort handleCleanExit ────────────────
  // When pr_opened emits and a synchronous listener throws, markSessionDone
  // has already been called and session_ended is still broadcast.
  it('broadcasts session_ended and calls markSessionDone even when pr_opened listener throws', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'review-error-session',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'PR: https://github.com/owner/repo/pull/88',
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);

    const session = new AgentSession(
      'review-error-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    // Simulate a synchronous throw from the review pipeline on pr_opened
    session.on('pr_opened', () => {
      throw new Error('TypeError: fetch failed (review pipeline crash)');
    });

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    // markSessionDone must have been called before the throw
    expect(vi.mocked(markSessionDone)).toHaveBeenCalledWith(
      'review-error-session',
      expect.any(Number),
      'https://github.com/owner/repo/pull/88',
    );

    // session_ended must still be broadcast despite the review pipeline error
    const ended = messages.find((m) => m.type === 'session_ended');
    expect(ended).toBeDefined();
    expect((ended as { status: string }).status).toBe('done');
  });

  it('fires handleInSessionApiError at most once even when multiple error events arrive', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'sess-dedup',
        event_type: 'error',
        payload: JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);

    const session = new AgentSession(
      'sess-dedup',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    const errorLine =
      JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }) + '\n';
    mockProc.stdout.push(errorLine);
    mockProc.stdout.push(errorLine);
    await new Promise((r) => setTimeout(r, 50));

    const overloadedMsgs = messages.filter(
      (m) => m.type === 'api_overloaded_paused',
    );
    expect(overloadedMsgs).toHaveLength(1);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  // ── AC: NoOpInvestigator dispatched on clean exit with no PR and no diff ────

  it('spawns NoOpInvestigator when session exits cleanly with no PR and no diff', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([]);
    vi.mocked(hasNonEmptyDiff).mockResolvedValue(false);

    const mockInvestigate = vi.fn(async () => {});
    vi.mocked(NoOpInvestigator).mockImplementation(
      () =>
        ({ investigate: mockInvestigate }) as unknown as InstanceType<
          typeof NoOpInvestigator
        >,
    );

    // sessionManager with start() so the 'start' in sessionManager guard passes
    const sessionManager = { send: vi.fn(), start: vi.fn(() => 'inv-session') };

    const session = new AgentSession(
      'no-op-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      undefined,
      undefined,
      'standard',
      sessionManager as never,
    );

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    // Allow fire-and-forget investigator to start
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(NoOpInvestigator)).toHaveBeenCalled();
    expect(mockInvestigate).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-id',
        noOpSessionId: 'no-op-session',
      }),
    );
  });

  it('does NOT spawn NoOpInvestigator when a PR URL is present at exit', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'pr-present-session',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'PR: https://github.com/owner/repo/pull/99',
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);

    const mockInvestigate = vi.fn(async () => {});
    vi.mocked(NoOpInvestigator).mockImplementation(
      () =>
        ({ investigate: mockInvestigate }) as unknown as InstanceType<
          typeof NoOpInvestigator
        >,
    );

    const sessionManager = { send: vi.fn(), start: vi.fn(() => 'inv-session') };

    const session = new AgentSession(
      'pr-present-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      undefined,
      undefined,
      'standard',
      sessionManager as never,
    );

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
    await new Promise((r) => setTimeout(r, 50));

    expect(mockInvestigate).not.toHaveBeenCalled();
  });

  it('does NOT spawn NoOpInvestigator when hasNonEmptyDiff returns true', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([]);
    vi.mocked(hasNonEmptyDiff).mockResolvedValue(true);

    const mockInvestigate = vi.fn(async () => {});
    vi.mocked(NoOpInvestigator).mockImplementation(
      () =>
        ({ investigate: mockInvestigate }) as unknown as InstanceType<
          typeof NoOpInvestigator
        >,
    );

    const sessionManager = { send: vi.fn(), start: vi.fn(() => 'inv-session') };

    const session = new AgentSession(
      'has-diff-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      undefined,
      undefined,
      'standard',
      sessionManager as never,
    );

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
    await new Promise((r) => setTimeout(r, 50));

    expect(mockInvestigate).not.toHaveBeenCalled();
  });

  // ── AC: diagnostic events in handleCleanExit ─────────────────────────────
  it('records both handle_clean_exit_entered and handle_clean_exit_session_marked_done on clean exit', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const session = new AgentSession(
      'diag-clean-session',
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

    const calls = vi.mocked(recordEvent).mock.calls;
    const eventTypes = calls.map((c) => c[0].event_type);
    expect(eventTypes).toContain('handle_clean_exit_entered');
    expect(eventTypes).toContain('handle_clean_exit_session_marked_done');
    // entry must come before marked-done
    expect(eventTypes.indexOf('handle_clean_exit_entered')).toBeLessThan(
      eventTypes.indexOf('handle_clean_exit_session_marked_done'),
    );
  });

  it('records only handle_clean_exit_entered when pre-markSessionDone path throws', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    // Make getEventsBySession throw to simulate a pre-markSessionDone failure
    vi.mocked(getEventsBySession).mockImplementation(() => {
      throw new Error('DB read failure');
    });

    const session = new AgentSession(
      'diag-throw-session',
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
    // run() will reject because handleCleanExit throws
    await runPromise.catch(() => {});

    const calls = vi.mocked(recordEvent).mock.calls;
    const eventTypes = calls.map((c) => c[0].event_type);
    expect(eventTypes).toContain('handle_clean_exit_entered');
    expect(eventTypes).not.toContain('handle_clean_exit_session_marked_done');
  });
});

// ── AC: parseNotionPageIdDashed ───────────────────────────────────────────────
describe('parseNotionPageIdDashed', () => {
  it('converts a 32-hex dashless ID to dashed UUID', () => {
    expect(parseNotionPageIdDashed('36e22f9152f381018dd2f6f7c0b402e9')).toBe(
      '36e22f91-52f3-8101-8dd2-f6f7c0b402e9',
    );
  });

  it('returns a dashed UUID input unchanged', () => {
    expect(
      parseNotionPageIdDashed('36e22f91-52f3-8101-8dd2-f6f7c0b402e9'),
    ).toBe('36e22f91-52f3-8101-8dd2-f6f7c0b402e9');
  });

  it('passes through non-UUID inputs unchanged', () => {
    expect(parseNotionPageIdDashed('not-a-uuid')).toBe('not-a-uuid');
    expect(parseNotionPageIdDashed('yaml:some-id')).toBe('yaml:some-id');
  });

  it('extracts dashless ID from a Notion URL and converts to dashed', () => {
    expect(
      parseNotionPageIdDashed(
        'https://www.notion.so/My-Task-36e22f9152f381018dd2f6f7c0b402e9',
      ),
    ).toBe('36e22f91-52f3-8101-8dd2-f6f7c0b402e9');
  });

  // ── AC: handleCleanExit resilient pre-markSessionDone ────────────────────
  // When getEventsBySession throws, markSessionDone must still run so the
  // session transitions to status='done' rather than remaining 'running'.
  it('calls markSessionDone with null prUrl when getEventsBySession throws during clean exit', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);
    vi.mocked(getEventsBySession).mockImplementation(() => {
      throw new Error('DB read failure');
    });

    const session = new AgentSession(
      'resilient-exit-session',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    // Session must transition to done even though getEventsBySession threw
    expect(vi.mocked(markSessionDone)).toHaveBeenCalledWith(
      'resilient-exit-session',
      expect.any(Number),
      null,
    );

    const ended = messages.find((m) => m.type === 'session_ended');
    expect(ended).toBeDefined();
    expect((ended as { status: string }).status).toBe('done');
  });
});
