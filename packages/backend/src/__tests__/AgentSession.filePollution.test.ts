import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Mocks must be declared before imports ─────────────────────────────────────

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk: unknown, _enc: unknown, cb: () => void) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 12345,
    exitCode: null,
  });
  return { proc, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execFile: vi.fn(),
  execSync: vi.fn(() => 'claude'),
}));

vi.mock('../github/PRFileReverter', () => ({
  revertBannedFiles: vi.fn().mockResolvedValue({
    commitSha: 'abc123def456',
    reverted: ['CLAUDE.md'],
  }),
}));

vi.mock('../github/PRFileValidator', () => ({
  validatePRFiles: vi.fn().mockReturnValue({
    valid: false,
    bannedFiles: ['CLAUDE.md'],
    reason: 'hard_banned',
  }),
  HARD_BANNED_FILES: ['CLAUDE.md', '.commit-msg', '.commit_msg'],
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../session/SessionAuditor', () => ({
  SessionAuditor: vi.fn().mockImplementation(() => ({
    audit: vi.fn().mockResolvedValue({
      sessionId: 'e2e-pollution-session',
      prOpened: true,
      prTargetsBranch: 'dev',
      taskStatusAfter: '👀 In Review',
      violations: [],
      specMismatch: null,
      auditedAt: Date.now(),
    }),
  })),
}));

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
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

// ── PR row shape used by push-detected tests ──────────────────────────────────

const MOCK_PR_ROW = {
  pr_number: 77,
  repo: 'myorg/myrepo',
  base_branch: 'dev',
  session_id: 'push-session',
  pr_url: 'https://github.com/myorg/myrepo/pull/77',
  head_sha: null,
  review_session_id: null,
  task_id: null,
  title: null,
  body: null,
  head_branch: null,
  state: 'open',
  draft: 1,
  review_result: null,
  review_at: null,
  created_at: '',
  updated_at: '',
  synced_at: '',
  node_id: null,
};

// ── Imports after mocks ───────────────────────────────────────────────────────

import { AgentSession } from '../session/AgentSession';
import { revertBannedFiles } from '../github/PRFileReverter';
import { validatePRFiles } from '../github/PRFileValidator';
import { recordEvent } from '../audit/AuditLog';
import { getPRBySessionId } from '../db/queries';
import type { GitHubClient } from '../github/GitHubClient';
import type { TaskBackend } from '../tasks/TaskBackend';

function fakeBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  } as unknown as TaskBackend;
}

