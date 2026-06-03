import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SessionAuditor } from './SessionAuditor';
import type { AuditableSession, ISessionManager } from './SessionAuditor';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend';
import type { GitHubClient } from '../github/GitHubClient';
import type { PullRequest } from '../github/types';
import type { WorktreeEscapeViolation } from '../db/types';

vi.mock('../db/queries', () => ({
  getPRByNotionTaskId: vi.fn(() => null),
  getPRBySessionId: vi.fn(() => null),
  setPauseReason: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  getDenialsBySession: vi.fn(() => []),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(
  overrides: Partial<AuditableSession> = {},
): AuditableSession {
  return {
    sessionId: 'test-session-id',
    taskId: 'task-abc123',
    prUrl: 'https://github.com/owner/repo/pull/42',
    sessionType: 'standard',
    worktreePath: null,
    ...overrides,
  };
}

function makeToolUseEvent(
  toolName: string,
  input: Record<string, unknown>,
  toolUseId?: string,
) {
  return {
    id: 1,
    session_id: 'test-session-id',
    event_type: 'text' as const,
    payload: JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
      },
    }),
    timestamp: Date.now(),
    message_id: null,
  };
}

function makeNotionClient(filesSection = ''): TaskTrackerBackend {
  const body = [
    '# Add post-session audit hook',
    '## Summary\nSummary text',
    '## Context\nContext text',
    '## Acceptance Criteria\nAC text',
    filesSection ? `## Files\n${filesSection}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    type: 'notion' as const,
    fetchTaskPage: vi.fn(async () => body),
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  } as unknown as TaskTrackerBackend;
}

function makeGitHubClient(
  prOverrides: Partial<PullRequest> = {},
): GitHubClient {
  const defaultPR: PullRequest = {
    id: 42,
    title: 'feat: add audit hook',
    body: '## Summary\nDid things.\n\n## Test plan\n- tested',
    url: 'https://github.com/owner/repo/pull/42',
    apiUrl: 'https://api.github.com/repos/owner/repo/pulls/42',
    headBranch: 'feature/audit',
    baseBranch: 'dev',
    state: 'open',
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    mergeableState: 'clean',
    draft: false,
  };
  return {
    fetchPR: vi.fn(async () => ({ ...defaultPR, ...prOverrides })),
    fetchDiff: vi.fn(async () => ({
      prId: 42,
      diff: '',
      filesChanged: ['packages/backend/src/session/SessionAuditor.ts'],
    })),
  } as unknown as GitHubClient;
}

function makeSessionManager(isAlive = true): ISessionManager {
  return {
    send: vi.fn(),
    isAlive: vi.fn().mockReturnValue(isAlive),
  };
}

// ── Import mocked module for DB fallback / event tests ───────────────────────
import * as queries from '../db/queries';
import type { PullRequestRow, PermissionDenialRow } from '../db/types';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionAuditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue(null);
    vi.mocked(queries.getPRBySessionId).mockReturnValue(null);
  });

  // ── AC: Clean exit without PR ─────────────────────────────────────────────
  it('returns "Clean exit but no PR opened" when exitCode is 0 and prUrl is null', async () => {
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({ prUrl: undefined });
    const audit = await auditor.audit(session, 0);

    expect(audit.prOpened).toBe(false);
    expect(audit.violations).toContain('Clean exit but no PR opened');
  });

  it('does NOT flag "Clean exit but no PR opened" when exitCode is non-zero', async () => {
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({ prUrl: undefined });
    const audit = await auditor.audit(session, 1);

    expect(audit.violations).not.toContain('Clean exit but no PR opened');
  });

  // ── AC: PR targets wrong branch ───────────────────────────────────────────
  it('returns "PR targets main instead of dev" when baseBranch is main', async () => {
    const github = makeGitHubClient({ baseBranch: 'main' });
    const auditor = new SessionAuditor(makeNotionClient(), github, undefined);
    const session = makeSession();
    const audit = await auditor.audit(session, 0);

    expect(audit.prTargetsBranch).toBe('main');
    expect(audit.violations).toContain('PR targets main instead of dev');
  });

  it('does NOT flag branch violation when baseBranch is dev', async () => {
    const github = makeGitHubClient({ baseBranch: 'dev' });
    const auditor = new SessionAuditor(makeNotionClient(), github, undefined);
    const session = makeSession();
    const audit = await auditor.audit(session, 0);

    expect(audit.violations).not.toContain('PR targets dev instead of dev');
    const branchViolation = audit.violations.find((v) =>
      v.startsWith('PR targets'),
    );
    expect(branchViolation).toBeUndefined();
  });

  // ── AC: Spec mismatch — files in diff not in spec ────────────────────────
  it('flags files in the diff that are not listed in the task spec', async () => {
    const notion = makeNotionClient(
      'packages/backend/src/session/SessionAuditor.ts',
    );
    const github = makeGitHubClient();
    vi.mocked(github.fetchDiff).mockResolvedValue({
      prId: 42,
      diff: '',
      filesChanged: [
        'packages/backend/src/session/SessionAuditor.ts',
        'packages/frontend/src/SomeUnexpected.tsx',
      ],
    });

    const auditor = new SessionAuditor(notion, github, undefined);
    const session = makeSession();
    const audit = await auditor.audit(session, 0);

    const unexpectedViolation = audit.violations.find((v) =>
      v.includes('PR modifies files not listed in task spec'),
    );
    expect(unexpectedViolation).toBeDefined();
    expect(unexpectedViolation).toContain('SomeUnexpected.tsx');
  });

  // ── AC: routeFailuresToSession sends violations as follow-up message ─────
  it('routeFailuresToSession sends violations as a follow-up message to the session', async () => {
    const github = makeGitHubClient({ baseBranch: 'main' }); // will produce a violation
    const sm = makeSessionManager();
    const auditor = new SessionAuditor(makeNotionClient(), github, sm);
    const session = makeSession();
    await auditor.audit(session, 0);

    expect(sm.send).toHaveBeenCalledOnce();
    const [calledSessionId, message] = vi.mocked(sm.send).mock.calls[0];
    expect(calledSessionId).toBe('test-session-id');
    expect(message).toContain('❌');
    expect(message).toContain('Audit findings for your PR:');
  });

  it('does NOT call send when there are no violations', async () => {
    const github = makeGitHubClient(); // baseBranch: dev, good title, good body
    const sm = makeSessionManager();
    // No files section — spec comparison returns null
    const auditor = new SessionAuditor(makeNotionClient(''), github, sm);
    const session = makeSession();
    await auditor.audit(session, 0);

    expect(sm.send).not.toHaveBeenCalled();
  });

  // ── AC: routeFailuresToSession does not throw if live session send() throws ─
  it('routeFailuresToSession does not throw when send() throws on a live session', async () => {
    const github = makeGitHubClient({ baseBranch: 'main' }); // produces a violation
    const sm = makeSessionManager(true); // alive
    vi.mocked(sm.send).mockImplementation(() => {
      throw new Error('Session exited');
    });

    const auditor = new SessionAuditor(makeNotionClient(), github, sm);
    const session = makeSession();
    // Should not throw
    await expect(auditor.audit(session, 0)).resolves.toBeDefined();
  });

  // ── AC: concluded session → attention queue ───────────────────────────────
  it('escalates to attention queue (setPauseReason) when session is not alive and PR exists', async () => {
    const github = makeGitHubClient({ baseBranch: 'main' }); // produces a violation
    const sm = makeSessionManager(false); // not alive
    const prRow: Partial<PullRequestRow> = {
      pr_number: 42,
      repo: 'owner/repo',
    };
    vi.mocked(queries.getPRBySessionId).mockReturnValue(
      prRow as PullRequestRow,
    );

    const auditor = new SessionAuditor(makeNotionClient(), github, sm);
    const session = makeSession();
    await auditor.audit(session, 0);

    expect(sm.send).not.toHaveBeenCalled();
    expect(queries.setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'audit_findings',
    );
  });

  it('does NOT call send() when session is not alive', async () => {
    const github = makeGitHubClient({ baseBranch: 'main' }); // produces a violation
    const sm = makeSessionManager(false); // not alive
    vi.mocked(queries.getPRBySessionId).mockReturnValue(null);

    const auditor = new SessionAuditor(makeNotionClient(), github, sm);
    const session = makeSession();
    await auditor.audit(session, 0);

    expect(sm.send).not.toHaveBeenCalled();
  });

  it('does not crash when session is not alive and no PR is found', async () => {
    const github = makeGitHubClient({ baseBranch: 'main' }); // produces a violation
    const sm = makeSessionManager(false); // not alive
    vi.mocked(queries.getPRBySessionId).mockReturnValue(null);

    const auditor = new SessionAuditor(makeNotionClient(), github, sm);
    const session = makeSession();
    await expect(auditor.audit(session, 0)).resolves.toBeDefined();
    expect(queries.setPauseReason).not.toHaveBeenCalled();
  });

  it('sends message normally to a live session with violations', async () => {
    const github = makeGitHubClient({ baseBranch: 'main' }); // produces a violation
    const sm = makeSessionManager(true); // alive

    const auditor = new SessionAuditor(makeNotionClient(), github, sm);
    const session = makeSession();
    await auditor.audit(session, 0);

    expect(sm.send).toHaveBeenCalledOnce();
    expect(queries.setPauseReason).not.toHaveBeenCalled();
  });

  // ── AC: Audit skips review sessions ──────────────────────────────────────
  // (This is enforced in AgentSession, but the auditor itself has no restriction.
  //  We verify the AgentSession-level guard by testing that review sessions are
  //  explicitly excluded in the integration, and here we confirm audit() can be
  //  called with a review session without crashing.)
  it('audit() runs without error for a review-type session', async () => {
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({ sessionType: 'review', prUrl: undefined });
    const audit = await auditor.audit(session, 0);
    expect(audit).toBeDefined();
  });

  // ── AC: GitHub API failure does not throw ─────────────────────────────────
  it('is non-blocking: GitHub API failure does not throw and skips PR checks', async () => {
    const github = makeGitHubClient();
    vi.mocked(github.fetchPR).mockRejectedValue(new Error('GitHub API 500'));

    const auditor = new SessionAuditor(makeNotionClient(), github, undefined);
    const session = makeSession();

    const audit = await auditor.audit(session, 0);
    expect(audit).toBeDefined();
    // PR checks skipped — no branch/title/body violations from GitHub
    const ghViolations = audit.violations.filter(
      (v) =>
        v.includes('PR targets') ||
        v.includes('PR title') ||
        v.includes('PR body'),
    );
    expect(ghViolations).toHaveLength(0);
  });

  // ── AC: DB fallback — pr_url null but pull_requests table has a PR ─────────
  it('does NOT flag "no PR opened" when getPRByNotionTaskId returns a row (DB fallback)', async () => {
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue({
      id: 1,
      pr_number: 10,
      pr_url: 'https://github.com/owner/repo/pull/10',
      task_id: 'notion:task-abc123',
      session_id: 'original-session',
      repo: 'owner/repo',
      title: 'feat: something',
      body: null,
      head_branch: 'feature/something',
      base_branch: 'dev',
    } as any);

    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({ prUrl: undefined });
    const audit = await auditor.audit(session, 0);

    expect(audit.prOpened).toBe(true);
    expect(audit.violations).not.toContain('Clean exit but no PR opened');
  });

  it('still flags "no PR opened" when both prUrl is null and getPRByNotionTaskId returns null', async () => {
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue(null);

    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({ prUrl: undefined });
    const audit = await auditor.audit(session, 0);

    expect(audit.prOpened).toBe(false);
    expect(audit.violations).toContain('Clean exit but no PR opened');
  });

  it('does NOT call getPRByNotionTaskId when prUrl is already set', async () => {
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue(null);

    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({
      prUrl: 'https://github.com/owner/repo/pull/42',
    });
    await auditor.audit(session, 0);

    expect(queries.getPRByNotionTaskId).not.toHaveBeenCalled();
  });

  // ── AC: sessionManager is optional — no crash when not provided ───────────
  it('works without a sessionManager when violations exist', async () => {
    const github = makeGitHubClient({ baseBranch: 'main' });
    const auditor = new SessionAuditor(makeNotionClient(), github, undefined);
    const session = makeSession();
    const audit = await auditor.audit(session, 0);
    expect(audit.violations.length).toBeGreaterThan(0);
  });
});

// ── auditWorktreeEscape ────────────────────────────────────────────────────────

describe('auditWorktreeEscape', () => {
  const WORKTREE =
    'C:\\Users\\phadek\\IdeaProjects\\project\\.claude\\worktrees\\abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue(null);
    vi.mocked(queries.getEventsBySession).mockReturnValue([]);
    vi.mocked(queries.getDenialsBySession).mockReturnValue([]);
  });

  it('Write inside worktree produces no violation', async () => {
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Write', {
        file_path: `${WORKTREE}\\packages\\backend\\src\\file.ts`,
        content: '',
      }),
    ]);
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const violations = await auditor.auditWorktreeEscape(
      'test-session-id',
      WORKTREE,
    );
    expect(violations).toHaveLength(0);
  });

  it('Write outside worktree produces a worktree_escape violation', async () => {
    const outsidePath = 'C:\\Users\\phadek\\IdeaProjects\\project\\outside.db';
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Write', { file_path: outsidePath, content: '' }),
    ]);
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const violations = await auditor.auditWorktreeEscape(
      'test-session-id',
      WORKTREE,
    );
    expect(violations).toHaveLength(1);
    const v = violations[0] as WorktreeEscapeViolation;
    expect(v.type).toBe('worktree_escape');
    expect(v.tool).toBe('Write');
    expect(v.path).toBe(outsidePath);
    expect(v.escapedTo).toBeTruthy();
  });

  it('Bash redirect to absolute path outside worktree produces a violation', async () => {
    const outsidePath = 'C:\\Users\\phadek\\IdeaProjects\\project\\data.db';
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Bash', { command: `echo hello > ${outsidePath}` }),
    ]);
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const violations = await auditor.auditWorktreeEscape(
      'test-session-id',
      WORKTREE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe('worktree_escape');
    expect(violations[0].tool).toBe('Bash');
  });

  it('Bash with no absolute path produces no violation', async () => {
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Bash', { command: 'npx tsc --noEmit' }),
    ]);
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const violations = await auditor.auditWorktreeEscape(
      'test-session-id',
      WORKTREE,
    );
    expect(violations).toHaveLength(0);
  });

  it('Git-Bash path /c/... outside worktree resolves correctly', async () => {
    // /c/Users/phadek/... is outside WORKTREE (which is deep under project)
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Write', {
        file_path: '/c/Users/phadek/IdeaProjects/project/outside.db',
        content: '',
      }),
    ]);
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const violations = await auditor.auditWorktreeEscape(
      'test-session-id',
      WORKTREE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe('worktree_escape');
    // escapedTo should be the Windows-normalized form
    expect(violations[0].escapedTo).toMatch(/^C:\\Users\\phadek/i);
  });

  it('Windows-style path inside worktree produces no violation', async () => {
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Write', {
        file_path: `${WORKTREE}\\src\\index.ts`,
        content: '',
      }),
    ]);
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const violations = await auditor.auditWorktreeEscape(
      'test-session-id',
      WORKTREE,
    );
    expect(violations).toHaveLength(0);
  });

  it('worktree_escape violations are included in audit violations array', async () => {
    const outsidePath = 'C:\\Users\\phadek\\IdeaProjects\\project\\data.db';
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Write', { file_path: outsidePath, content: '' }),
    ]);
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const session = makeSession({
      prUrl: undefined,
      worktreePath: WORKTREE,
    });
    const audit = await auditor.audit(session, 1);
    const escapes = audit.violations.filter(
      (v): v is WorktreeEscapeViolation =>
        typeof v === 'object' && v.type === 'worktree_escape',
    );
    expect(escapes).toHaveLength(1);
    expect(escapes[0].tool).toBe('Write');
  });

  it('tool_use blocks embedded in text (assistant) events are detected', async () => {
    const outsidePath = 'C:\\Users\\phadek\\outside.ts';
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'test-session-id',
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Write',
                input: { file_path: outsidePath, content: '' },
              },
            ],
          },
        }),
        timestamp: Date.now(),
        message_id: null,
      },
    ]);
    const auditor = new SessionAuditor(
      makeNotionClient(),
      undefined,
      undefined,
    );
    const violations = await auditor.auditWorktreeEscape(
      'test-session-id',
      WORKTREE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].type).toBe('worktree_escape');
  });

  // ── AC: Denied tool call is not audited ──────────────────────────────────
  it('denied Write to outside path is not flagged (correlated via tool_use_id)', async () => {
    const outsidePath = 'C:\\Users\\phadek\\IdeaProjects\\project\\outside.db';
    const TOOL_USE_ID = 'tool-use-denied-abc';
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Write', { file_path: outsidePath, content: '' }, TOOL_USE_ID),
    ]);
    vi.mocked(queries.getDenialsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'test-session-id',
        tool_name: 'Write',
        tool_use_id: TOOL_USE_ID,
        tool_input: JSON.stringify({ file_path: outsidePath }),
        timestamp: Date.now(),
      } as PermissionDenialRow,
    ]);
    const auditor = new SessionAuditor(makeNotionClient(), undefined, undefined);
    const violations = await auditor.auditWorktreeEscape('test-session-id', WORKTREE);
    expect(violations).toHaveLength(0);
  });

  it('executed Write to outside path is still flagged even when other calls were denied', async () => {
    const outsidePath = 'C:\\Users\\phadek\\IdeaProjects\\project\\outside.db';
    const EXECUTED_ID = 'tool-use-executed';
    const DENIED_ID = 'tool-use-denied';
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Write', { file_path: outsidePath, content: '' }, EXECUTED_ID),
    ]);
    vi.mocked(queries.getDenialsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'test-session-id',
        tool_name: 'Bash',
        tool_use_id: DENIED_ID,
        tool_input: JSON.stringify({ command: 'echo hi' }),
        timestamp: Date.now(),
      } as PermissionDenialRow,
    ]);
    const auditor = new SessionAuditor(makeNotionClient(), undefined, undefined);
    const violations = await auditor.auditWorktreeEscape('test-session-id', WORKTREE);
    expect(violations).toHaveLength(1);
    expect(violations[0].tool).toBe('Write');
  });

  // ── AC: Notion URL in Bash produces no escape ─────────────────────────────
  it('Bash command containing a Notion URL produces zero worktree_escape paths', async () => {
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Bash', {
        command:
          'gh pr create --body "## Notion Task\nhttps://app.notion.com/p/Fix-worktree-escape-detector-false-positives-37422f9152f3810294ffdbf042648e8c"',
      }),
    ]);
    const auditor = new SessionAuditor(makeNotionClient(), undefined, undefined);
    const violations = await auditor.auditWorktreeEscape('test-session-id', WORKTREE);
    expect(violations).toHaveLength(0);
  });

  // ── AC: Path mentions (non-writes) are not flagged ────────────────────────
  it('Bash command that only mentions an outside path (not a write) produces no violation', async () => {
    const outsidePath = 'C:\\Users\\phadek\\IdeaProjects\\project\\data.db';
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Bash', { command: `uv run script.py ${outsidePath}` }),
    ]);
    const auditor = new SessionAuditor(makeNotionClient(), undefined, undefined);
    const violations = await auditor.auditWorktreeEscape('test-session-id', WORKTREE);
    expect(violations).toHaveLength(0);
  });

  it('Bash redirect to inside-worktree path produces no violation', async () => {
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      makeToolUseEvent('Bash', {
        command: `echo hello > ${WORKTREE}\\output.txt`,
      }),
    ]);
    const auditor = new SessionAuditor(makeNotionClient(), undefined, undefined);
    const violations = await auditor.auditWorktreeEscape('test-session-id', WORKTREE);
    expect(violations).toHaveLength(0);
  });
});

// ── Windows path normalization — false-positive fix ──────────────────────────
// The Claude CLI on Windows reports file_path in Unix drive-rootless form
// (/Users/phadek/...) while worktree_path is stored Windows-native (C:\Users\...).
// These tests verify the fix: path.resolve(worktreePath, p) recovers the drive.

describe('auditWorktreeEscape — Windows path normalization', () => {
  const WORKTREE_WIN =
    'C:\\Users\\phadek\\IdeaProjects\\X\\.claude\\worktrees\\test-id';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue(null);
    vi.mocked(queries.getEventsBySession).mockReturnValue([]);
    vi.mocked(queries.getDenialsBySession).mockReturnValue([]);
  });

  // Guards: path.resolve on Linux doesn't add a drive letter, so these tests
  // are inherently Windows-specific.
  const itWin = process.platform === 'win32' ? it : it.skip;

  itWin(
    'Edit with Unix-style drive-rootless path inside worktree produces no violation',
    async () => {
      vi.mocked(queries.getEventsBySession).mockReturnValue([
        makeToolUseEvent('Edit', {
          file_path:
            '/Users/phadek/IdeaProjects/X/.claude/worktrees/test-id/file.ts',
          old_string: 'a',
          new_string: 'b',
        }),
      ]);
      const auditor = new SessionAuditor(
        makeNotionClient(),
        undefined,
        undefined,
      );
      const violations = await auditor.auditWorktreeEscape(
        'test-session-id',
        WORKTREE_WIN,
      );
      expect(violations).toHaveLength(0);
    },
  );

  itWin(
    'Edit with Unix-style drive-rootless path outside worktree produces a violation',
    async () => {
      vi.mocked(queries.getEventsBySession).mockReturnValue([
        makeToolUseEvent('Edit', {
          file_path: '/Users/phadek/Documents/elsewhere.txt',
          old_string: 'a',
          new_string: 'b',
        }),
      ]);
      const auditor = new SessionAuditor(
        makeNotionClient(),
        undefined,
        undefined,
      );
      const violations = await auditor.auditWorktreeEscape(
        'test-session-id',
        WORKTREE_WIN,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('worktree_escape');
      expect(violations[0].tool).toBe('Edit');
    },
  );

  itWin(
    'Write with Git-Bash path inside worktree produces no violation (regression)',
    async () => {
      vi.mocked(queries.getEventsBySession).mockReturnValue([
        makeToolUseEvent('Write', {
          file_path:
            '/c/Users/phadek/IdeaProjects/X/.claude/worktrees/test-id/file.ts',
          content: '',
        }),
      ]);
      const auditor = new SessionAuditor(
        makeNotionClient(),
        undefined,
        undefined,
      );
      const violations = await auditor.auditWorktreeEscape(
        'test-session-id',
        WORKTREE_WIN,
      );
      expect(violations).toHaveLength(0);
    },
  );

  itWin(
    'Bash with Windows-native path inside worktree produces no violation (regression)',
    async () => {
      vi.mocked(queries.getEventsBySession).mockReturnValue([
        makeToolUseEvent('Bash', {
          command: `npx tsc ${WORKTREE_WIN}\\packages\\backend\\src\\db\\types.ts`,
        }),
      ]);
      const auditor = new SessionAuditor(
        makeNotionClient(),
        undefined,
        undefined,
      );
      const violations = await auditor.auditWorktreeEscape(
        'test-session-id',
        WORKTREE_WIN,
      );
      expect(violations).toHaveLength(0);
    },
  );

  itWin(
    'Bash redirect to Windows-native absolute path outside worktree produces a violation',
    async () => {
      vi.mocked(queries.getEventsBySession).mockReturnValue([
        makeToolUseEvent('Bash', {
          command: 'echo hello > C:\\Users\\phadek\\outside\\script.txt',
        }),
      ]);
      const auditor = new SessionAuditor(
        makeNotionClient(),
        undefined,
        undefined,
      );
      const violations = await auditor.auditWorktreeEscape(
        'test-session-id',
        WORKTREE_WIN,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('worktree_escape');
      expect(violations[0].tool).toBe('Bash');
    },
  );

  itWin(
    'relative file_path is resolved against worktree and produces no violation when inside',
    async () => {
      vi.mocked(queries.getEventsBySession).mockReturnValue([
        makeToolUseEvent('Edit', {
          file_path: 'packages/backend/src/db/types.ts',
          old_string: 'a',
          new_string: 'b',
        }),
      ]);
      const auditor = new SessionAuditor(
        makeNotionClient(),
        undefined,
        undefined,
      );
      const violations = await auditor.auditWorktreeEscape(
        'test-session-id',
        WORKTREE_WIN,
      );
      expect(violations).toHaveLength(0);
    },
  );
});

// ── runMigrations() — session_audits table ───────────────────────────────────

describe('runMigrations() — session_audits table', () => {
  it('creates session_audits table with CREATE TABLE IF NOT EXISTS (idempotent)', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS session_audits/);
  });

  it('session_audits table has required columns', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toMatch(/session_id\s+TEXT NOT NULL/);
    expect(source).toMatch(/pr_opened\s+INTEGER NOT NULL/);
    expect(source).toMatch(/violations\s+TEXT NOT NULL/);
    expect(source).toMatch(/audited_at\s+TEXT NOT NULL/);
  });
});
