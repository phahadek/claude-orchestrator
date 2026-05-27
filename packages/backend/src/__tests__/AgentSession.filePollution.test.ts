import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// ── Imports after mocks ───────────────────────────────────────────────────────

import { AgentSession } from '../session/AgentSession';
import { revertBannedFiles } from '../github/PRFileReverter';
import { validatePRFiles } from '../github/PRFileValidator';
import { recordEvent } from '../audit/AuditLog';
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
