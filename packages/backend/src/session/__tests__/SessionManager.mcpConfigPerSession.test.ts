/**
 * Regression coverage for the per-session MCP config collision fix:
 * concurrent planning sessions (groom/design/ops) share worktreePath ===
 * projectDir, so siting the config file by worktreePath alone caused the
 * last-spawned session's stage credential to overwrite every other
 * concurrent session's file. writeMcpConfig now sites the file by sessionId
 * under `mcpConfigDir()` — the app data dir, outside any project checkout
 * (so the inlined Notion API key never lands on a path the dispatched
 * session, or anything else with checkout access, can read).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../AgentSession', () => ({
  AgentSession: vi.fn(),
  parseNotionPageIdDashed: vi.fn().mockReturnValue(''),
}));
vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({})),
  reapOrphanContainers: vi.fn(),
}));
vi.mock('../ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('../orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));
vi.mock('../branchModel', () => ({
  resolveStartingPoint: vi
    .fn()
    .mockReturnValue({ startingPoint: 'dev', milestoneSlug: null }),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi.fn().mockReturnValue('feature/my-task'),
}));
vi.mock('../orchestrator-config', () => ({
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ mcp_servers: undefined, allowed_tools: [] }),
}));
vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('running'),
}));
vi.mock('../../tasks/taskId', () => ({
  formatTaskId: vi.fn().mockReturnValue('task-123'),
}));
vi.mock('../../notion/NotionClient', () => ({ parseSection: vi.fn() }));
vi.mock('../../github/reviewUtils', () => ({
  formatReviewFeedback: vi.fn().mockReturnValue('review-feedback'),
  formatApprovedVerdictMessage: vi.fn().mockReturnValue('approved'),
}));
vi.mock('../../security/scrubSecrets', () => ({
  scrubSecrets: vi.fn().mockImplementation((s: string) => s),
}));
vi.mock('../../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false } }),
}));

vi.mock('../../db/queries', () => ({
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  markSessionSuperseded: vi.fn(),
  insertEvent: vi.fn(),
  getSession: vi.fn(),
  getSessionsByStatus: vi.fn().mockReturnValue([]),
  getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
  getRunningSessionsWithMergedOrClosedPR: vi.fn().mockReturnValue([]),
  getPRByNotionTaskId: vi.fn().mockReturnValue(null),
  getEventsBySession: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn().mockReturnValue(null),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  incrementTaskCrashCount: vi.fn().mockReturnValue(1),
  getTerminalSessionsForTask: vi.fn().mockReturnValue([]),
  setSessionPauseReason: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
  setTaskPauseReason: vi.fn(),
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
}));

vi.mock('../../config', () => ({
  config: {
    notionApiKey: 'ntn_test-key-1234567890',
  },
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: {
    session_mode: 'cli',
    corporate_mode_enabled: false,
    max_concurrent_code_sessions: 5,
  },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('dev\n'),
  exec: vi
    .fn()
    .mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        callback: (
          err: Error | null,
          result?: { stdout: string; stderr: string },
        ) => void,
      ) => {
        callback(null, { stdout: '', stderr: '' });
      },
    ),
}));

const writtenFiles = new Map<string, string>();

vi.mock('fs', () => {
  const existsSync = vi.fn().mockReturnValue(true);
  const mkdirSync = vi.fn();
  const writeFileSync = vi
    .fn()
    .mockImplementation((p: string, content: string) => {
      writtenFiles.set(String(p), String(content));
    });
  const unlinkSync = vi.fn();
  const rmSync = vi.fn();
  const readdirSync = vi.fn().mockReturnValue([]);
  const readFileSync = vi.fn().mockReturnValue('');
  const statSync = vi.fn().mockReturnValue({ isDirectory: () => true });
  return {
    default: {
      existsSync,
      mkdirSync,
      writeFileSync,
      unlinkSync,
      rmSync,
      readdirSync,
      readFileSync,
      statSync,
    },
    existsSync,
    mkdirSync,
    writeFileSync,
    unlinkSync,
    rmSync,
    readdirSync,
    readFileSync,
    statSync,
  };
});

import path from 'path';
import {
  SessionManager,
  writeMcpConfig,
  mcpConfigDir,
} from '../SessionManager';
import { _resetStageCredentialsForTesting } from '../../auth/SessionStageAuth';
import { getSession } from '../../db/queries';
import { getProjectById } from '../../config';
import * as fsModule from 'fs';

const PROJECT_DIR = '/project';

function makeProject() {
  return {
    id: 'project-1',
    projectDir: PROJECT_DIR,
    baseBranch: 'dev',
    gitMode: undefined,
  } as any;
}

describe('writeMcpConfig — per-session collision fix', () => {
  beforeEach(() => {
    writtenFiles.clear();
    _resetStageCredentialsForTesting();
    vi.mocked(fsModule.writeFileSync).mockClear();
  });

  it('produces distinct file paths for two different sessionIds sharing the same projectDir (no collision)', () => {
    const pathA = writeMcpConfig(PROJECT_DIR, 'session-aaaa', undefined);
    const pathB = writeMcpConfig(PROJECT_DIR, 'session-bbbb', undefined);

    expect(pathA).not.toBe(pathB);
    expect(pathA).toBe(path.join(mcpConfigDir(), 'session-aaaa.mcp.json'));
    expect(pathB).toBe(path.join(mcpConfigDir(), 'session-bbbb.mcp.json'));
    // Neither file is sited under the project checkout.
    expect(pathA.startsWith(PROJECT_DIR)).toBe(false);
    expect(pathB.startsWith(PROJECT_DIR)).toBe(false);
  });

  it('gives two concurrent planning sessions (same projectDir) each their own embedded stage credential', () => {
    // Planning sessions run with worktreePath === projectDir; simulate two
    // dispatched concurrently against the same shared project checkout.
    const pathA = writeMcpConfig(PROJECT_DIR, 'planning-session-a', undefined);
    const pathB = writeMcpConfig(PROJECT_DIR, 'planning-session-b', undefined);

    const contentA = JSON.parse(writtenFiles.get(pathA)!);
    const contentB = JSON.parse(writtenFiles.get(pathB)!);

    const tokenA = contentA.mcpServers.orchestrator.headers.Authorization;
    const tokenB = contentB.mcpServers.orchestrator.headers.Authorization;

    expect(tokenA).toEqual(expect.stringMatching(/^Bearer .+/));
    expect(tokenB).toEqual(expect.stringMatching(/^Bearer .+/));
    expect(tokenA).not.toBe(tokenB);

    // Neither file's write clobbered the other's — both remain retrievable
    // by their own per-session path.
    expect(writtenFiles.has(pathA)).toBe(true);
    expect(writtenFiles.has(pathB)).toBe(true);
  });

  it('still writes a config for a coding session with an isolated per-session worktree (no regression)', () => {
    const isolatedWorktreeProjectDir = PROJECT_DIR; // coding sessions still pass projectDir now
    const codingPath = writeMcpConfig(
      isolatedWorktreeProjectDir,
      'coding-session-1',
      { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } },
    );

    expect(codingPath).toBe(
      path.join(mcpConfigDir(), 'coding-session-1.mcp.json'),
    );
    const written = JSON.parse(writtenFiles.get(codingPath)!);
    expect(written.mcpServers.github).toBeDefined();
    expect(written.mcpServers.orchestrator).toBeDefined();
  });

  it("registers both the orchestrator and notion servers for a Notion-task-source project's session", () => {
    const notionPath = writeMcpConfig(
      PROJECT_DIR,
      'notion-session-1',
      undefined,
      'notion',
    );
    const written = JSON.parse(writtenFiles.get(notionPath)!);
    expect(written.mcpServers.orchestrator).toBeDefined();
    expect(written.mcpServers.notion).toBeDefined();
  });

  it.each(['jira', 'yaml', 'github', undefined] as const)(
    'registers only the orchestrator server for a %s-task-source session (no notion entry)',
    (taskSource) => {
      const p = writeMcpConfig(
        PROJECT_DIR,
        `non-notion-session-${String(taskSource)}`,
        undefined,
        taskSource,
      );
      const written = JSON.parse(writtenFiles.get(p)!);
      expect(written.mcpServers.orchestrator).toBeDefined();
      expect(written.mcpServers.notion).toBeUndefined();
    },
  );

  it('still merges per-project mcp_servers extras for a Notion-task-source project (no regression)', () => {
    const p = writeMcpConfig(
      PROJECT_DIR,
      'notion-session-with-extras',
      { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } },
      'notion',
    );
    const written = JSON.parse(writtenFiles.get(p)!);
    expect(written.mcpServers.github).toBeDefined();
    expect(written.mcpServers.notion).toBeDefined();
    expect(written.mcpServers.orchestrator).toBeDefined();
  });

  it('inlines the resolved Notion API key under NOTION_TOKEN and writes the config file mode 600', () => {
    const p = writeMcpConfig(
      PROJECT_DIR,
      'notion-session-secret',
      undefined,
      'notion',
    );
    const rawContent = writtenFiles.get(p)!;
    expect(rawContent).toContain('"NOTION_TOKEN": "ntn_test-key-1234567890"');
    expect(rawContent).not.toContain('${NOTION_API_KEY}');

    const call = vi
      .mocked(fsModule.writeFileSync)
      .mock.calls.find(([calledPath]) => calledPath === p);
    expect(call).toBeDefined();
    const options = call![2] as { mode?: number } | string | undefined;
    expect(typeof options === 'object' ? options?.mode : undefined).toBe(0o600);
  });

  it('never writes the raw Notion API key to a file under the project checkout', () => {
    const p = writeMcpConfig(
      PROJECT_DIR,
      'notion-session-checkout-safety',
      undefined,
      'notion',
    );

    // The config carrying the raw key is sited outside the project checkout...
    expect(p.startsWith(PROJECT_DIR)).toBe(false);

    // ...and no write call this test observed targeted a path under the
    // project checkout at all, raw key or otherwise.
    const checkoutWrites = vi
      .mocked(fsModule.writeFileSync)
      .mock.calls.filter(([calledPath]) =>
        String(calledPath).startsWith(PROJECT_DIR),
      );
    expect(checkoutWrites).toHaveLength(0);
  });
});

describe('cleanupWorktree — removes the per-session MCP config for the correct session only', () => {
  let sm: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    writtenFiles.clear();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue({
      status: 'done',
      pr_url: null,
    } as any);
  });

  it('unlinks only the target session file, leaving a concurrently-run sibling session file path untouched', () => {
    const sessionA = 'session-to-clean';
    const sessionB = 'session-still-running';
    const worktreePathA = `${PROJECT_DIR}/.claude/worktrees/${sessionA}`;

    (sm as any).cleanupWorktree(
      sessionA,
      worktreePathA,
      undefined,
      PROJECT_DIR,
    );

    const expectedFileA = path.join(mcpConfigDir(), `${sessionA}.mcp.json`);
    const unlinkCalls = vi
      .mocked(fsModule.unlinkSync)
      .mock.calls.map((call) => call[0]);
    expect(unlinkCalls).toContain(expectedFileA);
    expect(unlinkCalls.some((p) => String(p).includes(sessionB))).toBe(false);
  });
});
