import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRunnerOptions } from '../SessionRunner';

// vi.hoisted ensures the variable exists before the hoisted vi.mock factories run.
const mockRuntimeSettings = vi.hoisted(() => ({
  corporate_mode_enabled: false,
  large_task_model: '',
  code_session_model: '',
  review_session_model: '',
}));

const capturedRunOptions = vi.hoisted(() => ({ value: null as SessionRunnerOptions | null }));

vi.mock('../../db/queries', () => ({
  upsertSessionEvent: vi.fn().mockReturnValue(1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
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
  GITHUB_REPO: 'owner/repo',
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: mockRuntimeSettings,
  getProjectById: vi.fn().mockReturnValue(null),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockImplementation(
      (_prompt: unknown, _resume: unknown, options: SessionRunnerOptions) => {
        capturedRunOptions.value = options;
        // Exit immediately with non-zero so AgentSession terminates quickly.
        return Promise.resolve(1);
      },
    ),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    hasSpawnError: false,
  })),
}));

import { AgentSession } from '../AgentSession';

const taskBackend = {
  attachPR: vi.fn().mockResolvedValue(undefined),
  getTask: vi.fn().mockResolvedValue(null),
};

function makeSession(sessionType: 'standard' | 'review') {
  return new AgentSession(
    'test-session-id',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    '/tmp/worktree',
    'task-123',
    undefined,
    undefined,
    sessionType,
  );
}

beforeEach(() => {
  capturedRunOptions.value = null;
  mockRuntimeSettings.large_task_model = '';
  vi.clearAllMocks();
});

describe('AgentSession autocompact per-spawn option', () => {
  it('code session: disableAutoCompact is true when large_task_model is set', async () => {
    mockRuntimeSettings.large_task_model = 'claude-opus-4-7[1m]';
    const session = makeSession('standard');
    await session.run();
    expect(capturedRunOptions.value?.disableAutoCompact).toBe(true);
  });

  it('review session: disableAutoCompact is true when large_task_model is set', async () => {
    mockRuntimeSettings.large_task_model = 'claude-opus-4-7[1m]';
    const session = makeSession('review');
    await session.run();
    expect(capturedRunOptions.value?.disableAutoCompact).toBe(true);
  });

  it('code session: disableAutoCompact is false when large_task_model is empty', async () => {
    mockRuntimeSettings.large_task_model = '';
    const session = makeSession('standard');
    await session.run();
    expect(capturedRunOptions.value?.disableAutoCompact).toBe(false);
  });

  it('review session: disableAutoCompact is false when large_task_model is empty', async () => {
    mockRuntimeSettings.large_task_model = '';
    const session = makeSession('review');
    await session.run();
    expect(capturedRunOptions.value?.disableAutoCompact).toBe(false);
  });
});
