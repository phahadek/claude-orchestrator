/**
 * Post-session drift detection for planning sessions: since planning
 * sessions store worktree_path: null, cleanupWorktree's own git-status
 * check never runs for them (it returns early via the isRemovableWorktree
 * guard — see cleanupWorktree — refuses non-worktree paths in
 * SessionManager.test.ts). checkPlanningSessionDrift is the dedicated
 * teardown-path check for planning sessions: detection only, never
 * auto-revert or auto-clean.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// SessionManager.ts pulls in a lot of unrelated subsystems at module scope.
// Stub those out; only checkPlanningSessionDrift (real fs + real git) is
// exercised here.
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
  isGrantable: vi.fn().mockReturnValue(false),
  isToolShapedCapability: vi.fn().mockReturnValue(false),
}));
vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));
const { mockRecordEvent } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: mockRecordEvent }));
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
vi.mock('../../config', () => ({
  config: {},
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: {
    session_mode: 'cli',
    corporate_mode_enabled: false,
    max_concurrent_code_sessions: 5,
  },
}));
vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { SessionManager } from '../SessionManager';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const TASK_ID = 'notion:task-abc';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('SessionManager — checkPlanningSessionDrift', () => {
  let projectDir: string;
  let sm: SessionManager;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-drift-test-'));
    git(projectDir, 'init', '-q');
    git(projectDir, 'config', 'user.email', 'test@example.com');
    git(projectDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(projectDir, 'a.txt'), 'hello\n');
    git(projectDir, 'add', 'a.txt');
    git(projectDir, 'commit', '-q', '-m', 'init');

    sm = new SessionManager();
    mockRecordEvent.mockClear();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('records an audit event naming the session, task, and dirty paths when the checkout is dirty', () => {
    fs.writeFileSync(path.join(projectDir, 'a.txt'), 'modified\n');
    fs.writeFileSync(path.join(projectDir, 'untracked.txt'), 'new\n');

    (sm as any).checkPlanningSessionDrift(SESSION_ID, TASK_ID, projectDir);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'planning_session_checkout_drift',
        actor_type: 'system',
        actor_id: SESSION_ID,
        task_id: TASK_ID,
        payload: expect.objectContaining({
          sessionId: SESSION_ID,
          projectDir,
          dirtyPaths: expect.arrayContaining([
            expect.stringContaining('a.txt'),
            expect.stringContaining('untracked.txt'),
          ]),
        }),
      }),
    );
  });

  it('records no event when the checkout is clean', () => {
    (sm as any).checkPlanningSessionDrift(SESSION_ID, TASK_ID, projectDir);

    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it('does not modify the working tree — a dirty file is unchanged after the check', () => {
    fs.writeFileSync(path.join(projectDir, 'a.txt'), 'modified\n');

    (sm as any).checkPlanningSessionDrift(SESSION_ID, TASK_ID, projectDir);

    expect(fs.readFileSync(path.join(projectDir, 'a.txt'), 'utf8')).toBe(
      'modified\n',
    );
    // Still dirty per git — the check never staged/committed/reverted it.
    const status = git(projectDir, 'status', '--porcelain').trim();
    expect(status).toContain('a.txt');
  });
});
