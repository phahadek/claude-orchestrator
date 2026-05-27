# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Fix Windows path normalization false-positive in worktree-escape audit
- **Notion task**: https://www.notion.so/Fix-Windows-path-normalization-false-positive-in-worktree-escape-audit-36d22f9152f381ce8982d885133aed68
- **Project context**: https://www.notion.so/33222f9152f38188b65fd912e40890a2

---

## Lifecycle

Follow these steps in order — every session:

> **Task spec is pre-loaded below.** Do NOT fetch Notion pages — the task content has
> already been injected by the orchestrator. Proceed directly to implementation.

1. Read the **Task Spec** section below — it contains the full task specification.
2. Create your task branch from the current HEAD: `git checkout -b feature/<task-name>`.
3. Implement the task per the acceptance criteria.
4. Pass the pre-PR gate (see Pre-PR Gate section below).
5. Open a draft PR targeting `dev` using the required body template.
6. **Stop and wait.** The dashboard sends review feedback as follow-up messages.
   Address findings by pushing additional commits, then wait again.

---

## Status Ownership

**Do NOT update Notion task status.**
**Do NOT call any Notion API to change task status.**
The orchestrator backend handles all status transitions (In Progress → In Review → Done).

---

## Efficiency Rules

This session runs in `--print` mode with no human watching the output.
Optimize for speed and token efficiency:

- **Do NOT use TodoWrite.** No one sees the todo list. Track your progress internally.
- **Do NOT use Agent subagents for exploration.** Use Glob and Grep directly.
- **Minimize tool calls.** Batch independent reads. Don't re-read files you already read.
- **Keep commit messages and PR descriptions concise.** One sentence summaries, not essays.

---

## PR Format Standards

- **Title**: `feat: <task-name>` — no scope prefix like `(backend)`, no milestone tags.
- **How to create the PR**: Use the `mcp__github__create_pull_request` MCP tool.
  Do NOT use `gh pr create` — the `gh` CLI is not on PATH.
  Pass `draft: true`, `base: "dev"`, and the full body as the `body` parameter.
- **Required body sections** (no omissions, no reordering):

```
## Summary
<1-3 sentences: what changed and why>

## Notion Task
<link to the Notion task page>

## Automated Tests
<list tests added/modified, or "No test changes">

## Files Changed
<bulleted list of files with brief description of each change>
```

---

## Branch Rules

- Branch name: `feature/<task-name>` — created from the worktree's current HEAD
- Never commit directly to `dev` or `main`
- Never merge your own PR
- One task per session — no scope creep

---

## Commit Attribution

Every commit **must** include the following trailer (replace `<model>` and `<session-id>` with your actual model ID and session ID):

```
AI-Authored-By: <model> (session: <session-id>)
```

Example: `AI-Authored-By: claude-sonnet-4-6 (session: f98ff4ec)`

The backend verifies this trailer server-side. In corporate mode, missing trailers pause the task.

---

## Pre-PR Gate

Run in order — all must pass before opening the PR:

1. Stash CLAUDE.md before rebasing: `git stash push CLAUDE.md`
2. Rebase onto `dev` and resolve any conflicts.
3. Restore CLAUDE.md: `git stash pop`
4. `npx tsc --noEmit -p packages/frontend/tsconfig.json` — must pass.
5. `npx tsc --noEmit -p packages/backend/tsconfig.json` — must pass.
6. `npm run build` — must pass.
7. Stage only your implementation files for commit — never stage `CLAUDE.md`.

---

## Forbidden Actions

- Never push directly to `main`
- Never force push (`--force`)
- Never delete branches that live outside this worktree
- Never run `git reset --hard` on the main repository directory
- Never skip pre-commit hooks (`--no-verify`)
- Never stage or commit `CLAUDE.md` — it contains orchestrator-injected content that must not appear in PRs. Use `git add <specific files>` instead of `git add .`.

---