describe('AgentSession — file pollution E2E integration', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
    vi.mocked(revertBannedFiles).mockResolvedValue({
      commitSha: 'abc123def456',
      reverted: ['CLAUDE.md'],
    });
    vi.mocked(validatePRFiles).mockReturnValue({
      valid: false,
      bannedFiles: ['CLAUDE.md'],
      reason: 'hard_banned',
    });
  });

  it('E2E: PR opened with CLAUDE.md in diff → handlePRCreatedFromContent triggers reverter → file_pollution_reverted audit entry written with { files, pr_number, commit_sha }', async () => {
    const mockGitHubClient = {
      getPRFiles: vi.fn().mockResolvedValue(['CLAUDE.md', 'src/index.ts']),
      createIssueComment: vi.fn().mockResolvedValue(undefined),
      ensureLabelExists: vi.fn().mockResolvedValue(undefined),
      addLabelToPR: vi.fn().mockResolvedValue(undefined),
      fetchPR: vi
        .fn()
        .mockResolvedValue({ headSha: 'head-sha-abc', nodeId: 'node-abc' }),
    } as unknown as GitHubClient;

    const session = new AgentSession(
      'e2e-pollution-session',
      'https://notion.so/task-e2e',
      'https://notion.so/ctx-e2e',
      fakeBackend(),
      '/tmp', // worktreePath — just needs to exist for collectGitignoreSources
      'task-e2e-id',
      undefined, // resumeSessionId
      undefined, // customPrompt
      'standard', // sessionType
      undefined, // sessionManager
      mockGitHubClient,
    );

    const runPromise = session.run();

    // Step 1: emit assistant event registering mcp__github__create_pull_request tool_use
    const toolUseId = 'tu-e2e-pr-001';
    mockProc.stdout.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-e2e-pr',
          content: [
            {
              type: 'tool_use',
              id: toolUseId,
              name: 'mcp__github__create_pull_request',
              input: {},
            },
          ],
        },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    // Step 2: emit tool_result with the GitHub PR JSON response
    const prJson = JSON.stringify({
      number: 77,
      html_url: 'https://github.com/myorg/myrepo/pull/77',
      title: 'My PR',
      body: '## Summary\n...\n## Notion Task\n...\n## Automated Tests\n...\n## Files Changed\n...',
      head: { ref: 'feature/foo', sha: 'head-sha-abc' },
      base: { ref: 'dev' },
      state: 'open',
      draft: true,
      created_at: '2026-04-02T00:00:00Z',
      updated_at: '2026-04-02T00:00:00Z',
    });
    mockProc.stdout.push(
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: prJson }],
      }) + '\n',
    );

    // Wait for the async handlePRCreatedFromContent + runFilePollutionCheck to complete
    await new Promise((r) => setTimeout(r, 300));

    // Verify getPRFiles was called on the GitHub client
    expect(mockGitHubClient.getPRFiles).toHaveBeenCalledWith(
      'myorg/myrepo',
      77,
    );

    // Verify validatePRFiles was called with the returned file list
    expect(validatePRFiles).toHaveBeenCalledWith(
      ['CLAUDE.md', 'src/index.ts'],
      expect.any(Array),
    );

    // Verify revertBannedFiles was called with the correct parameters
    expect(revertBannedFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/tmp',
        baseBranch: 'dev',
        bannedFiles: ['CLAUDE.md'],
        prNumber: 77,
        repo: 'myorg/myrepo',
      }),
    );

    // Verify the file_pollution_reverted audit entry was written
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'file_pollution_reverted',
        actor_type: 'system',
        actor_id: 'e2e-pollution-session',
        payload: {
          files: ['CLAUDE.md'],
          pr_number: 77,
          commit_sha: 'abc123def456',
        },
      }),
    );

    // Verify a PR comment was posted listing the reverted files
    expect(mockGitHubClient.createIssueComment).toHaveBeenCalledWith(
      'myorg/myrepo',
      77,
      expect.stringContaining('CLAUDE.md'),
    );

    // Clean up session
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });
});

// ── Push-detected test helpers ────────────────────────────────────────────────

function emitPush(stdout: Readable, toolUseId: string, msgId?: string): void {
  stdout.push(
    JSON.stringify({
      type: 'assistant',
      message: {
        id: msgId ?? `msg-push-${toolUseId}`,
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'mcp__github__push_files',
            input: {},
          },
        ],
      },
    }) + '\n',
  );
  stdout.push(
    JSON.stringify({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [{ type: 'text', text: 'files pushed' }],
    }) + '\n',
  );
}

function makeSession(sessionId: string, ghClient: GitHubClient): AgentSession {
  return new AgentSession(
    sessionId,
    'https://notion.so/task',
    'https://notion.so/ctx',
    fakeBackend(),
    '/tmp',
    'task-id',
    undefined,
    undefined,
    'standard',
    undefined,
    ghClient,
  );
}

// ── Push-detected test suite ───────────────────────────────────────────────────

