/**
 * Regression tests for the FK crash caused by review sessions spawning the CLI
 * before a sessions row exists, and the readline handler propagating throws.
 *
 * Covers three acceptance criteria:
 *   1. Review session start always inserts a sessions row before the CLI spawns.
 *   2. A synchronous throw from onEvent (e.g. upsertSessionEvent FK crash) is
 *      caught in the readline handler — process does not exit and error is logged.
 *   3. upsertSessionEvent returns -1 and logs when no sessions row exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Mock child_process ────────────────────────────────────────────────────────

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 99999,
    exitCode: null as number | null,
  });
  return { proc, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execSync: vi.fn(() => 'dev'),
}));

// ── Mock fs ────────────────────────────────────────────────────────────────
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => ''),
      writeFileSync: vi.fn(),
      statSync: vi.fn(() => ({ isFile: () => true })),
    },
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => ({ isFile: () => true })),
  };
});

// ── Mock config ───────────────────────────────────────────────────────────────
const projectFixture = {
  id: 'test-project',
  name: 'Test Project',
  projectDir: '/fake/project',
  contextUrl: 'https://notion.so/ctx',
  boardId: 'board-1',
  githubRepo: 'owner/repo',
  taskSource: 'notion' as const,
};

vi.mock('../config', () => ({
  AUTO_REVIEW_ENABLED: false,
  AUTO_REVIEW_CONCURRENCY: 1,
  ALLOWED_TOOLS: [],
  config: {
    claudePath: '/fake/claude',
    maxConcurrentCodeSessions: 20,
    projectDir: '/fake/project',
  },
  getProjectById: vi.fn((id: string) =>
    id === 'test-project' ? projectFixture : undefined,
  ),
  getAllProjects: vi.fn(() => [projectFixture]),
  normalizePath: (p: string) => p,
  runtimeSettings: {
    session_mode: 'cli',
    code_session_model: '',
    review_session_model: '',
    max_concurrent_code_sessions: 20,
  },
}));

vi.mock('../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn(() => ({
    allowedTools: [],
    prGate: { typeCheck: '', build: '' },
    bootstrapScript: '',
    bashRules: [],
  })),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn(() => 'review-claude-md'),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn(() => ''),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    fetchTaskPage: vi.fn(async () => ''),
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  })),
}));

vi.mock('../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn(() => 'Running'),
}));

vi.mock('../db/queries', () => ({
  getSessionsByStatus: vi.fn(() => []),
  getSession: vi.fn(() => undefined),
  getEventsBySession: vi.fn(() => []),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  updateSessionStatus: vi.fn(),
  insertSession: vi.fn(),
  insertEvent: vi.fn(),
  upsertSessionEvent: vi.fn(() => 1),
  upsertPullRequest: vi.fn(),
  insertPermissionDenial: vi.fn(),
  incrementTokens: vi.fn(),
  insertSessionAudit: vi.fn(),
  setSessionModel: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  setHeadSha: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { spawn } from 'child_process';
import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';

beforeEach(() => {
  mockProc = createMockProc();
  vi.clearAllMocks();
  vi.mocked(spawn).mockReturnValue(mockProc.proc as ReturnType<typeof spawn>);
});

// ── Test 1: insertSession called before CLI is spawned for review sessions ────

describe('SessionManager.start() — review session FK safety', () => {
  it('calls insertSession before spawning the CLI subprocess', () => {
    const callOrder: string[] = [];

    vi.mocked(queries.insertSession).mockImplementation(() => {
      callOrder.push('insertSession');
    });
    vi.mocked(spawn).mockImplementation((..._args) => {
      callOrder.push('spawn');
      return mockProc.proc as ReturnType<typeof spawn>;
    });

    const sm = new SessionManager();
    sm.start('https://notion.so/task-abc', 'https://notion.so/ctx', {
      sessionType: 'review',
      projectId: 'test-project',
      taskName: 'review task',
      sessionId: 'review-session-id-001',
    });

    const insertIdx = callOrder.indexOf('insertSession');
    const spawnIdx = callOrder.indexOf('spawn');
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeLessThan(spawnIdx);
  });

  it('calls insertSession with session_type=review', () => {
    const sm = new SessionManager();
    sm.start('https://notion.so/task-abc', 'https://notion.so/ctx', {
      sessionType: 'review',
      projectId: 'test-project',
      sessionId: 'review-session-id-002',
    });

    expect(queries.insertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'review-session-id-002',
        session_type: 'review',
      }),
    );
  });

  it('returns the session id before any events flow', () => {
    const sm = new SessionManager();
    const sessionId = sm.start(
      'https://notion.so/task-abc',
      'https://notion.so/ctx',
      {
        sessionType: 'review',
        projectId: 'test-project',
      },
    );

    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
    expect(queries.insertSession).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: sessionId }),
    );
  });
});

// ── Test 2: readline handler catches synchronous throws from onEvent ──────────

describe('CliSessionRunner — readline handler safety', () => {
  it('does not propagate a synchronous throw from onEvent to the process', async () => {
    const { CliSessionRunner } = await import('../session/CliSessionRunner');
    const runner = new CliSessionRunner('test-readline-session');

    let consoleErrorCalled = false;
    const origConsoleError = console.error;
    console.error = (..._args: unknown[]) => {
      consoleErrorCalled = true;
    };

    let unhandledRejection: Error | undefined;
    const onUnhandled = (err: Error) => {
      unhandledRejection = err;
    };
    process.on('unhandledRejection', onUnhandled);

    const onEvent = vi.fn(() => {
      throw new Error('simulated FK constraint failed');
    });

    const runPromise = runner.run(
      'initial prompt',
      undefined,
      {
        worktreePath: '/fake/worktree',
        model: undefined,
        allowedTools: ['Bash'],
        systemPrompt: undefined,
      },
      onEvent,
    );

    // Push a JSON line to stdout — triggers the readline handler.
    mockProc.stdout.push(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n',
    );

    // Allow macrotasks to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Terminate by closing stdout.
    mockProc.stdout.push(null);
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(onEvent).toHaveBeenCalled();
    expect(consoleErrorCalled).toBe(true);
    expect(unhandledRejection).toBeUndefined();

    process.off('unhandledRejection', onUnhandled);
    console.error = origConsoleError;
  });

  it('logs the session id and event info when the handler throws', async () => {
    const { CliSessionRunner } = await import('../session/CliSessionRunner');
    const runner = new CliSessionRunner('session-error-log-test');

    const logged: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };

    const runPromise = runner.run(
      undefined,
      undefined,
      {
        worktreePath: '/fake',
        model: undefined,
        allowedTools: [],
        systemPrompt: undefined,
      },
      () => {
        throw new Error('stub throw');
      },
    );

    mockProc.stdout.push(JSON.stringify({ type: 'assistant' }) + '\n');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    mockProc.stdout.push(null);
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(logged.some((line) => line.includes('session-error-log-test'))).toBe(
      true,
    );
    expect(logged.some((line) => line.includes('stub throw'))).toBe(true);

    console.error = origConsoleError;
  });
});

// ── Test 3: upsertSessionEvent defensive guard (source-level) ─────────────────

describe('upsertSessionEvent — defensive guard (source-level)', () => {
  it('checks for session row existence before inserting', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pathLib = require('path');
    const source = fs.readFileSync(
      pathLib.join(__dirname, '..', 'db', 'queries.ts'),
      'utf-8',
    );
    const upsertIdx = source.indexOf('export function upsertSessionEvent');
    const insertIdx = source.indexOf('stmtInsertEvent.run', upsertIdx);
    const guardIdx = source.indexOf('stmtGetSession.get', upsertIdx);
    expect(guardIdx).toBeGreaterThan(upsertIdx);
    expect(guardIdx).toBeLessThan(insertIdx);
  });

  it('logs an error and returns -1 when session row is missing', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pathLib = require('path');
    const source = fs.readFileSync(
      pathLib.join(__dirname, '..', 'db', 'queries.ts'),
      'utf-8',
    );
    const upsertIdx = source.indexOf('export function upsertSessionEvent');
    const block = source.slice(upsertIdx, upsertIdx + 900);
    expect(block).toMatch(/console\.error/);
    expect(block).toMatch(/no sessions row/);
    expect(block).toMatch(/return -1/);
  });
});

// ── Test 4: regression — FK throw produces structured log, does not propagate ─

describe('CliSessionRunner — FK-throw regression', () => {
  it('logs a structured error line but does not throw when upsertSessionEvent throws', async () => {
    const { CliSessionRunner } = await import('../session/CliSessionRunner');
    const runner = new CliSessionRunner('fk-regression-session');

    const errors: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };

    const onEvent = () => {
      throw Object.assign(new Error('FOREIGN KEY constraint failed'), {
        name: 'SqliteError',
      });
    };

    const runPromise = runner.run(
      undefined,
      undefined,
      {
        worktreePath: '/fake',
        model: undefined,
        allowedTools: [],
        systemPrompt: undefined,
      },
      onEvent,
    );

    mockProc.stdout.push(
      JSON.stringify({ type: 'system', subtype: 'init' }) + '\n',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    mockProc.stdout.push(null);
    mockProc.proc.emit('exit', 0);

    await expect(runPromise).resolves.toBeDefined();

    expect(errors.some((e) => e.includes('fk-regression-session'))).toBe(true);
    expect(
      errors.some((e) => e.includes('FOREIGN KEY constraint failed')),
    ).toBe(true);

    console.error = origConsoleError;
  });
});