## Git Isolation

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\a35bd5f2-e296-415f-9c2d-fc1209dffd1f`.**
> This is your `cwd`. All commands run here. Never navigate to or operate on any parent directory.

- All git commands must run inside the worktree directory (your `cwd`)
- Never use `git -C <path>` pointing outside this worktree
- Never use `--work-tree` or `--git-dir` flags pointing outside this worktree
- Never run `git checkout` or `git switch` targeting a branch in the main repo directory
- The backend records the main repo branch before each session and will warn if it drifts

---

## Filesystem Isolation (Personal Mode)

> ⚠️ **Personal mode has no structural sandbox** — there is no docker, chroot, or
> namespace to prevent writes outside the worktree. All isolation is prompt-level.
> Violating these rules can corrupt the developer's live environment.

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\a35bd5f2-e296-415f-9c2d-fc1209dffd1f`).

- **Never write to the project root or any path above the worktree.**
  Scripts, tools, and generated outputs must target paths under the worktree, not the parent repo.
- **Dev state (SQLite databases, log files, generated artifacts) must use worktree-relative paths.**
  Do not reference absolute paths to project-root databases or output files.
  Use paths like `<worktree>/.dev-state/<file>` or resolve paths relative to `cwd`.
- **Before running any script that writes files or opens a database, verify the target path is inside the worktree.**
  If a script hardcodes an absolute project-root path, patch it to accept an env var or relative path before executing.

---

## Bash Rules (Permission System)

Your Bash commands are authorized by prefix matching on the **first token**.
Violating these rules causes **silent denial** — the command fails with no error message.

**Rule 1 — One command per Bash call.**
Never chain with `&&`, `;`, or `||`. Split into separate Bash calls.

**Rule 2 — Never prefix with `cd path &&`.**
You are already in the worktree directory. Just run the command directly.

**Rule 3 — No heredoc subshells in git commit.**
`git commit -m "$(cat <<'EOF'...)"` is denied. Use a simple `-m "message"` instead.
For multiline commit messages, use `git commit -F <file>` and write the file with the Write tool first.

**Rule 4 — Do not write to `/tmp/` or paths outside the worktree.**
Use the Write tool for any file creation. Never use `cat >`, `printf >`, or `echo >` redirects.

**Rule 5 — Use `npx` instead of bare tool names.**
`tsc` → `npx tsc`. Bare commands may not be on PATH.

---

## Task Spec

> This is the full task specification, pre-fetched by the orchestrator.
> Do NOT re-fetch this from Notion — use the content below as your source of truth.