describe('AgentSession — file pollution on push-detected', () => {
  let runPromise: Promise<void>;
  let session: AgentSession;

  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
    vi.mocked(revertBannedFiles).mockResolvedValue({
      commitSha: 'abc123def456',
      reverted: ['CLAUDE.md'],
    });
    vi.mocked(validatePRFiles).mockReturnValue({
      valid: false,
      bannedFiles: ['CLAUDE.md'],
      reason: 'hard_banned',
    });
    vi.mocked(getPRBySessionId).mockReturnValue(
      MOCK_PR_ROW as ReturnType<typeof getPRBySessionId>,
    );
  });

  afterEach(async () => {
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('second push_detected event triggers a fresh validator + reverter cycle when HEAD SHA differs from last revert SHA', async () => {
    let fetchCount = 0;
    const ghClient = {
      getPRFiles: vi.fn().mockResolvedValue(['CLAUDE.md', 'src/foo.ts']),
      createIssueComment: vi.fn().mockResolvedValue(undefined),
      fetchPR: vi.fn().mockImplementation(() => {
        fetchCount++;
        return Promise.resolve({
          headSha: `sha-${fetchCount}`,
          nodeId: 'node-x',
        });
      }),
    } as unknown as GitHubClient;

    session = makeSession('push-session-two-pushes', ghClient);
    runPromise = session.run();

    // First push: guard passes (no last revert SHA yet), revert fires
    emitPush(mockProc.stdout, 'tu-push-01');
    await new Promise((r) => setTimeout(r, 300));
    expect(revertBannedFiles).toHaveBeenCalledTimes(1);

    // Second push: fetchPR returns a NEW SHA (not the revert SHA), guard passes again
    emitPush(mockProc.stdout, 'tu-push-02');
    await new Promise((r) => setTimeout(r, 300));
    expect(revertBannedFiles).toHaveBeenCalledTimes(2);
  });

  it('validator does NOT re-fire when HEAD SHA equals last revert commit SHA (loop guard)', async () => {
    vi.mocked(revertBannedFiles).mockResolvedValue({
      commitSha: 'revert-sha-fixed',
      reverted: ['CLAUDE.md'],
    });

    let fetchCount = 0;
    const ghClient = {
      getPRFiles: vi.fn().mockResolvedValue(['CLAUDE.md']),
      createIssueComment: vi.fn().mockResolvedValue(undefined),
      fetchPR: vi.fn().mockImplementation(() => {
        fetchCount++;
        // First call: new SHA → guard passes, revert fires, lastRevertSha = 'revert-sha-fixed'
        // Second call: return the revert SHA itself → guard skips
        const sha = fetchCount === 1 ? 'session-sha-001' : 'revert-sha-fixed';
        return Promise.resolve({ headSha: sha, nodeId: 'node-x' });
      }),
    } as unknown as GitHubClient;

    session = makeSession('push-session-loop-guard', ghClient);
    runPromise = session.run();

    // First push: new SHA, guard passes → revert fires → lastRevertSha = 'revert-sha-fixed'
    emitPush(mockProc.stdout, 'tu-guard-01');
    await new Promise((r) => setTimeout(r, 300));
    expect(revertBannedFiles).toHaveBeenCalledTimes(1);

    // Second push: HEAD SHA = 'revert-sha-fixed' = lastRevertSha → guard skips
    emitPush(mockProc.stdout, 'tu-guard-02');
    await new Promise((r) => setTimeout(r, 300));
    // Still only 1 invocation — guard prevented the second
    expect(revertBannedFiles).toHaveBeenCalledTimes(1);
  });

  it('a new banned file introduced on a new push (new SHA) is caught and file_pollution_reverted is written again', async () => {
    let revertCount = 0;
    vi.mocked(revertBannedFiles).mockImplementation(() => {
      revertCount++;
      return Promise.resolve({
        commitSha: `revert-sha-${revertCount}`,
        reverted: ['CLAUDE.md'],
      });
    });

    let fetchCount = 0;
    const ghClient = {
      getPRFiles: vi.fn().mockResolvedValue(['CLAUDE.md']),
      createIssueComment: vi.fn().mockResolvedValue(undefined),
      fetchPR: vi.fn().mockImplementation(() => {
        fetchCount++;
        return Promise.resolve({
          headSha: `session-sha-${fetchCount}`,
          nodeId: 'node-x',
        });
      }),
    } as unknown as GitHubClient;

    session = makeSession('push-session-multi-revert', ghClient);
    runPromise = session.run();

    // Push 1: revert fires (revert-sha-1 stored)
    emitPush(mockProc.stdout, 'tu-multi-01');
    await new Promise((r) => setTimeout(r, 300));
    expect(revertBannedFiles).toHaveBeenCalledTimes(1);

    // Push 2: new SHA ≠ revert-sha-1 → guard passes → revert fires again
    emitPush(mockProc.stdout, 'tu-multi-02');
    await new Promise((r) => setTimeout(r, 300));
    expect(revertBannedFiles).toHaveBeenCalledTimes(2);

    const revertedCalls = vi
      .mocked(recordEvent)
      .mock.calls.filter(([e]) => e.event_type === 'file_pollution_reverted');
    expect(revertedCalls).toHaveLength(2);
  });

  it('file_pollution_checked audit entry fires on every push-detected validation run, with banned_files_found: 0 when clean', async () => {
    vi.mocked(validatePRFiles).mockReturnValue({
      valid: true,
      bannedFiles: [],
    });

    const ghClient = {
      getPRFiles: vi.fn().mockResolvedValue(['src/index.ts']),
      createIssueComment: vi.fn().mockResolvedValue(undefined),
      fetchPR: vi
        .fn()
        .mockResolvedValue({ headSha: 'clean-sha', nodeId: 'node-x' }),
    } as unknown as GitHubClient;

    session = makeSession('push-session-clean', ghClient);
    runPromise = session.run();

    emitPush(mockProc.stdout, 'tu-clean-01');
    await new Promise((r) => setTimeout(r, 300));

    expect(revertBannedFiles).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'file_pollution_checked',
        actor_type: 'system',
        payload: expect.objectContaining({
          pr_number: 77,
          repo: 'myorg/myrepo',
          banned_files_found: 0,
        }),
      }),
    );
  });

  it('integration: PR #410 sequence — two pushes each with CLAUDE.md produce two file_pollution_reverted entries', async () => {
    let revertCallCount = 0;
    vi.mocked(revertBannedFiles).mockImplementation(() => {
      revertCallCount++;
      return Promise.resolve({
        commitSha: `pr410-revert-sha-${revertCallCount}`,
        reverted: ['CLAUDE.MD'],
      });
    });
    vi.mocked(validatePRFiles).mockReturnValue({
      valid: false,
      bannedFiles: ['CLAUDE.MD'],
      reason: 'hard_banned',
    });

    let fetchSeq = 0;
    const ghClient = {
      getPRFiles: vi.fn().mockResolvedValue(['CLAUDE.MD', 'src/main.ts']),
      createIssueComment: vi.fn().mockResolvedValue(undefined),
      fetchPR: vi.fn().mockImplementation(() => {
        fetchSeq++;
        return Promise.resolve({
          headSha: `pr410-session-sha-${fetchSeq}`,
          nodeId: 'node-410',
        });
      }),
    } as unknown as GitHubClient;

    session = makeSession('pr410-session', ghClient);
    runPromise = session.run();

    // First push (session introduces CLAUDE.MD)
    emitPush(mockProc.stdout, 'tu-410-01');
    await new Promise((r) => setTimeout(r, 300));

    // Second push (session re-introduces CLAUDE.MD after review feedback)
    emitPush(mockProc.stdout, 'tu-410-02');
    await new Promise((r) => setTimeout(r, 300));

    const revertedCalls = vi
      .mocked(recordEvent)
      .mock.calls.filter(([e]) => e.event_type === 'file_pollution_reverted');
    expect(revertedCalls).toHaveLength(2);
    expect(revertedCalls[0][0].payload).toMatchObject({
      pr_number: 77,
      commit_sha: 'pr410-revert-sha-1',
    });
    expect(revertedCalls[1][0].payload).toMatchObject({
      pr_number: 77,
      commit_sha: 'pr410-revert-sha-2',
    });
  });
});
