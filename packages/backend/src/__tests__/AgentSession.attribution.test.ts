import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdinChunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString());
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 12345,
  });
  return { proc, stdinChunks, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execFile: vi.fn(),
}));

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  insertPermissionEvent: vi.fn(),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  getRules: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  insertSessionAudit: vi.fn(),
  incrementTokens: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  getProjectRowById: vi.fn(() => null),
  insertLocalBranch: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return {
    ...actual,
    runtimeSettings: {
      ...actual.runtimeSettings,
      corporate_mode_enabled: false,
    },
  };
});

import { AgentSession } from '../session/AgentSession';
import { setPauseReason } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { runtimeSettings } from '../config';
import type { GitHubClient } from '../github/GitHubClient';

function fakeGitHubClient(): GitHubClient {
  return {
    fetchPR: vi.fn().mockResolvedValue({ headSha: 'abc' }),
    ensureLabelExists: vi.fn().mockResolvedValue(undefined),
    addLabelToPR: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    getCommitsForPR: vi.fn().mockResolvedValue([]),
  } as unknown as GitHubClient;
}

function fakeNotionBackend() {
  return {
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  };
}

const PR_JSON = JSON.stringify({
  number: 42,
  html_url: 'https://github.com/org/repo/pull/42',
  title: 'My PR',
  body: '## Summary\nAdded stuff\n\n## Notion Task\nhttps://notion.so/task\n\n## Automated Tests\nUnit tests added\n\n## Files Changed\n- file.ts',
  head: { ref: 'feature/foo', sha: 'deadbeef' },
  base: { ref: 'dev' },
  state: 'open',
  draft: true,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
});

const PR_JSON_INVALID_BODY = JSON.stringify({
  number: 43,
  html_url: 'https://github.com/org/repo/pull/43',
  title: 'Bad PR',
  body: 'Just a description, no sections.',
  head: { ref: 'feature/bar', sha: 'cafebabe' },
  base: { ref: 'dev' },
  state: 'open',
  draft: true,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
});

async function runPRCreationFlow(
  prJson: string,
  ghClient?: GitHubClient,
): Promise<AgentSession> {
  const session = new AgentSession(
    'test-session-1',
    'https://notion.so/task',
    'https://notion.so/ctx',
    fakeNotionBackend() as never,
    '/worktree',
    'task-id',
    undefined,
    undefined,
    'standard',
    undefined,
    ghClient,
  );

  void session.run();

  // Tool use for PR creation
  const toolUseId = 'tu-pr-1';
  mockProc.stdout.push(
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
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
  await new Promise((r) => setTimeout(r, 20));

  // Tool result with PR data
  mockProc.stdout.push(
    JSON.stringify({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [{ type: 'text', text: prJson }],
    }) + '\n',
  );
  await new Promise((r) => setTimeout(r, 50));

  return session;
}

describe('AgentSession — ai-authored label', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
    (runtimeSettings as { corporate_mode_enabled: boolean }).corporate_mode_enabled = false;
  });

  it('applies the ai-authored label to PRs opened by a session', async () => {
    const ghClient = fakeGitHubClient();
    await runPRCreationFlow(PR_JSON, ghClient);

    // Give fire-and-forget async tasks time to run
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(ghClient.ensureLabelExists)).toHaveBeenCalledWith(
      'org/repo',
      'ai-authored',
      expect.any(String),
      expect.any(String),
    );
    expect(vi.mocked(ghClient.addLabelToPR)).toHaveBeenCalledWith(
      'org/repo',
      42,
      'ai-authored',
    );
  });

  it('does not call label APIs when no GitHub client is provided', async () => {
    const ghClient = fakeGitHubClient();
    await runPRCreationFlow(PR_JSON, undefined);
    await new Promise((r) => setTimeout(r, 50));
    // No call expected since client is undefined
    expect(vi.mocked(ghClient.addLabelToPR)).not.toHaveBeenCalled();
  });
});

describe('AgentSession — PR body validation', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
    (runtimeSettings as { corporate_mode_enabled: boolean }).corporate_mode_enabled = false;
  });

  it('does NOT pause or post comment when body is valid (non-corporate)', async () => {
    const ghClient = fakeGitHubClient();
    await runPRCreationFlow(PR_JSON, ghClient);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
    expect(vi.mocked(ghClient.createIssueComment)).not.toHaveBeenCalled();
  });

  it('audit-logs pr_body_invalid_warning in non-corporate mode when body is invalid', async () => {
    const ghClient = fakeGitHubClient();
    await runPRCreationFlow(PR_JSON_INVALID_BODY, ghClient);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'pr_body_invalid_warning' }),
    );
    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
    expect(vi.mocked(ghClient.createIssueComment)).not.toHaveBeenCalled();
  });

  it('pauses and posts PR comment in corporate mode when body is invalid', async () => {
    (runtimeSettings as { corporate_mode_enabled: boolean }).corporate_mode_enabled = true;
    const ghClient = fakeGitHubClient();
    await runPRCreationFlow(PR_JSON_INVALID_BODY, ghClient);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'pr_body_invalid' }),
    );
    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      43,
      'org/repo',
      'pr_body_invalid',
    );
    expect(vi.mocked(ghClient.createIssueComment)).toHaveBeenCalledWith(
      'org/repo',
      43,
      expect.stringContaining('PR body validation failed'),
    );
  });
});