## Summary
The post-hoc auditWorktreeEscape in SessionAuditor.ts produces false-positive worktree_escape violations on every Windows session, because the Claude CLI reports tool-call file paths in Unix-style drive-rootless form (/Users/phadek/...) while the session's worktree_path is stored Windows-native (C:\Users\phadek\...). The audit's normalizePath falls back to path.normalize(), which does not add a drive letter on Windows, so the prefix comparison fails. Switch to path.resolve(baseDir, p) so drive-rootless absolute paths inherit the base directory's drive.
## Dependencies
None. Localized fix in SessionAuditor.ts and its tests.
## Context
### Root cause (confirmed against PR #399's session)
PR #399 session 632536ef-9992-4a07-b2cc-54960f744e6f ran on a Windows host. Every Edit/Write tool call recorded a file_path in Unix-style form — e.g.:
```javascript
/Users/phadek/IdeaProjects/claude-orchestrator/.claude/worktrees/632536ef-.../packages/backend/src/db/types.ts
```
But the session row's worktree_path (stored when the worktree was created) is Windows-native:
```javascript
C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\632536ef-...
```
SessionAuditor.ts:372-379 normalizePath handles only Git-Bash /c/foo style (single-letter drive after the leading slash):
```typescript
function normalizePath(p: string): string {
  const gitBashMatch = /^\/([a-zA-Z])\//i.exec(p);
  if (gitBashMatch) {
    return path.normalize(`${gitBashMatch[1].toUpperCase()}:\\${p.slice(3)}`);
  }
  return path.normalize(p);
}
```
/Users/phadek/... does not match the Git-Bash pattern (the segment after the first / is Users, not a single letter). It falls through to path.normalize(p), which on Windows returns \Users\phadek\... (no drive letter). The prefix comparison in auditWorktreeEscape:
```typescript
resolved !== normalizedWorktree && !resolved.startsWith(worktreePrefix)
```
fails because \Users\phadek\... does not start with C:\Users\phadek\.... Every file the session edits inside its own worktree is reported as a worktree_escape violation, and the formatted feedback is routed back to the session at end-of-session.
### Why path.resolve(baseDir, p) is the right primitive
Verified empirically:
```javascript
path.normalize('/Users/phadek/...')                    → \Users\phadek\...           (no drive)
path.resolve('/Users/phadek/...')                      → C:\Users\phadek\...        (cwd's drive)
path.resolve(worktree, '/Users/phadek/...')            → C:\Users\phadek\...        (worktree's drive)
path.resolve(worktree, 'C:\\Users\\phadek\\X')          → C:\Users\phadek\X           (absolute wins)
path.resolve(worktree, 'C:\\Other\\X')                  → C:\Other\X                  (different absolute path stays)
```
Passing the session's worktree_path as the base makes the normalization robust even when the backend's process.cwd() is on a different drive from the session worktree.
The Git-Bash conversion must still happen before path.resolve — otherwise path.resolve(worktree, '/c/Users/...') would produce C:\c\Users\... (literal \c\ segment, wrong).
### What changes
packages/backend/src/session/SessionAuditor.ts:372-379 — update normalizePath to take an optional baseDir and resolve against it:
```typescript
function normalizePath(p: string, baseDir?: string): string {
  // Git-Bash /c/foo → C:\foo. Must precede path.resolve, which would otherwise
  // mangle the single-letter drive segment.
  const gitBashMatch = /^\/([a-zA-Z])\//i.exec(p);
  if (gitBashMatch) {
    p = `${gitBashMatch[1].toUpperCase()}:\\${p.slice(3)}`;
  }
  return baseDir ? path.resolve(baseDir, p) : path.normalize(p);
}
```
SessionAuditor.ts:175,185 — pass worktreePath to both normalizePath calls in auditWorktreeEscape:
```typescript
const normalizedWorktree = normalizePath(worktreePath);  // unchanged — baseDir not needed here
// ...
const resolved = normalizePath(p, worktreePath);          // new — supply the base
```
The worktree path is itself canonical (absolute, drive-prefixed), so passing or omitting baseDir for the first call is equivalent.
### Out of scope
- The session's own routed feedback now correctly excludes these false positives, but past session_audits rows are not retroactively cleaned (purely informational).
- The extractAbsolutePathsFromCommand Bash regexes (SessionAuditor.ts:355-365) are unchanged — they already capture C:\foo, C:/foo, and /c/foo correctly; the bug is purely in normalization.
## Acceptance criteria
### 🤖 Automated tests
- Unit test: Edit tool with file_path = '/Users/phadek/IdeaProjects/X/.claude/worktrees/<id>/file.ts' and worktree 'C:\\Users\\phadek\\IdeaProjects\\X\\.claude\\worktrees\\<id>' produces no violation
- Unit test: Edit tool with file_path = '/Users/phadek/Documents/elsewhere.txt' and the same worktree produces a violation (the path really is outside the worktree)
- Unit test: Write tool with Git-Bash file_path = '/c/Users/phadek/IdeaProjects/X/.claude/worktrees/<id>/file.ts' continues to pass (no regression on the existing Git-Bash case)
- Unit test: Bash command containing C:\\Users\\phadek\\IdeaProjects\\X\\.claude\\worktrees\\<id>\\file.ts continues to pass (no regression on Windows-native case)
- Unit test: Bash command containing an absolute path outside the worktree still produces a violation
- Unit test: relative file_path (e.g. 'packages/backend/src/db/types.ts') is resolved against the worktree base and produces no violation when the resolved path is inside the worktree
- tsc --noEmit passes for both packages
- Existing SessionAuditor.test.ts cases continue to pass
## Files / paths affected
- packages/backend/src/session/SessionAuditor.ts (update — normalizePath signature + the two callers in auditWorktreeEscape)
- packages/backend/src/session/SessionAuditor.test.ts (update — add the cases above)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/session/SessionAuditor.ts`
```
import path from 'path';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { parseSection } from '../notion/NotionClient';
import type { GitHubClient } from '../github/GitHubClient';
import { getPRByNotionTaskId, getEventsBySession } from '../db/queries';
import type { WorktreeEscapeViolation, SessionEvent } from '../db/types';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface SessionAudit {
  sessionId: string;
  prOpened: boolean;
  prTargetsBranch: string | null;
  taskStatusAfter: string | null;
  violations: (string | WorktreeEscapeViolation)[];
  specMismatch: string | null;
  auditedAt: string;
}

