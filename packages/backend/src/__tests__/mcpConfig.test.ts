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
}));

vi.mock('../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));

import { AgentSession } from '../session/AgentSession';
import { writeMcpConfig } from '../session/SessionManager';
import type { TaskBackend } from '../tasks/TaskBackend';

function fakeBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  } as unknown as TaskBackend;
}

// ── writeMcpConfig unit tests ─────────────────────────────────────────────────

describe('writeMcpConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes orchestrator-mcp.json with mcpServers when mcp_servers is non-empty', () => {
    const mcpServers = {
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    };
    const filePath = writeMcpConfig(tmpDir, mcpServers);
    expect(filePath).toBe(
      path.join(tmpDir, '.claude', 'orchestrator-mcp.json'),
    );
    const written = JSON.parse(fs.readFileSync(filePath!, 'utf-8'));
    expect(written).toEqual({ mcpServers });
  });

  it('returns undefined when mcp_servers is undefined', () => {
    const filePath = writeMcpConfig(tmpDir, undefined);
    expect(filePath).toBeUndefined();
    expect(
      fs.existsSync(path.join(tmpDir, '.claude', 'orchestrator-mcp.json')),
    ).toBe(false);
  });

  it('returns undefined when mcp_servers is empty object', () => {
    const filePath = writeMcpConfig(tmpDir, {});
    expect(filePath).toBeUndefined();
  });

  it('creates the .claude directory if it does not exist', () => {
    const mcpServers = { notion: { type: 'stdio', command: 'npx' } };
    writeMcpConfig(tmpDir, mcpServers);
    expect(
      fs.existsSync(path.join(tmpDir, '.claude', 'orchestrator-mcp.json')),
    ).toBe(true);
  });
});

// ── CliSessionRunner spawn args tests ─────────────────────────────────────────

describe('CliSessionRunner — MCP config spawn args', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-runner-'));
    capturedSpawnArgs = [];
    mockProc = createMockProc();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    // End stdout so readline closes and any pending session run can finish.
    mockProc.stdout.push(null);
    mockProc.emit('exit', 0);
  });

  it('includes --mcp-config and --strict-mcp-config when mcpConfigPath is set', async () => {
    const mcpConfigPath = path.join(tmpDir, '.claude', 'orchestrator-mcp.json');
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { github: {} } }),
    );

    const session = new AgentSession(
      'mcp-with-config',
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
      mcpConfigPath,
    );

    // Start session — don't await; spawn is synchronous, args captured immediately.
    session.run().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedSpawnArgs).toContain('--mcp-config');
    expect(capturedSpawnArgs).toContain(mcpConfigPath);
    expect(capturedSpawnArgs).toContain('--strict-mcp-config');
    const mcpIdx = capturedSpawnArgs.indexOf('--mcp-config');
    expect(capturedSpawnArgs[mcpIdx + 1]).toBe(mcpConfigPath);
  });

  it('omits --mcp-config and --strict-mcp-config when mcpConfigPath is undefined', async () => {
    const session = new AgentSession(
      'mcp-no-config',
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
    );

    session.run().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedSpawnArgs).not.toContain('--mcp-config');
    expect(capturedSpawnArgs).not.toContain('--strict-mcp-config');
  });
});

// ── orchestrator-mcp.json cleanup integration test ───────────────────────────

describe('cleanupWorktree — orchestrator-mcp.json removal', () => {
  it('removes orchestrator-mcp.json before the git worktree remove call', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(source).toContain('orchestrator-mcp.json');
    expect(source).toContain('unlinkSync');
    const unlinkIdx = source.indexOf('unlinkSync');
    const worktreeRemoveIdx = source.indexOf('git worktree remove --force');
    expect(unlinkIdx).toBeGreaterThan(0);
    expect(worktreeRemoveIdx).toBeGreaterThan(unlinkIdx);
  });
});
