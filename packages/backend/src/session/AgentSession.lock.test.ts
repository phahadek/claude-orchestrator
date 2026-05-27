/**
 * Unit tests for the per-session revert lock mechanism on AgentSession.
 *
 * After PRFileReverter.revertBannedFiles() reverts a file, AgentSession records
 * it in _revertedFiles. Subsequent calls to injectContextFile() for that file
 * are suppressed and a file_pollution_re_injected_blocked audit event is emitted.
 * The lock is per-session instance (not persisted), so a new AgentSession for
 * the same worktree starts with an empty lock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// All heavy dependencies mocked before AgentSession is imported
vi.mock('../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../config', () => ({
  ALLOWED_TOOLS: [],
  runtimeSettings: { session_mode: 'cli', code_session_model: null, review_session_model: null, corporate_mode_enabled: false },
  config: { maxConcurrentCodeSessions: 5 },
  getProjectById: vi.fn(),
  normalizePath: (p: string) => p,
}));
vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
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
vi.mock('../github/CommitAttributionWatcher', () => ({ checkCommitAttribution: vi.fn() }));
vi.mock('../utils/eventFilters', () => ({ isSystemOnlyUserEvent: vi.fn(() => false) }));
vi.mock('./SessionAuditor', () => ({ SessionAuditor: vi.fn() }));
vi.mock('./CliSessionRunner', () => ({ CliSessionRunner: vi.fn(() => ({ run: vi.fn(), sendMessage: vi.fn(), endSession: vi.fn(), kill: vi.fn(), hasSpawnError: false })) }));
vi.mock('./eventTypes', () => ({
  VALID_EVENT_TYPES: new Set(['assistant', 'user', 'tool_result', 'result', 'system', 'error']),
  SILENT_SKIP_TYPES: new Set<string>(),
  toEventType: (t: string) => t,
}));

import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentSession } from './AgentSession';
import { recordEvent } from '../audit/AuditLog';

function makeSession(worktreePath: string): AgentSession {
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
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    'test-project',
  );
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

  it('blocks re-injection when the file is in revertedFiles', () => {
    const session = makeSession(tmpDir);

    // Initial write succeeds
    session.injectContextFile('CLAUDE.md', 'initial content\n');

    // Simulate runFilePollutionCheck adding CLAUDE.md to the reverted set
    (session as unknown as { _revertedFiles: Set<string> })._revertedFiles.add('CLAUDE.md');
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

    (session as unknown as { _revertedFiles: Set<string> })._revertedFiles.add('CLAUDE.md');

    session.injectContextFile('CLAUDE.md', 'blocked attempt\n');

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'file_pollution_re_injected_blocked',
        payload: expect.objectContaining({ filename: 'CLAUDE.md' }),
      }),
    );
  });

  it('lock is per-session — a new AgentSession for the same worktree starts with an empty lock', () => {
    const sessionA = makeSession(tmpDir);
    (sessionA as unknown as { _revertedFiles: Set<string> })._revertedFiles.add('CLAUDE.md');
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

  it('revertedFiles is read-only from outside', () => {
    const session = makeSession(tmpDir);
    const set = session.revertedFiles;
    // ReadonlySet does not expose add/delete — TypeScript enforces this at compile time,
    // but we also verify at runtime that the getter returns the internal set correctly
    expect(set).toBeDefined();
    expect(typeof set.has).toBe('function');
    expect(set.size).toBe(0);
  });
});