/** Minimal interface used to route audit failures back to a live session. */
export interface ISessionManager {
  send(sessionId: string, message: string): void;
}

/** Minimal session shape needed by the auditor — avoids a circular import. */
export interface AuditableSession {
  sessionId: string;
  taskId: string;
  prUrl: string | undefined;
  sessionType: string;
  worktreePath: string | null;
}

// ── SessionAuditor ───────────────────────────────────────────────────────────

export class SessionAuditor {
  /**
   * The first parameter accepts either a TaskBackend (legacy injection — used by
   * tests) or a project id (string). When it is a project id, the backend is
   * resolved per-call via `getTaskBackend(projectId)`. This dual shape preserves
   * the test pattern that pre-existed the per-project routing refactor.
   */
  constructor(
    private notionClientOrProjectId: TaskBackend | string,
    private githubClient?: GitHubClient,
    private sessionManager?: ISessionManager,
  ) {}

  private resolveBackend(): TaskBackend {
    if (typeof this.notionClientOrProjectId === 'string') {
      return getTaskBackend(this.notionClientOrProjectId);
    }
    return this.notionClientOrProjectId;
  }

  /**
   * Run all post-session checks and return a SessionAudit record.
   * Non-blocking: GitHub/Notion failures are caught and skipped, not thrown.
   */
  async audit(
    session: AuditableSession,
    exitCode: number | null,
  ): Promise<SessionAudit> {
    const violations: (string | WorktreeEscapeViolation)[] = [];
    let prTargetsBranch: string | null = null;
    let specMismatch: string | null = null;

    // 1. PR opened on clean exit?
    const prOpened =
      session.prUrl != null ||
      (!!session.taskId && getPRByNotionTaskId(session.taskId) != null);
    if (exitCode === 0 && !prOpened) {
      violations.push('Clean exit but no PR opened');
    }

    if (session.prUrl && this.githubClient) {
      const prMatch = session.prUrl.match(
        /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/,
      );
      if (prMatch) {
        const repo = prMatch[1];
        const prNumber = parseInt(prMatch[2], 10);

        let pr: import('../github/types').PullRequest | null = null;
        try {
          pr = await this.githubClient.fetchPR(repo, prNumber);
        } catch (err) {
          console.warn(
            `[SessionAuditor] GitHub fetchPR failed — skipping PR checks: ${err}`,
          );
        }

        if (pr) {
          // 2. PR targets correct branch (dev)?
          prTargetsBranch = pr.baseBranch;
          if (pr.baseBranch !== 'dev') {
            violations.push(`PR targets ${pr.baseBranch} instead of dev`);
          }

          // 3. PR title format: must start with "feat: "
          if (!pr.title.startsWith('feat: ')) {
            violations.push('PR title does not match format');
          }

          // 4. PR body readable (no escaped newlines)?
          if (pr.body && pr.body.includes('\\n')) {
            violations.push('PR body contains escaped newlines');
          }

          // 5. PR body has required sections?
          const body = pr.body ?? '';
          if (!body.includes('## Summary')) {
            violations.push('PR body missing required section: ## Summary');
          }
          if (
            !body.includes('## Test plan') &&
            !body.includes('## Automated Tests')
          ) {
            violations.push('PR body missing required section: ## Test plan');
          }

          // 6. PR content matches task spec?
          specMismatch = await this.compareToSpec(
            repo,
            prNumber,
            session.taskId,
          );
          if (specMismatch) {
            violations.push(specMismatch);
          }
        }
      }
    }

    if (session.worktreePath) {
      try {
        const escapes = await this.auditWorktreeEscape(
          session.sessionId,
          session.worktreePath,
        );
        violations.push(...escapes);
      } catch (err) {
        console.warn(`[SessionAuditor] auditWorktreeEscape failed: ${err}`);
      }
    }

    const audit: SessionAudit = {
      sessionId: session.sessionId,
      prOpened,
      prTargetsBranch,
      taskStatusAfter: null,
      violations,
      specMismatch,
      auditedAt: new Date().toISOString(),
    };

    if (violations.length > 0) {
      this.routeFailuresToSession(session.sessionId, violations);
    }

    return audit;
  }

