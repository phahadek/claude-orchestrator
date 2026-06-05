/**
 * Unit tests for the per-session revert lock mechanism on AgentSession.
 *
 * After PRFileReverter.revertBannedFiles() reverts a file, AgentSession records
 * it in _revertLock. The next call to injectContextFile() for that file is
 * suppressed (consumed-on-consult) and a file_pollution_re_injected_blocked
 * audit event is emitted. After the lock entry is consumed, subsequent injections
 * are allowed again. The lock is per-session instance (not persisted), so a new
 * AgentSession for the same worktree starts with an empty lock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// All heavy dependencies mocked before AgentSession is imported
vi.mock('../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../config', () => ({
  ALLOWED_TOOLS: [],
  runtimeSettings: {
    session_mode: 'cli',
    code_session_model: null,
    review_session_model: null,
    corporate_mode_enabled: false,
  },
  config: { maxConcurrentCodeSessions: 5 },
  getProjectById: vi.fn(),
  normalizePath: (p: string) => p,
}));
vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
  setContextOccupancy: vi.fn(),
  insertSessionAudit: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  getProjectRowById: vi.fn(() => null),
  insertLocalBranch: vi.fn(),
  insertEvent: vi.fn(),
}));
vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(),
  hasNonEmptyDiff: vi.fn(),
}));
vi.mock('../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../tasks/TaskBackend', () => ({ getTaskBackend: vi.fn() }));
vi.mock('../github/PRBodyValidator', () => ({
  validatePRBody: vi.fn(() => ({ valid: true })),
  buildValidationComment: vi.fn(),
}));
vi.mock('../github/PRFileValidator', () => ({ validatePRFiles: vi.fn() }));
vi.mock('../github/PRFileReverter', () => ({ revertBannedFiles: vi.fn() }));
vi.mock('../github/CommitAttributionWatcher', () => ({
  checkCommitAttribution: vi.fn(),
}));
vi.mock('../utils/eventFilters', () => ({
  isSystemOnlyUserEvent: vi.fn(() => false),
}));
vi.mock('./SessionAuditor', () => ({ SessionAuditor: vi.fn() }));
vi.mock('./CliSessionRunner', () => ({
  CliSessionRunner: vi.fn(() => ({
    run: vi.fn(),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn(),
    hasSpawnError: false,
  })),
}));
vi.mock('./eventTypes', () => ({
  VALID_EVENT_TYPES: new Set([
    'assistant',
    'user',
    'tool_result',
    'result',
    'system',
    'error',
  ]),
  SILENT_SKIP_TYPES: new Set<string>(),
  toEventType: (t: string) => t,
}));

import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentSession } from './AgentSession';
import { recordEvent } from '../audit/AuditLog';

interface MockSessionManager {
  send: ReturnType<typeof vi.fn>;
  registerRevertSync?: ReturnType<typeof vi.fn>;
}

function makeSession(
  worktreePath: string,
  sessionManager?: MockSessionManager,
): AgentSession {
  return new AgentSession(
    'test-session-id',
    'https://notion.so/task',
    'https://notion.so/project',
    undefined,
    worktreePath,
    'notion:task-id',
    undefined,
    undefined,
    'standard',
    sessionManager as unknown as
      | import('./SessionAuditor').ISessionManager
      | undefined,
    undefined,
    [],
    undefined,
    undefined,
    'test-project',
  );
}

/** Cast to access private _revertLock for test setup. */
function revertLock(session: AgentSession): Set<string> {
  return (session as unknown as { _revertLock: Set<string> })._revertLock;
}

