import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
    exitCode: null,
  }),
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

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
  insertPauseInterval: vi.fn(),
  setSessionPauseReason: vi.fn(),
  getSessionTags: vi.fn().mockReturnValue([]),
  setSessionTags: vi.fn(),
}));

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  GITHUB_REPO: 'owner/repo',
  runtimeSettings: { corporate_mode_enabled: false },
  getProjectById: vi.fn().mockReturnValue(null),
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

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../SessionAuditor', () => ({
  detectInFlightEscape: vi
    .fn()
    .mockReturnValue({ violations: [], specMismatch: null }),
}));

vi.mock('../../utils/eventFilters', () => ({
  isSystemOnlyUserEvent: vi.fn().mockReturnValue(false),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { execSync } from 'child_process';
import { AgentSession, MAX_REBASE_NUDGES } from '../AgentSession';
import { setPauseReason, getPRBySessionId } from '../../db/queries';

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKTREE = '/fake/worktree';

function makeSession(sendOrResume = vi.fn()): {
  session: AgentSession;
  sendOrResume: ReturnType<typeof vi.fn>;
} {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  const sessionManager = { sendOrResume } as never;
  const session = new AgentSession(
    'test-diverged-branch',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    WORKTREE,
    'task-123',
    undefined,
    undefined,
    'standard',
    sessionManager,
  );
  return { session, sendOrResume };
}

async function callHandlePushDetected(session: AgentSession): Promise<void> {
  await (
    session as unknown as { handlePushDetected(): Promise<void> }
  ).handlePushDetected();
}

function mockDivergedGit(branch: string, behind: number, ahead: number) {
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    if (cmd.includes('rev-parse --abbrev-ref'))
      return Buffer.from(`${branch}\n`);
    if (cmd.includes('rev-parse HEAD')) return Buffer.from('local111\n');
    if (cmd.includes('ls-remote')) return Buffer.from(`remote222\t${branch}\n`);
    if (cmd.includes('rev-list --left-right'))
      return Buffer.from(`${behind}\t${ahead}\n`);
    return Buffer.from('');
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentSession.handlePushDetected — diverged-branch nudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
  });

  it('nudges a rebase against the same ref the ahead/behind count was measured against', async () => {
    const branch = 'feature/diverged';
    mockDivergedGit(branch, 2, 1);
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      base_branch: 'dev',
    } as any);

    const { session, sendOrResume } = makeSession();
    await callHandlePushDetected(session);

    expect(sendOrResume).toHaveBeenCalledTimes(1);
    const [, nudgeMsg] = sendOrResume.mock.calls[0];
    expect(nudgeMsg).toContain(`git rebase origin/${branch}`);
    expect(nudgeMsg).not.toContain('git rebase origin/dev');

    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'diverged_branch',
    );
  });

  it('applying the nudged rebase against origin/<branch> absorbs the behind commits (behind becomes 0)', async () => {
    // Simulate: origin/<branch> carries autofix commits the session is behind on.
    // Rebasing onto origin/<branch> (as the corrected nudge instructs) replays
    // local work on top of it, so a subsequent measurement shows behind === 0.
    const branch = 'feature/diverged';
    let rebased = false;
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --abbrev-ref'))
        return Buffer.from(`${branch}\n`);
      if (cmd.includes('rev-parse HEAD')) return Buffer.from('local111\n');
      if (cmd.includes('ls-remote'))
        return Buffer.from(`remote222\t${branch}\n`);
      if (cmd.includes('rev-list --left-right'))
        return rebased ? Buffer.from('0\t3\n') : Buffer.from('2\t1\n');
      if (cmd.includes(`git rebase origin/${branch}`)) {
        rebased = true;
        return Buffer.from('');
      }
      return Buffer.from('');
    });
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      base_branch: 'dev',
    } as any);

    const { session, sendOrResume } = makeSession();
    await callHandlePushDetected(session);
    const [, nudgeMsg] = sendOrResume.mock.calls[0];
    const rebaseMatch = nudgeMsg.match(/git rebase origin\/([^\s,]+)/);
    expect(rebaseMatch?.[1]).toBe(branch);

    // Apply the prescribed remedy.
    execSync(`git rebase origin/${branch}`, { cwd: WORKTREE } as any);
    const aheadBehind = execSync(
      `git rev-list --left-right --count origin/${branch}...HEAD`,
      { cwd: WORKTREE } as any,
    )
      .toString()
      .trim();
    const [behind] = aheadBehind.split(/\s+/).map(Number);
    expect(behind).toBe(0);
  });

  it('issues no additional git invocations on the ahead>0 && behind===0 fast path', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --abbrev-ref'))
        return Buffer.from('feature/my-branch\n');
      if (cmd.includes('rev-parse HEAD')) return Buffer.from('abc1234\n');
      if (cmd.includes('ls-remote'))
        return Buffer.from('def5678\tfeature/my-branch\n');
      if (cmd.includes('rev-list --left-right')) return Buffer.from('0\t1\n');
      if (cmd.includes('git push')) return Buffer.from('');
      return Buffer.from('');
    });
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 10,
      repo: 'owner/repo',
    } as any);

    const { session } = makeSession();
    await callHandlePushDetected(session);

    // rev-parse --abbrev-ref, rev-parse HEAD, ls-remote, rev-list, git push,
    // plus the unconditional post-signal rev-parse HEAD = 6 calls total.
    expect(vi.mocked(execSync).mock.calls.length).toBe(6);
  });

  it('caps rebaseNudgeCount at MAX_REBASE_NUDGES and escalates to diverged_branch_unresolved on exhaustion', async () => {
    const branch = 'feature/diverged';
    mockDivergedGit(branch, 2, 1);
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      base_branch: 'dev',
    } as any);

    const { session } = makeSession();

    for (let i = 0; i < MAX_REBASE_NUDGES; i++) {
      await callHandlePushDetected(session);
    }
    expect(setPauseReason).toHaveBeenLastCalledWith(
      42,
      'owner/repo',
      'diverged_branch',
    );
    vi.mocked(setPauseReason).mockClear();

    // One more attempt beyond the cap escalates.
    await callHandlePushDetected(session);
    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'diverged_branch_unresolved',
    );
  });

  it('sets pause reason to diverged_branch on first divergence', async () => {
    const branch = 'feature/diverged';
    mockDivergedGit(branch, 2, 1);
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 7,
      repo: 'owner/repo',
      base_branch: 'dev',
    } as any);

    const { session } = makeSession();
    await callHandlePushDetected(session);

    expect(setPauseReason).toHaveBeenCalledWith(
      7,
      'owner/repo',
      'diverged_branch',
    );
  });
});
