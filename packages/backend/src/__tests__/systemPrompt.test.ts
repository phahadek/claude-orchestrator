/**
 * Tests for the system-prompt-file delivery mechanism:
 * - writeSystemPromptFile writes outside the worktree
 * - CliSessionRunner passes --append-system-prompt-file
 * - AgentSession initial prompt does not reference CLAUDE.md
 * - SessionManager.start() does not write CLAUDE.md into the worktree
 * - A pre-existing CLAUDE.md in a repo is not overwritten
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Child process mock ────────────────────────────────────────────────────────

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk: unknown, _enc: unknown, cb: () => void) {
      cb();
    },
  });
  return Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 12345,
    exitCode: null,
  });
}

let capturedSpawnArgs: string[] = [];
let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    capturedSpawnArgs = args;
    return mockProc;
  }),
  execSync: vi.fn(() => 'claude'),
  execFile: vi.fn(),
  exec: vi.fn(),
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
  incrementCompactionCount: vi.fn(),
  setSessionPauseReason: vi.fn(),
  setPauseInterval: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSessionTags: vi.fn(() => []),
  setSessionTags: vi.fn(),
  resetTaskCrashCount: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));

import { AgentSession } from '../session/AgentSession';
import { writeSystemPromptFile } from '../session/SessionManager';
import type { TaskBackend } from '../tasks/TaskBackend';

function fakeBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  } as unknown as TaskBackend;
}

// ── writeSystemPromptFile unit tests ──────────────────────────────────────────

describe('writeSystemPromptFile', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysprompt-project-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('writes content to <projectDir>/.claude/session-prompts/<sessionId>.md', () => {
    const sessionId = 'test-session-abc123';
    const content = '# Orchestrator Rules\n\nTest content';

    const filePath = writeSystemPromptFile(projectDir, sessionId, content);

    expect(filePath).toBe(
      path.join(projectDir, '.claude', 'session-prompts', `${sessionId}.md`),
    );
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('creates the session-prompts directory if it does not exist', () => {
    const sessionId = 'new-session-xyz';
    writeSystemPromptFile(projectDir, sessionId, 'content');
    expect(
      fs.existsSync(
        path.join(projectDir, '.claude', 'session-prompts', `${sessionId}.md`),
      ),
    ).toBe(true);
  });

  it('writes outside the worktree (path does not contain "worktrees")', () => {
    const sessionId = 'isolation-check-session';
    const filePath = writeSystemPromptFile(projectDir, sessionId, 'rules');
    expect(filePath).not.toContain('worktrees');
    expect(filePath).toContain('session-prompts');
  });

  it('returns the absolute path to the written file', () => {
    const filePath = writeSystemPromptFile(projectDir, 'sess-1', 'data');
    expect(path.isAbsolute(filePath)).toBe(true);
  });
});

// ── CliSessionRunner — --append-system-prompt-file spawn arg tests ─────────────

describe('CliSessionRunner — system prompt spawn args', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-runner-'));
    capturedSpawnArgs = [];
    mockProc = createMockProc();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    mockProc.stdout.push(null);
    mockProc.emit('exit', 0);
  });

  it('includes --append-system-prompt-file when systemPromptFilePath is set', async () => {
    const promptFile = path.join(tmpDir, 'system-prompt.md');
    fs.writeFileSync(promptFile, '# Rules');

    const session = new AgentSession(
      'prompt-with-file',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeBackend(),
      tmpDir,
      'task-id',
      undefined,
      undefined,
      'standard',
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      '',
      undefined,
      promptFile,
    );

    session.run().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedSpawnArgs).toContain('--append-system-prompt-file');
    expect(capturedSpawnArgs).toContain(promptFile);
    const idx = capturedSpawnArgs.indexOf('--append-system-prompt-file');
    expect(capturedSpawnArgs[idx + 1]).toBe(promptFile);
  });

  it('omits --append-system-prompt-file when systemPromptFilePath is undefined', async () => {
    const session = new AgentSession(
      'prompt-no-file',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeBackend(),
      tmpDir,
      'task-id',
      undefined,
      undefined,
      'standard',
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      '',
      undefined,
      undefined,
    );

    session.run().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedSpawnArgs).not.toContain('--append-system-prompt-file');
  });

  it('passes the system-prompt file path OUTSIDE the worktree — not inside it', async () => {
    const projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'prompt-project-'),
    );
    const sessionId = 'outside-worktree-test';
    const worktreePath = path.join(
      projectDir,
      '.claude',
      'worktrees',
      sessionId,
    );
    fs.mkdirSync(worktreePath, { recursive: true });
    const promptFile = writeSystemPromptFile(projectDir, sessionId, '# Rules');

    const session = new AgentSession(
      sessionId,
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeBackend(),
      worktreePath,
      'task-id',
      undefined,
      undefined,
      'standard',
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      '',
      undefined,
      promptFile,
    );

    session.run().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    expect(promptFile.startsWith(worktreePath)).toBe(false);
    expect(promptFile).toContain('session-prompts');
    expect(capturedSpawnArgs).toContain('--append-system-prompt-file');

    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});

// ── AgentSession initial prompt — no CLAUDE.md references ────────────────────

describe('AgentSession.run() — initial prompt', () => {
  it('does not instruct the session to read CLAUDE.md', () => {
    const agentSource = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'AgentSession.ts'),
      'utf-8',
    );
    const promptStart = agentSource.indexOf('const initialPrompt =');
    const promptEnd = agentSource.indexOf('.trim();', promptStart);
    const promptBlock = agentSource.slice(promptStart, promptEnd);

    expect(promptBlock).not.toMatch(/Read CLAUDE\.md/i);
    expect(promptBlock).not.toMatch(/CLAUDE\.md.*spec|spec.*CLAUDE\.md/i);
  });

  it('tells the session that rules are in the system prompt', () => {
    const agentSource = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'AgentSession.ts'),
      'utf-8',
    );
    const promptStart = agentSource.indexOf('const initialPrompt =');
    const promptEnd = agentSource.indexOf('.trim();', promptStart);
    const promptBlock = agentSource.slice(promptStart, promptEnd);

    expect(promptBlock).toMatch(/system prompt/i);
  });
});

// ── SessionManager.start() — no CLAUDE.md in worktree ───────────────────────

describe('SessionManager.start() — no CLAUDE.md write to worktree', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('does NOT call injectContextFile("CLAUDE.md", ...) anywhere in the source', () => {
    expect(source).not.toMatch(/injectContextFile\s*\(\s*['"]CLAUDE\.md['"]/);
  });

  it('calls writeSystemPromptFile for CLI sessions in completeStart', () => {
    const completeStartIdx = source.indexOf('private async completeStart(');
    const cleanupIdx = source.indexOf('private async cleanupPartialWorktree(');
    const block = source.slice(completeStartIdx, cleanupIdx);
    expect(block).toMatch(/writeSystemPromptFile\s*\(/);
  });

  it('passes systemPromptFilePath to AgentSession constructor in completeStart', () => {
    const completeStartIdx = source.indexOf('private async completeStart(');
    const cleanupIdx = source.indexOf('private async cleanupPartialWorktree(');
    const block = source.slice(completeStartIdx, cleanupIdx);
    expect(block).toMatch(/systemPromptFilePath/);
    expect(block).toMatch(/new AgentSession/);
  });

  it('the system prompt file is written to a path outside the worktree', () => {
    const fnIdx = source.indexOf('export function writeSystemPromptFile(');
    const fnEnd = source.indexOf('\n}', fnIdx);
    const fn = source.slice(fnIdx, fnEnd + 2);
    expect(fn).toMatch(/session-prompts/);
    expect(fn).not.toMatch(/worktreePath/);
  });

  it('cleanupWorktree removes the system-prompt file on session end', () => {
    const cleanupIdx = source.indexOf('private cleanupWorktree(');
    const nextMethodIdx = source.indexOf('\n  private ', cleanupIdx + 1);
    const block = source.slice(
      cleanupIdx,
      nextMethodIdx > -1 ? nextMethodIdx : cleanupIdx + 5000,
    );
    expect(block).toMatch(/session-prompts/);
    expect(block).toMatch(/unlinkSync/);
  });
});

// ── Repo with pre-existing CLAUDE.md is not modified ─────────────────────────

describe('SessionManager — pre-existing CLAUDE.md in repo is not overwritten', () => {
  it('does not overwrite a CLAUDE.md that already exists in the worktree', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(source).not.toMatch(/injectContextFile\s*\(\s*['"]CLAUDE\.md['"]/);
    expect(source).not.toMatch(/writeFileSync.*CLAUDE\.md/);
  });
});
