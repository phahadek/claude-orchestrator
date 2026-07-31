import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/queries', () =>
  mockDbQueries({
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
    insertPauseInterval: vi.fn(),
    setHumanMergeOnly: vi.fn(),
  }),
);

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: { corporate_mode_enabled: false },
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
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

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { AgentSession } from '../AgentSession';
import { upsertPullRequest, setHumanMergeOnly } from '../../db/queries';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(sessionType: string): AgentSession {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
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

function sendEvent(session: AgentSession, event: Record<string, unknown>) {
  (
    session as unknown as {
      handleRawEvent: (e: Record<string, unknown>) => void;
    }
  ).handleRawEvent(event);
}

const PR_URL = 'https://github.com/owner/repo/pull/153';
const TOOL_USE_ID = 'toolu_bash_001';
const CMD = 'gh pr create --draft --base dev --body-file /tmp/pr-body.md';

function detectPR(session: AgentSession) {
  sendEvent(session, {
    type: 'assistant',
    message: {
      id: 'msg_001',
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: 'Bash',
          input: { command: CMD },
        },
      ],
    },
  });
  sendEvent(session, {
    type: 'tool_result',
    tool_use_id: TOOL_USE_ID,
    content: PR_URL,
  });
}

describe('AgentSession.handlePRDetected — docs human_merge_only gate', () => {
  beforeEach(() => {
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(setHumanMergeOnly).mockClear();
  });

  it('sets human_merge_only for a docs session PR', async () => {
    const session = makeSession('docs');
    detectPR(session);
    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 153, repo: 'owner/repo' }),
    );
    expect(setHumanMergeOnly).toHaveBeenCalledWith(153, 'owner/repo', true);
  });

  it('does not set human_merge_only for a standard session PR', async () => {
    const session = makeSession('standard');
    detectPR(session);
    await new Promise((r) => setImmediate(r));

    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 153, repo: 'owner/repo' }),
    );
    expect(setHumanMergeOnly).not.toHaveBeenCalled();
  });
});