describe('AgentSession.injectContextFile() — per-session revert lock', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
    vi.mocked(recordEvent).mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the file normally when the lock is empty', () => {
    const session = makeSession(tmpDir);
    session.injectContextFile('CLAUDE.md', 'injected content\n');
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toBe(
      'injected content\n',
    );
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
  });

  it('blocks re-injection when the file is in revertLock', () => {
    const session = makeSession(tmpDir);

    // Initial write succeeds
    session.injectContextFile('CLAUDE.md', 'initial content\n');

    // Simulate runFilePollutionCheck adding CLAUDE.md to the revert lock
    revertLock(session).add('CLAUDE.md');
    expect(session.revertedFiles.has('CLAUDE.md')).toBe(true);

    // Second injection attempt is blocked
    session.injectContextFile('CLAUDE.md', 'new injected content\n');

    // File content must be unchanged
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toBe(
      'initial content\n',
    );
  });

  it('emits file_pollution_re_injected_blocked audit event when blocked', () => {
    const session = makeSession(tmpDir);
    session.injectContextFile('CLAUDE.md', 'initial\n');

    revertLock(session).add('CLAUDE.md');

    session.injectContextFile('CLAUDE.md', 'blocked attempt\n');

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'file_pollution_re_injected_blocked',
        payload: expect.objectContaining({ filename: 'CLAUDE.md' }),
      }),
    );
  });

  it('lock is consumed on consult — third injection succeeds after the block', () => {
    const session = makeSession(tmpDir);

    session.injectContextFile('CLAUDE.md', 'first\n');

    // Add to lock — next injection will be blocked and the lock entry consumed
    revertLock(session).add('CLAUDE.md');

    // Blocked injection
    session.injectContextFile('CLAUDE.md', 'blocked\n');
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toBe(
      'first\n',
    );

    // Lock entry must have been consumed (deleted)
    expect(session.revertedFiles.has('CLAUDE.md')).toBe(false);

    // Third injection must succeed
    session.injectContextFile('CLAUDE.md', 'third\n');
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toBe(
      'third\n',
    );
  });

  it('lock is per-session — a new AgentSession for the same worktree starts with an empty lock', () => {
    const sessionA = makeSession(tmpDir);
    revertLock(sessionA).add('CLAUDE.md');
    expect(sessionA.revertedFiles.has('CLAUDE.md')).toBe(true);

    // Session A ends; a new session B picks up the same worktree
    const sessionB = makeSession(tmpDir);
    expect(sessionB.revertedFiles.has('CLAUDE.md')).toBe(false);

    // Session B can inject CLAUDE.md normally
    sessionB.injectContextFile('CLAUDE.md', 'fresh injection\n');
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toBe(
      'fresh injection\n',
    );
  });

  it('revertedFiles getter exposes the lock as a ReadonlySet', () => {
    const session = makeSession(tmpDir);
    const set = session.revertedFiles;
    expect(set).toBeDefined();
    expect(typeof set.has).toBe('function');
    expect(set.size).toBe(0);
  });

  it('regression: sessionManager.send() is NOT called when injectContextFile is blocked by the lock', () => {
    const mockSessionManager: MockSessionManager = { send: vi.fn() };
    const session = makeSession(tmpDir, mockSessionManager);

    session.injectContextFile('CLAUDE.md', 'initial\n');

    // Simulate auto-revert adding to the lock
    revertLock(session).add('CLAUDE.md');

    // Blocked injection — must NOT call sessionManager.send()
    session.injectContextFile('CLAUDE.md', 'blocked\n');

    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it('lockFileForNextInjection populates the lock from outside (autofix path)', () => {
    const session = makeSession(tmpDir);
    expect(session.revertedFiles.has('CLAUDE.md')).toBe(false);

    session.lockFileForNextInjection('CLAUDE.md');

    expect(session.revertedFiles.has('CLAUDE.md')).toBe(true);

    // The lock entry is consumed on the next injectContextFile call
    session.injectContextFile('CLAUDE.md', 'should be blocked\n');
    expect(session.revertedFiles.has('CLAUDE.md')).toBe(false);

    // The NEXT injection succeeds
    session.injectContextFile('CLAUDE.md', 'now allowed\n');
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8')).toBe(
      'now allowed\n',
    );
  });
});
