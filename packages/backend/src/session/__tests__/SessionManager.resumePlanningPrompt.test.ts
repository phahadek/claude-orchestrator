/**
 * Regression coverage for the resume-side system-prompt builder branch
 * (_buildAndWriteResumeSystemPrompt). Before this fix, every resume — of
 * every session type — unconditionally called buildSessionContext and
 * overwrote the system-prompt file, silently replacing a planning session's
 * assembled procedure (written once at dispatch) with the coding scaffold.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const { mockBuildSessionContext } = vi.hoisted(() => ({
  mockBuildSessionContext: vi.fn().mockReturnValue('CODING SCAFFOLD'),
}));
vi.mock('../ContextBuilder', () => ({
  buildSessionContext: mockBuildSessionContext,
}));

vi.mock('../branchModel', () => ({
  resolveStartingPoint: vi
    .fn()
    .mockReturnValue({ startingPoint: 'dev', milestoneSlug: null }),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi.fn().mockReturnValue('feature/my-task'),
  resolveResumeBranchSlug: vi.fn().mockReturnValue('feature/my-task'),
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
    fetchTaskPage: vi.fn().mockResolvedValue(''),
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

import { SessionManager, writeSystemPromptFile } from '../SessionManager';
import type { Session } from '../../db/types';
import type { SessionType } from '../sessionPredicates';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

function makeRow(sessionType: SessionType, sessionId = SESSION_ID): Session {
  return {
    session_id: sessionId,
    task_id: 'notion:task-abc',
    task_url: 'https://example.com/task',
    project_context_url: 'https://example.com/context',
    project_id: 'proj-1',
    status: 'running',
    started_at: 0,
    ended_at: null,
    terminalized_at: null,
    pr_url: null,
    worktree_path: null,
    archived: 0,
    favorited: 0,
    session_type: sessionType,
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    model: null,
    effort: null,
    task_name: 'My Task',
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    granted_capabilities: '[]',
    pending_done_ended_at: null,
    pending_done_pr_url: null,
    pending_done_call_site: null,
    terminal_completion_reason: null,
  };
}

const PROJECT = {
  id: 'proj-1',
  baseBranch: 'dev',
  taskSource: 'notion',
  gitMode: 'github',
} as any;

const ORCH_CONFIG = {
  verify: [],
  bash_rules: [],
  session_rules: [],
  review_rules: ['some review rule'],
} as any;

describe('SessionManager — _buildAndWriteResumeSystemPrompt', () => {
  let projectDir: string;
  let sm: SessionManager;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'resume-prompt-test-'),
    );
    sm = new SessionManager();
    mockBuildSessionContext.mockClear();
    mockRecordEvent.mockClear();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const planningTypes: SessionType[] = ['groom', 'design', 'ops', 'split', 'docs'];

  for (const sessionType of planningTypes) {
    it(`reuses the existing on-disk prompt file untouched for a resumed ${sessionType} session`, async () => {
      const row = makeRow(sessionType);
      const assembledProcedure =
        '# Grooming Procedure\n\n### Present\n\ndecision.pickOne\n'.repeat(3);
      const existingPath = writeSystemPromptFile(
        projectDir,
        row.session_id,
        assembledProcedure,
      );
      const before = fs.readFileSync(existingPath, 'utf-8');

      const result = await (sm as any)._buildAndWriteResumeSystemPrompt(
        row,
        PROJECT,
        ORCH_CONFIG,
        projectDir,
        projectDir,
      );

      expect(result).toBe(existingPath);
      const after = fs.readFileSync(existingPath, 'utf-8');
      expect(after).toBe(before);
      expect(after).toContain('pickOne');
      expect(after).not.toContain('## Pre-PR Gate');
      expect(mockBuildSessionContext).not.toHaveBeenCalled();
    });
  }

  it('fails loud when a planning session has no on-disk prompt file at resume time', async () => {
    const row = makeRow('design');

    await expect(
      (sm as any)._buildAndWriteResumeSystemPrompt(
        row,
        PROJECT,
        ORCH_CONFIG,
        projectDir,
        projectDir,
      ),
    ).rejects.toThrow(/no on-disk system-prompt file/);
    expect(mockBuildSessionContext).not.toHaveBeenCalled();
  });

  it('still writes the coding context via buildSessionContext for a resumed standard session', async () => {
    const row = makeRow('standard');
    const worktreePath = path.join(projectDir, 'worktree');

    const result = await (sm as any)._buildAndWriteResumeSystemPrompt(
      row,
      PROJECT,
      ORCH_CONFIG,
      projectDir,
      worktreePath,
    );

    expect(mockBuildSessionContext).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    const content = fs.readFileSync(result as string, 'utf-8');
    expect(content).toBe('CODING SCAFFOLD');
  });

  it('calls buildReviewClaudeMd (not buildSessionContext, not a reused file) for a resumed review session', async () => {
    const row = makeRow('review');

    const result = await (sm as any)._buildAndWriteResumeSystemPrompt(
      row,
      PROJECT,
      ORCH_CONFIG,
      projectDir,
      projectDir,
    );

    expect(mockBuildSessionContext).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    const content = fs.readFileSync(result as string, 'utf-8');
    expect(content).toContain('Review Session Rules');
  });

  it('calls buildDepthReviewClaudeMd (not buildSessionContext, not a reused file) for a resumed depth_review session', async () => {
    const row = makeRow('depth_review');

    const result = await (sm as any)._buildAndWriteResumeSystemPrompt(
      row,
      PROJECT,
      ORCH_CONFIG,
      projectDir,
      projectDir,
    );

    expect(mockBuildSessionContext).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    const content = fs.readFileSync(result as string, 'utf-8');
    expect(content).toContain('Depth Review Session Rules');
  });
});
