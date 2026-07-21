import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRunnerOptions } from '../SessionRunner';

const mockRuntimeSettings = vi.hoisted(() => ({
  large_task_model: '',
  code_session_model: '',
  review_session_model: '',
  planning_session_model: '',
  ops_session_model: '',
  large_task_effort: '',
  code_session_effort: '',
  review_session_effort: '',
  planning_session_effort: '',
  corporate_mode_enabled: false,
}));

const runCalls = vi.hoisted(
  () =>
    [] as Array<{
      prompt: string | undefined;
      options: SessionRunnerOptions;
    }>,
);

vi.mock('../../db/queries', () => ({
  upsertSessionEvent: vi.fn().mockReturnValue(1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getEventsBySession: vi.fn().mockReturnValue([]),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
  incrementCompactionCount: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSessionTags: vi.fn().mockReturnValue([]),
  setSessionTags: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  getGrantedCapabilities: vi.fn().mockReturnValue([]),
  setTaskPauseReason: vi.fn(),
  hasStagedIntentForSession: vi.fn().mockReturnValue(true),
  getSession: vi.fn().mockReturnValue(null),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn().mockReturnValue(0),
  countEventsBySessionAndType: vi.fn().mockReturnValue(1),
}));

vi.mock('../filePollutionCheck', () => ({
  runFilePollutionCheck: vi.fn().mockResolvedValue({ revertCommitSha: null }),
}));

vi.mock('../../github/PRBodyValidator', () => ({
  validatePRBody: vi.fn().mockReturnValue({ valid: true, missingSections: [] }),
  buildValidationComment: vi.fn().mockReturnValue(''),
}));

vi.mock('../../github/CommitAttributionWatcher', () => ({
  checkCommitAttribution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}));

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  GROOM_ALLOWED_TOOLS: [],
  DESIGN_ALLOWED_TOOLS: [],
  OPS_ALLOWED_TOOLS: [],
  GITHUB_REPO: 'owner/repo',
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: mockRuntimeSettings,
  getProjectById: vi.fn().mockReturnValue(null),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi
      .fn()
      .mockImplementation(
        (
          prompt: string | undefined,
          _resume: unknown,
          options: SessionRunnerOptions,
          onEvent: (e: Record<string, unknown>) => void,
        ) => {
          runCalls.push({ prompt, options });
          onEvent({ type: 'system', subtype: 'init' });
          return Promise.resolve(0);
        },
      ),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    hasSpawnError: false,
  })),
}));

import { AgentSession } from '../AgentSession';

function makeSession(
  sessionType: 'standard' | 'review' | 'groom' | 'design' | 'ops',
) {
  return new AgentSession(
    'test-session-prompt',
    'https://notion.so/task',
    'https://notion.so/project',
    {
      attachPR: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue(null),
    } as never,
    '/tmp/worktree',
    'task-123',
    undefined,
    undefined,
    sessionType,
  );
}

beforeEach(() => {
  runCalls.length = 0;
  vi.clearAllMocks();
});

describe('AgentSession — initial prompt by session type', () => {
  it.each(['groom', 'design', 'ops'] as const)(
    '%s session prompt has no PR/branch-verify instruction',
    async (sessionType) => {
      const session = makeSession(sessionType);
      await session.run();

      expect(runCalls).toHaveLength(1);
      const prompt = runCalls[0].prompt ?? '';
      expect(prompt).not.toMatch(/open a draft pr/i);
      expect(prompt).not.toMatch(/git branch --show-current/i);
      expect(prompt).not.toMatch(/never merge your own pr/i);
    },
  );

  it('standard session prompt still instructs opening a draft PR and verifying the branch', async () => {
    const session = makeSession('standard');
    await session.run();

    expect(runCalls).toHaveLength(1);
    const prompt = runCalls[0].prompt ?? '';
    expect(prompt).toMatch(/open a draft pr/i);
    expect(prompt).toMatch(/git branch --show-current/i);
  });
});