  /**
   * Scan session_events for tool calls that wrote to paths outside the worktree.
   * Checks Write/Edit tool file_path inputs and Bash command absolute paths.
   */
  async auditWorktreeEscape(
    sessionId: string,
    worktreePath: string,
  ): Promise<WorktreeEscapeViolation[]> {
    const events = getEventsBySession(sessionId);
    const violations: WorktreeEscapeViolation[] = [];
    const normalizedWorktree = normalizePath(worktreePath);
    const worktreePrefix = normalizedWorktree.endsWith(path.sep)
      ? normalizedWorktree
      : normalizedWorktree + path.sep;

    for (const event of events) {
      const blocks = extractToolUseBlocks(event);
      for (const block of blocks) {
        const paths = extractPathsFromBlock(block);
        for (const p of paths) {
          const resolved = normalizePath(p);
          if (
            resolved !== normalizedWorktree &&
            !resolved.startsWith(worktreePrefix)
          ) {
            violations.push({
              type: 'worktree_escape',
              tool: block.name,
              path: p,
              escapedTo: resolved,
            });
          }
        }
      }
    }

    return violations;
  }

  /**
   * Compare the files changed in a PR against the "Files / paths affected"
   * section of the Notion task spec. Returns a summary string if there is a
   * mismatch, or null if everything looks consistent (or if the check cannot
   * be performed).
   */
  private async compareToSpec(
    repo: string,
    prNumber: number,
    taskId: string,
  ): Promise<string | null> {
    if (!this.githubClient || !taskId) return null;

    let diffFiles: string[] = [];
    try {
      const prDiff = await this.githubClient.fetchDiff(prNumber, repo);
      diffFiles = prDiff.filesChanged;
    } catch (err) {
      console.warn(
        `[SessionAuditor] fetchDiff failed — skipping spec comparison: ${err}`,
      );
      return null;
    }

    let taskMarkdown: string | null;
    try {
      taskMarkdown = await this.resolveBackend().fetchTaskPage(taskId);
    } catch (err) {
      console.warn(
        `[SessionAuditor] fetchTaskPage failed — skipping spec comparison: ${err}`,
      );
      return null;
    }

    const filesSection = taskMarkdown
      ? parseSection(taskMarkdown, 'files')
      : '';
    if (!filesSection.trim()) return null;

    // Extract file paths from the filesSection (lines containing slashes or dots)
    const specFiles = filesSection
      .split('\n')
      .map((line) => line.replace(/^[-*\s]+/, '').trim())
      .filter((line) => line.includes('/') || line.includes('.'));

    if (specFiles.length === 0) return null;

    // Files in PR but not in spec
    const unexpected = diffFiles.filter(
      (f) => !specFiles.some((s) => f.includ
[... truncated]
```

### `packages/backend/src/session/SessionAuditor.test.ts`
```
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
  getEventsBySession: vi.fn(() => []),
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

function makeToolUseEvent(toolName: string, input: Record<string, unknown>) {
  return {
    id: 1,
    session_id: 'test-session-id',
    event_type: 'tool_use' as const,
    payload: JSON.stringify({ name: toolName, input }),
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

function makeSessionManager(): ISessionManager {
  return { send: vi.fn() };
}

// ── Import mocked module for DB fallback / event tests ───────────────────────
import * as queries from '../db/queries';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionAuditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue(null);
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

  // ── AC: routeFailuresToSession does not throw if session has exited ───────
  it('routeFailuresToSession does not throw when send() throws', async () => {
    const github = makeGitHubClient({ baseBranch: 'main' }); // produces a violation
    const sm = makeSessionManager();
    vi.mocked(sm.send).mockImplementation(() => {
      throw new Error('Session exited');
    });

    const auditor = new SessionAuditor(makeNotionClient(), github, sm);
    const session = makeSession();
    // Should not throw
    await expect(auditor.audit(session, 0)).resolves.toBeDefined();
  });

  // ── AC: Audit skips review sessions ──────────────────────────────────────
  // (This is enforced in AgentSession, but the auditor itself has no restriction.
  //  We verify the AgentSession-level guard by testing that review sessions are
  //  explicitly excluded in the in
[... truncated]
```

---

## Local Context

> Host-local context loaded from `.claude/local-context.md`.

# Local Context — host-specific configuration

This file is **gitignored**. It contains environment-specific URLs, IDs, and
references that should never be committed to the repo.

The orchestrator backend automatically appends the contents of this file to the
merged `CLAUDE.md` written into each session worktree.

---

## Project Context

- **Project Context page** (Notion): https://www.notion.so/Claude-Code-Dashboard-33222f9152f38188b65fd912e40890a2
- **Active Task Board** (Notion): https://www.notion.so/3edf1af401744a158c0e116810a8ce07

## Design & Architecture

- **Product Design Doc**: https://www.notion.so/33222f9152f381b99db7ead36cfcf057
- **Technical Architecture**: https://www.notion.so/33222f9152f3812681a3c9be7ae4270c
- **Dev Setup & Git**: https://www.notion.so/33222f9152f381098a9ffc16a8bd46cb
- **Coding Guidelines**: https://www.notion.so/33322f9152f3811ca9e7de3be99c2e06
- **Task Writing Guidelines**: https://www.notion.so/33222f9152f381738b77e8e972be7419
- **Backlog Grooming Sessions**: https://www.notion.so/33622f9152f3811d8e4de56b74fb0eb4

## Boards (per milestone)

- **M1 — MVP (Session Browser + Streaming UI)**: https://www.notion.so/cc16d2649d594a2dbc6ca7b056d095b0 — ✅ Done (2026-03-31)
- **M2 — Multi-Project & Interactive Sessions**: https://www.notion.so/4c30510be98448e49ffa6f7917650ee6 — ✅ Done (2026-04-02)
- **M2a — Orchestrator & Lifecycle Automation**: https://www.notion.so/19287f317923488b8533f02704f1396e — ✅ Done (2026-04-03)
- **M3 — Polish & Public Release**: https://www.notion.so/ca4d62a52c1a468bb23f2419dc8cc94b — 🔲 Active
- **M4 — Stabilize for Full-Auto**: https://www.notion.so/58383a0cf4424fa3a23223eebee97459 — ✅ Done (2026-05-22)
- **M5 — Privacy, Bit-rot & UX Polish**: https://www.notion.so/2932df9453ea47d7827b8c17758d77d8 — ✅ Done (2026-05-26)
- **M6 — Enterprise Adoption Readiness**: https://www.notion.so/3edf1af401744a158c0e116810a8ce07 — 🔲 Active

## Notes

- Current phase: **M6 — Enterprise Adoption Readiness**
- Filter the active task board to `💻 Code` type tasks unless instructed otherwise.