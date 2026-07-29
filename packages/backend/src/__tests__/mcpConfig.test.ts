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
  getGrantedCapabilities: vi.fn(() => []),
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
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
}));

vi.mock('../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));

import { AgentSession } from '../session/AgentSession';
import { writeMcpConfig, mcpConfigDir } from '../session/SessionManager';
import { _resetStageCredentialsForTesting } from '../auth/SessionStageAuth';
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
    process.env.MCP_CONFIG_DIR = tmpDir;
    _resetStageCredentialsForTesting();
  });

  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges the orchestrator MCP entry with per-project mcp_servers when non-empty', () => {
    const mcpServers = {
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    };
    const filePath = writeMcpConfig(tmpDir, 'session-1', mcpServers);
    expect(filePath).toBe(path.join(mcpConfigDir(), 'session-1.mcp.json'));
    expect(filePath.startsWith(tmpDir)).toBe(true);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(written.mcpServers.github).toEqual(mcpServers.github);
    expect(written.mcpServers.orchestrator).toMatchObject({
      type: 'http',
      url: expect.stringContaining('/api/mcp'),
      headers: { Authorization: expect.stringMatching(/^Bearer .+/) },
    });
  });

  it('writes just the orchestrator MCP entry when mcp_servers is undefined', () => {
    const filePath = writeMcpConfig(tmpDir, 'session-2', undefined);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(Object.keys(written.mcpServers)).toEqual(['orchestrator']);
  });

  it('writes just the orchestrator MCP entry when mcp_servers is an empty object', () => {
    const filePath = writeMcpConfig(tmpDir, 'session-3', {});
    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(Object.keys(written.mcpServers)).toEqual(['orchestrator']);
  });

  it('creates the mcp config directory if it does not exist', () => {
    const mcpServers = { notion: { type: 'stdio', command: 'npx' } };
    writeMcpConfig(tmpDir, 'session-4', mcpServers);
    expect(fs.existsSync(path.join(mcpConfigDir(), 'session-4.mcp.json'))).toBe(
      true,
    );
  });

  it('never writes the per-session MCP config under the project checkout', () => {
    const projectDir = path.join(tmpDir, 'checkout');
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = writeMcpConfig(
      projectDir,
      'session-checkout-safety',
      undefined,
      'notion',
    );
    expect(filePath.startsWith(projectDir)).toBe(false);
    expect(
      fs.existsSync(path.join(projectDir, '.claude', 'session-prompts')),
    ).toBe(false);
  });

  it('mints an idempotent stage credential per session id across multiple writes', () => {
    const filePath1 = writeMcpConfig(tmpDir, 'session-5', undefined);
    const written1 = JSON.parse(fs.readFileSync(filePath1, 'utf-8'));
    const filePath2 = writeMcpConfig(tmpDir, 'session-5', undefined);
    const written2 = JSON.parse(fs.readFileSync(filePath2, 'utf-8'));
    expect(written1.mcpServers.orchestrator.headers.Authorization).toBe(
      written2.mcpServers.orchestrator.headers.Authorization,
    );
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
    const mcpConfigPath = path.join(
      tmpDir,
      '.claude',
      'session-prompts',
      'mcp-with-config.mcp.json',
    );
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

// ── per-session MCP config cleanup integration test ──────────────────────────

describe('cleanupWorktree — per-session MCP config removal', () => {
  it('removes the per-session MCP config before the git worktree remove call', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(source).toContain('.mcp.json');
    expect(source).toContain('unlinkSync');
    // Scope the ordering check to the cleanupWorktree method body — an
    // unrelated earlier `git worktree remove --force` call exists elsewhere
    // in the file (the resumeSession worktree-recreate path).
    const cleanupWorktreeIdx = source.indexOf('private cleanupWorktree(');
    expect(cleanupWorktreeIdx).toBeGreaterThan(0);
    const body = source.slice(cleanupWorktreeIdx);
    const unlinkIdx = body.indexOf('unlinkSync');
    const worktreeRemoveIdx = body.indexOf('git worktree remove --force');
    expect(unlinkIdx).toBeGreaterThan(0);
    expect(worktreeRemoveIdx).toBeGreaterThan(unlinkIdx);
  });
});
