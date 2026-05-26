# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Session status stuck at 'running' after PR opens + review error path
- **Notion task**: https://www.notion.so/Session-status-stuck-at-running-after-PR-opens-review-error-path-36c22f9152f381e7b760d6f37c5c5ce1
- **Project context**: https://www.notion.so/33222f9152f38188b65fd912e40890a2

---

## Lifecycle

Follow these steps in order — every session:

> **Task spec is pre-loaded below.** Do NOT fetch Notion pages — the task content has
> already been injected by the orchestrator. Proceed directly to implementation.

1. Read the **Task Spec** section below — it contains the full task specification.
2. Create a feature branch: `feature/<task-name>` from `dev`.
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

- Branch name: `feature/<task-name>` from `dev`
- Never commit directly to `dev` or `main`
- Never merge your own PR
- One task per session — no scope creep

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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\4a8ea0a4-7972-4425-a23c-ca10bd58bb27`.**
> This is your `cwd`. All commands run here. Never navigate to or operate on any parent directory.

- All git commands must run inside the worktree directory (your `cwd`)
- Never use `git -C <path>` pointing outside this worktree
- Never use `--work-tree` or `--git-dir` flags pointing outside this worktree
- Never run `git checkout` or `git switch` targeting a branch in the main repo directory
- The backend records the main repo branch before each session and will warn if it drifts

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
When a coding session successfully opens a PR but the downstream review pipeline errors, the session's row in the sessions table stays at status='running' indefinitely (and pr_url stays null even though the PR exists in pull_requests). The session should transition to done after a clean CLI exit regardless of what the review pipeline does.
## Dependencies
None — Wave 1.
## Context
Reproduced on session 528a2baa-f810-4938-b2f1-34467ec2126a (PR #362) during the M5 gate sweep (2026-05-25):
- Session emitted a result event at 22:14:26 (the CLI's standard exit signal)
- Session log shows the final assistant text: "Draft PR opened at https://github.com/phahadek/claude-orchestrator/pull/362. Waiting for review feedback."
- PR #362 was opened successfully (visible in pull_requests table with the correct session_id linkage)
- BUT sessions.status remained 'running' and sessions.pr_url remained null
- ReviewOrchestrator's diff-fetch crashed with TypeError: fetch failed (sibling bug filed separately)
This is a state-sync bug between AgentSession's clean-exit handler and the review pipeline. Likely cause: the clean-exit path is partially or fully bypassed when the downstream pr_opened review pipeline throws, OR there's a race condition.
DB evidence:
```javascript
session_id: 528a2baa-f810-4938-b2f1-34467ec2126a
status: "running"        (expected: "done")
ended_at: null            (expected: ≈ 22:14:26 timestamp)
pr_url: null              (expected: https://github.com/phahadek/claude-orchestrator/pull/362)
```
Downstream impact: stuck 'running' sessions count against the auto-launch concurrency cap (getLiveCodeSessionCount()), starving the auto-launcher; they also clutter the dashboard's running-count.
## Fix outline
1. Audit AgentSession.handleCleanExit() in packages/backend/src/session/AgentSession.ts (~line 670-770 per the prior trace). Trace the path that runs on result event arrival:
1. Identify what bypasses the status update when the review pipeline errors. Candidates:
1. Decouple session-status update from review-pipeline notification. The session has finished executing; its lifecycle status should be terminal regardless of whether downstream review succeeds.
1. Add a recovery / backfill for already-stuck sessions: on backend startup, look for sessions with status='running' whose last event is a result type and bump them to done (write ended_at from the event timestamp).
## Acceptance criteria
### 🤖 Automated tests
When a session emits result and successfully opens a PR, sessions.status transitions to 'done', sessions.ended_at is populated, and sessions.pr_url is set — even if the downstream review pipeline throws an error
When a session emits result without opening a PR, sessions.status still transitions to 'done'
On backend startup, sessions with status='running' whose latest event is result are backfilled to 'done' (with ended_at from the event timestamp)
Existing clean-exit behavior preserved when review pipeline succeeds (regression)
### 👁️ Manual verification
Re-launch a session that previously got stuck → after PR opens, dashboard correctly transitions to "Done" within ~1s of the CLI's result event
Restart the backend with at least one known-stuck session in the DB → startup backfill bumps it to 'done' cleanly
## Files / paths affected
- packages/backend/src/session/AgentSession.ts (update — decouple status update from review-pipeline notification)
- packages/backend/src/db/queries.ts (possibly update — add backfill helper)
- packages/backend/src/session/SessionManager.ts (possibly update — invoke backfill on startup)
- packages/backend/src/__tests__/AgentSession.test.ts (update — add coverage for clean-exit + review-error race)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/session/AgentSession.ts`
```
import { EventEmitter } from 'events';
import { ALLOWED_TOOLS, runtimeSettings } from '../config';
import {
  upsertSessionEvent,
  updateSessionStatus,
  getEventsBySession,
  insertPermissionDenial,
  upsertPullRequest,
  incrementTokens,
  insertSessionAudit,
  setSessionModel,
  setSessionMetadata,
  getPRBySessionId,
  getPRByNumber,
  setHeadSha,
  setPauseReason,
  getProjectRowById,
  insertLocalBranch,
} from '../db/queries';
import {
  getCurrentBranch,
  hasNonEmptyDiff,
} from '../orchestration/localBranchHelpers';
import type { ServerMessage, PermissionDenial } from '../ws/types';
import { emitTaskUpdated } from '../routes/tasks';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { GitHubClient } from '../github/GitHubClient';
import { isSystemOnlyUserEvent } from '../utils/eventFilters';
import { SessionAuditor } from './SessionAuditor';
import type { ISessionManager } from './SessionAuditor';
import type { ISessionRunner } from './SessionRunner';
import { CliSessionRunner } from './CliSessionRunner';
import {
  VALID_EVENT_TYPES,
  SILENT_SKIP_TYPES,
  toEventType,
} from './eventTypes';

const PR_URL_REGEX = /https:\/\/github\.com\/[^"\\]+\/pull\/\d+/;

/**
 * Returns true if the tool call represents a git push operation.
 * Exported for unit testing.
 */
export function isPushCommand(toolName: string, toolInput: string): boolean {
  if (toolName === 'mcp__github__push_files') return true;
  if (
    toolName === 'Bash' &&
    /git\s+push/.test(toolInput) &&
    !toolInput.includes('--dry-run')
  )
    return true;
  return false;
}

function sessionLog(sessionId: string, ...args: unknown[]) {
  console.log(`[Session ${sessionId.slice(0, 8)}]`, ...args);
}

/** Parse the Notion page ID out of a notion.so URL or return the raw value. */
export function parseNotionPageId(url: string): string {
  const match = url.match(/([a-f0-9]{32})$/i);
  if (match) return match[1];
  const uuidMatch = url.match(/([0-9a-f-]{36})$/i);
  if (uuidMatch) return uuidMatch[1].replace(/-/g, '');
  return url;
}

/**
 * Merge assistant message content blocks so that text blocks emitted in earlier
 * streaming events are not lost when later streaming events contain only tool_use
 * blocks. The Claude CLI can stream multiple `assistant` events for the same message
 * turn (sharing the same `message.id`) — first text, then tool_use — so we must
 * accumulate rather than replace.
 */
function mergeAssistantContent(
  existing: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const existingText = existing.filter((b) => b.type === 'text');
  const incomingText = incoming.filter((b) => b.type === 'text');

  // Prefer incoming text blocks (they contain the most up-to-date streamed content).
  // If the incoming event has no text blocks, preserve the existing ones.
  const textBlocks = incomingText.length > 0 ? incomingText : existingText;

  // Merge tool_use blocks by id so we don't duplicate them across streaming events.
  const toolUseById = new Map<string, Record<string, unknown>>();
  for (const b of existing) {
    if (b.type === 'tool_use' && typeof b.id === 'string')
      toolUseById.set(b.id, b);
  }
  for (const b of incoming) {
    if (b.type === 'tool_use' && typeof b.id === 'string')
      toolUseById.set(b.id, b);
  }

  return [...textBlocks, ...toolUseById.values()];
}

export class AgentSession extends EventEmitter {
  private isKilling = false;
  public prUrl: string | undefined;
  /** True once a session_ended message has been broadcast. */
  public hasEnded = false;
  /** Maps message_id → DB row id for deduplicating streaming assistant events. */
  private messageIdMap = new Map<string, number>();
  /** Maps message_id → accumulated content blocks, so text is not lost when
   *  tool_use arrives in a later streaming event for the same message. */
  private messageContentMap = new Map<string, Array<Record<string, unknown>>>();
  /** Maps tool_use_id → tool_name for PR creation tools, for real-time detection. */
  private pendingGHToolUseIds = new Map<string, string>();
  /** Maps tool_use_id → Bash command string, for push detection. */
  private pendingBashCommands = new Map<string, string>();
  /** Tracks mcp__github__push_files tool_use IDs awaiting a successful tool_result. */
  private pendingPushFileToolUseIds = new Set<string>();
  /** True once a PR was detected and inserted during the live session. */
  private prDetectedLive = false;
  /** Accumulated token counts for this session (in-memory, synced to SQLite). */
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  /** Model name extracted from the first assistant event (e.g. 'claude-sonnet-4-6'). */
  public model: string | null = null;
  /** Count of consecutive transient-error retries for this session instance. Resets on clean exit. */
  private retryCount = 0;
  /** Guard: fires at most once per session to avoid duplicate pause broadcasts. */
  private inSessionApiErrorFired = false;

  /** The underlying I/O adapter (CLI subprocess or Agent SDK). */
  private runner: ISessionRunner;

  constructor(
    public readonly sessionId: string,
    public readonly taskUrl: string,
    public readonly projectContextUrl: string,
    /**
     * Optional fixed task backend used by tests. In production this is undefined
     * and the backend is resolved per-call via `getTaskBackend(projectId)`.
     */
    private readonly taskBackendOverride: TaskBackend | undefined,
    private readonly worktreePath: string,
    public readonly taskId: string,
    private readonly resumeSessionId?: string,
    private readonly customPrompt?: string,
    public readonly sessionType: string = 'standard',
    private readonly sessionManager?: ISessionManager,
    private readonly githubClient?: GitHubClient,
    private readonly extraAllowedTools: string[] = [],
    /**
     * System prompt content for API mode.
     * In CLI mode this is written to CLAUDE.md in the worktree before spawn.
     * In API mode this is passed directly to the Agent SDK as systemPrompt.
     */
    private readonly systemPromptContent?: string,
    /**
     * The session runner to use. Defaults to CliSessionRunner.
     * Pass an ApiSessionRunner instance when SESSION_MODE=api.
     */
    runner?: ISessionRunner,
    /**
     * Project id used to resolve the task backend at call time when
     * `taskBackendOverride` is undefined. Appended at the end so legacy
     * positional callers (tests) need not be touched.
     */
    public readonly projectId: string = '',
  ) {
    super();
    this.runner = runner ?? new CliSessionRunner(sessionId);
  }

  /** Resolve the per-project task backend, preferring the test override when present. */
  private taskBackend(): TaskBackend {
    return this.taskBackendOverride ?? getTaskBackend(this.projectId);
  }

  async run(): Promise<void> {
    this.broadcast({
      type: 'session_status',
      sessionId: this.sessionId,
      status: 'running',
    });
    updateSessionStatus(this.sessionId, 'running');

    const initialPrompt =
      this.customPrompt ??
      `
You are a Claude Code session managed by Claude Code Orchestrator.

## Task
Task page: ${this.taskUrl}

Read CLAUDE.md in the repo root — it contains the full task spec and all rules.
Begin implementing the task immediately. Do NOT fetch Notion pages.

## Lifecycle
1. Read CLAUDE.md for the task spec, orchestrator rules, and project conventions.
2. Create a feature branch from the project's base branch.
3. Implement the task per the acceptance criteria in the Task Spec section of CLAUDE.md.
4. Pass the pre-PR gate as specified in CLAUDE.md.
5. Open a draft PR as specified in CLAUDE.md.
6. After the PR is open, WAIT. Do not merge.
   The dashboard will send review feedback as follow-up messages.
   Address findings by pushing additional commits, then wait again.

## What the d
[... truncated]
```

### `packages/backend/src/db/queries.ts`
```
import { db } from './db';
import type {
  Session,
  NewSession,
  SessionEvent,
  NewSessionEvent,
  PermissionEvent,
  NewPermissionEvent,
  PermissionRule,
  NewPermissionRule,
  PermissionDenialRow,
  NewPermissionDenialRow,
  TaskCache,
  PullRequestRow,
  PauseReason,
  ProjectRow,
  NewProjectRow,
  MilestoneRow,
  NewMilestoneRow,
  LocalBranchRow,
  NewLocalBranchRow,
} from './types';

// ─── sessions ──────────────────────────────────────────────────────────────

const stmtInsertSession = db.prepare<NewSession>(`
  INSERT INTO sessions
    (session_id, notion_task_id, notion_task_url, project_context_url,
     project_id, status, started_at, ended_at, pr_url, worktree_path, session_type, task_name)
  VALUES
    (@session_id, @notion_task_id, @notion_task_url, @project_context_url,
     @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path, @session_type, @task_name)
`);

const stmtUpdateSessionStatus = db.prepare<{
  session_id: string;
  status: string;
  ended_at: number | null;
}>(`
  UPDATE sessions
  SET status = @status, ended_at = @ended_at
  WHERE session_id = @session_id
`);

const stmtGetSession = db.prepare<{ session_id: string }>(`
  SELECT * FROM sessions WHERE session_id = @session_id
`);

const stmtGetAllSessions = db.prepare(`
  SELECT * FROM sessions ORDER BY started_at DESC
`);

const stmtGetAllSessionIds = db.prepare(`
  SELECT session_id FROM sessions
`);

const stmtDeleteSessionEvents = db.prepare<{ session_id: string }>(`
  DELETE FROM session_events WHERE session_id = @session_id
`);

const stmtDeleteSession = db.prepare<{ session_id: string }>(`
  DELETE FROM sessions WHERE session_id = @session_id
`);

const stmtInsertSessionOrIgnore = db.prepare<NewSession>(`
  INSERT OR IGNORE INTO sessions
    (session_id, notion_task_id, notion_task_url, project_context_url,
     project_id, status, started_at, ended_at, pr_url, worktree_path, session_type, task_name)
  VALUES
    (@session_id, @notion_task_id, @notion_task_url, @project_context_url,
     @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path, @session_type, @task_name)
`);

export function insertSession(s: NewSession): void {
  stmtInsertSession.run({
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    project_id: null,
    session_type: 'standard',
    ...s,
    task_name: s.task_name ?? null,
  });
}

export function updateSessionStatus(
  sessionId: string,
  status: string,
  endedAt?: number,
): void {
  stmtUpdateSessionStatus.run({
    session_id: sessionId,
    status,
    ended_at: endedAt ?? null,
  });
}

export function getSession(sessionId: string): Session | undefined {
  return stmtGetSession.get({ session_id: sessionId }) as Session | undefined;
}

export function getAllSessions(): Session[] {
  return stmtGetAllSessions.all() as Session[];
}

export function getAllSessionIds(): string[] {
  return (stmtGetAllSessionIds.all() as { session_id: string }[]).map(
    (r) => r.session_id,
  );
}

export function insertSessionOrIgnore(s: NewSession): void {
  stmtInsertSessionOrIgnore.run({
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    project_id: null,
    session_type: 'standard',
    ...s,
    task_name: s.task_name ?? null,
  });
}

export function deleteSession(sessionId: string): boolean {
  stmtDeleteSessionEvents.run({ session_id: sessionId });
  const result = stmtDeleteSession.run({ session_id: sessionId });
  return result.changes > 0;
}

/**
 * Delete sessions that have no events — these are "ghost sessions" created by
 * either empty JSONL imports or session starts that never ran the subprocess.
 * Returns the number of sessions deleted.
 */
export function deleteGhostSessions(): number {
  const result = db
    .prepare(
      `
    DELETE FROM sessions
    WHERE session_id NOT IN (SELECT DISTINCT session_id FROM session_events)
  `,
    )
    .run();
  return result.changes;
}

export function getSessionsByStatus(statuses: string[]): Session[] {
  const placeholders = statuses.map(() => '?').join(', ');
  return db
    .prepare(
      `
    SELECT * FROM sessions WHERE status IN (${placeholders}) ORDER BY started_at DESC
  `,
    )
    .all(...statuses) as Session[];
}

/**
 * Returns true when a standard (non-review) session is currently active for the
 * given Notion task id. "Active" means not in a terminal status (done, error,
 * killed). Used by AutoLauncher to avoid re-launching a task whose status hasn't
 * yet propagated back from Notion.
 */
export function hasActiveSessionForTask(notionTaskId: string): boolean {
  const norm = notionTaskId.replace(/-/g, '');
  const row = db
    .prepare<{ notion_task_id: string }>(
      `
    SELECT 1 FROM sessions
    WHERE REPLACE(COALESCE(notion_task_id, ''), '-', '') = @notion_task_id
      AND status NOT IN ('done', 'error', 'killed')
      AND (session_type = 'standard' OR session_type IS NULL)
    LIMIT 1
  `,
    )
    .get({ notion_task_id: norm });
  return !!row;
}

export function getActiveSessions(): Session[] {
  // LEFT JOIN pull_requests so that prUrl is populated even when sessions.pr_url
  // is NULL (e.g. sessions started before their PR was linked back to the row).
  return db
    .prepare(
      `
    SELECT
      s.session_id, s.notion_task_id, s.notion_task_url, s.project_context_url,
      s.project_id, s.status, s.started_at, s.ended_at, s.worktree_path,
      s.archived, s.favorited, s.session_type, s.note, s.tags,
      s.total_input_tokens, s.total_output_tokens, s.model, s.task_name,
      COALESCE(s.pr_url, (
        SELECT p.pr_url FROM pull_requests p WHERE p.session_id = s.session_id LIMIT 1
      )) AS pr_url
    FROM sessions s
    WHERE s.archived = 0
    ORDER BY s.started_at DESC
  `,
    )
    .all() as Session[];
}

export function getArchivedSessions(): Session[] {
  return db
    .prepare(
      'SELECT * FROM sessions WHERE archived = 1 ORDER BY started_at DESC',
    )
    .all() as Session[];
}

export function archiveSession(sessionId: string): boolean {
  const result = db
    .prepare('UPDATE sessions SET archived = 1 WHERE session_id = ?')
    .run(sessionId);
  return result.changes > 0;
}

export function unarchiveSession(sessionId: string): boolean {
  const result = db
    .prepare('UPDATE sessions SET archived = 0 WHERE session_id = ?')
    .run(sessionId);
  return result.changes > 0;
}

export function favoriteSession(sessionId: string): boolean {
  const result = db
    .prepare('UPDATE sessions SET favorited = 1 WHERE session_id = ?')
    .run(sessionId);
  return result.changes > 0;
}

export function unfavoriteSession(sessionId: string): boolean {
  const result = db
    .prepare('UPDATE sessions SET favorited = 0 WHERE session_id = ?')
    .run(sessionId);
  return result.changes > 0;
}

export function archiveFinishedSessions(): number {
  const result = db
    .prepare(
      `UPDATE sessions SET archived = 1 WHERE status IN ('done', 'error', 'killed')`,
    )
    .run();
  return result.changes;
}

export function getSessionsByProject(projectId: string): Session[] {
  return db
    .prepare(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC',
    )
    .all(projectId) as Session[];
}

export function setSessionNote(sessionId: string, note: string | null): void {
  db.prepare('UPDATE sessions SET note = ? WHERE session_id = ?').run(
    note,
    sessionId,
  );
}

export function setSessionModel(sessionId: string, model: string): void {
  db.prepare('UPDATE sessions SET model = ? WHERE session_id = ?').run(
    model,
    sessionId,
  );
}

export function setSessionTags(sessionId: string, tags: string[]): void {
  db.prepare('UPDATE sessions SET tags = ? WHERE session_id = ?').run(
    JSON.stringify(tags),
    sessionId,
  );
}

export function getSessionTags(sessionId: string): string[] {
  const row = db
    .prepare('SELECT tags FROM sessions WHERE session_id = ?')
    .get(sessionId) as { tags: string | null } | undefined;
  if 
[... truncated]
```

### `packages/backend/src/session/SessionManager.ts`
```
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { AgentSession, parseNotionPageId } from './AgentSession';
import { buildSessionContext } from './ContextBuilder';
import { buildReviewClaudeMd } from './orchestrator-claudemd';
import { loadOrchestratorConfig } from './orchestrator-config';
import { CliSessionRunner } from './CliSessionRunner';
import { ApiSessionRunner } from './ApiSessionRunner';
import {
  config,
  getProjectById,
  normalizePath,
  runtimeSettings,
} from '../config';
import {
  insertSession,
  updateSessionStatus,
  insertEvent,
  getSession,
  getSessionsByStatus,
  getPRByNotionTaskId,
  getEventsBySession,
  getPRByNumber,
} from '../db/queries';
import type { Session } from '../db/types';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { GitHubClient } from '../github/GitHubClient';
import type { ServerMessage } from '../ws/types';
import { deriveDisplayStatusFromDb } from '../tasks/TaskStatusEngine';
import type { DisplayStatus } from '../tasks/TaskStatusEngine';
import { emitTaskUpdated } from '../routes/tasks';
import { parseSection } from '../notion/NotionClient';

/** Max chars per file snippet to avoid bloating the CLAUDE.md. */
const MAX_FILE_CHARS = 8_000;
/** Max total chars for all file snippets combined. */
const MAX_TOTAL_SNIPPET_CHARS = 40_000;

/**
 * Parse file paths from the task spec's "Files" section, read each file from
 * the project directory, and return a markdown block with their contents.
 * Returns undefined if no files are found or all reads fail.
 */
function readTaskFiles(
  taskMarkdown: string,
  projectDir: string,
): string | undefined {
  const filesSection = parseSection(taskMarkdown, 'files');
  if (!filesSection.trim()) return undefined;

  const filePaths = filesSection
    .split('\n')
    .map((line) => line.replace(/^[-*\s]+/, '').trim())
    // Strip backticks, trailing descriptions, and markdown formatting like *(new)*
    .map((line) =>
      line
        .replace(/`/g, '') // remove backticks
        .replace(/\s+\*?\(.*?\)\*?\s*$/, '') // remove *(new)*, (update), etc.
        .replace(/\s+[-—–].*$/, '') // remove "— description" suffixes
        .trim(),
    )
    .filter(
      (line) => line.length > 0 && (line.includes('/') || line.includes('.')),
    );

  if (filePaths.length === 0) return undefined;

  const snippets: string[] = [];
  let totalChars = 0;

  for (const filePath of filePaths) {
    if (totalChars >= MAX_TOTAL_SNIPPET_CHARS) break;

    const fullPath = path.join(projectDir, filePath);
    try {
      if (!fs.existsSync(fullPath)) continue;
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;

      let content = fs.readFileSync(fullPath, 'utf-8');
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS) + '\n[... truncated]';
      }

      snippets.push(`### \`${filePath}\`\n\`\`\`\n${content}\n\`\`\``);
      totalChars += content.length;
    } catch {
      // Skip unreadable files silently
    }
  }

  if (snippets.length === 0) return undefined;

  return (
    `## Referenced Files\n\n` +
    `> These are the current contents of files listed in the task spec.\n` +
    `> They were pre-read by the orchestrator so you can skip exploration.\n\n` +
    snippets.join('\n\n')
  );
}

export interface StartOptions {
  taskType?: string;
  sessionType?: 'standard' | 'review';
  customPrompt?: string;
  projectId?: string;
  taskName?: string;
  /** Pre-generated session ID. If omitted, a new UUID is generated internally. */
  sessionId?: string;
}

/** How long to suppress lastMessage-only task_updated broadcasts per task (ms). */
const LAST_MESSAGE_THROTTLE_MS = 3_000;

/**
 * Continuation nudge sent to a resumed session after its first CLI event.
 * Exported so tests can verify the exact message without hardcoding it.
 */
export const RESUME_NUDGE_MESSAGE =
  'Continue implementing the task. Check git status and your todo list to see where you left off.';

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private pendingStarts = new Map<
    string,
    { sessionType: 'standard' | 'review' }
  >();

  /** Last known DisplayStatus per notionTaskId — used to skip no-op broadcasts. */
  private _lastDisplayStatus = new Map<string, DisplayStatus>();
  /** Timestamp of last lastMessage-only task_updated per notionTaskId. */
  private _lastMessageThrottle = new Map<string, number>();
  /** Guards against re-entrant task_updated emission inside the emit override. */
  private _inTaskUpdate = false;

  constructor(private readonly githubClient?: GitHubClient) {
    super();
  }

  /**
   * Override emit to intercept `message` events and emit `task_updated` whenever a
   * message could change a task's derived display status. Guards against re-entrant
   * calls so the task_updated broadcast itself never triggers another one.
   */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const result = super.emit(event, ...args);
    if (event === 'message' && !this._inTaskUpdate) {
      this._inTaskUpdate = true;
      try {
        this._handleTaskUpdated(args[0] as ServerMessage);
      } catch (err) {
        console.error('[SessionManager] task_updated handler error:', err);
      } finally {
        this._inTaskUpdate = false;
      }
    }
    return result;
  }

  /**
   * Inspect an outgoing ServerMessage and, if it could change a task's derived
   * display status, re-derive and broadcast task_updated (de-duped by last known status).
   */
  private _handleTaskUpdated(msg: ServerMessage): void {
    const notionTaskId = this._notionTaskIdForMessage(msg);
    if (!notionTaskId) return;

    const isLastMessageOnly = msg.type === 'session_event';

    if (isLastMessageOnly) {
      const last = this._lastMessageThrottle.get(notionTaskId) ?? 0;
      const now = Date.now();
      if (now - last < LAST_MESSAGE_THROTTLE_MS) return;
      this._lastMessageThrottle.set(notionTaskId, now);
    }

    const displayStatus = deriveDisplayStatusFromDb(notionTaskId);
    const prev = this._lastDisplayStatus.get(notionTaskId);

    if (!isLastMessageOnly && displayStatus === prev) return;
    if (isLastMessageOnly && displayStatus === prev) {
      // lastMessage-only and status unchanged — skip entirely (throttle already passed,
      // but there's nothing interesting to send)
      return;
    }

    this._lastDisplayStatus.set(notionTaskId, displayStatus);
    emitTaskUpdated(notionTaskId);
  }

  /**
   * Determine the notionTaskId affected by a ServerMessage, if any.
   * Returns null for messages that cannot change task display status.
   */
  private _notionTaskIdForMessage(msg: ServerMessage): string | null {
    switch (msg.type) {
      case 'session_started':
      case 'session_ended':
      case 'session_status':
      case 'session_event':
      case 'pr_created': {
        const sessionId = (msg as { sessionId: string }).sessionId;
        const row = getSession(sessionId);
        return row?.notion_task_id ?? null;
      }
      case 'pr_review_complete':
      case 'review_verdict': {
        const { prNumber, repo } = msg as { prNumber: number; repo: string };
        const prRow = getPRByNumber(prNumber, repo);
        return prRow?.notion_task_id ?? null;
      }
      case 'pr_merged':
      case 'pr_closed': {
        const { prNumber, repo } = msg as { prNumber: number; repo: string };
        const prRow = getPRByNumber(prNumber, repo);
        return prRow?.notion_task_id ?? null;
      }
      default:
        return null;
    }
  }

  start(
    taskUrl: string,
    projectContextUrl: string,
    options?: StartOptions,
  ): string {
    const {
      taskType,
      sessionType = 'standard',
      customPrompt,
      projectId = '',
      taskName,
      sessionId: providedSessionId,
    } = options ?
[... truncated]
```

### `packages/backend/src/__tests__/AgentSession.test.ts`
```
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Mock child_process.spawn ───────────────────────────────────────────────
// We need to mock before importing AgentSession because it imports spawn
// at the module level.

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
}));

// Mock DB queries — these would hit a real SQLite db otherwise
vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  insertPermissionEvent: vi.fn(),
  updateSessionStatus: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  getRules: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  insertSessionAudit: vi.fn(),
  incrementTokens: vi.fn(),
  setSessionModel: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
}));

import { AgentSession } from '../session/AgentSession';
import { spawn } from 'child_process';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';
import {
  getRules,
  getEventsBySession,
  upsertSessionEvent,
  getPRBySessionId,
  getPRByNumber,
  setPauseReason,
} from '../db/queries';

function fakeNotionClient(): NotionClient {
  return {
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  } as unknown as NotionClient;
}

describe('AgentSession', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  // ── AC: permission events are broadcast as session_event (engine removed) ─
  // The permission engine (auto-allow/deny rules, UI escalation) was removed
  // in favour of --permission-mode acceptEdits + --allowed-tools. `permission`
  // events from the CLI are now treated as regular system events — stored in
  // DB and broadcast as session_event to the UI.
  it('broadcasts permission event as session_event when CLI emits it', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession(
      's1',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
    );

    vi.mocked(getRules).mockReturnValue([]);

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    mockProc.stdout.push(
      JSON.stringify({
        type: 'permission',
        tool_name: 'Read',
        tool_input: {},
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    // permission events are broadcast as session_event (type=system)
    const sessionEvents = messages.filter((m) => m.type === 'session_event');
    expect(sessionEvents).toHaveLength(1);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('does NOT write approve/deny to stdin for permission events (engine removed)', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession(
      's2',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
    );

    vi.mocked(getRules).mockReturnValue([]);

    const runPromise = session.run();

    mockProc.stdout.push(
      JSON.stringify({
        type: 'permission',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    // Only the initial prompt should have been written — no approve/deny response
    expect(mockProc.stdinChunks).toHaveLength(1);
    expect(mockProc.stdinChunks[0]).toContain('"role":"user"');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  // ── AC: approve() and deny() are safe no-ops ─────────────────────────────
  // These were removed when the interactive permission engine was replaced by
  // --permission-mode acceptEdits. They must not throw when called.
  it('approve() is a safe no-op and does not write to stdin', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession(
      's3',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
    );

    vi.mocked(getRules).mockReturnValue([]);

    const runPromise = session.run();
    const initialChunks = mockProc.stdinChunks.length;

    expect(() => session.approve()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    // No extra data written to stdin by approve()
    expect(mockProc.stdinChunks).toHaveLength(initialChunks);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('deny() is a safe no-op and does not write to stdin', async () => {
    const notion = fakeNotionClient();
    const session = new AgentSession(
      's4',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
    );

    vi.mocked(getRules).mockReturnValue([]);

    const runPromise = session.run();
    const initialChunks = mockProc.stdinChunks.length;

    expect(() => session.deny('Not allowed')).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    // No extra data written to stdin by deny()
    expect(mockProc.stdinChunks).toHaveLength(initialChunks);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  // ── AC: resumeSessionId prepends --resume to spawn args ─────────────────
  it('prepends --resume <id> to spawn args when resumeSessionId is set', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);

    const session = new AgentSession(
      'new-id',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      'orig-session-id',
    );

    const runPromise = session.run();

    // spawn is called synchronously at the start of run(), so args are available now
    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const resumeIdx = spawnArgs.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(spawnArgs[resumeIdx + 1]).toBe('orig-session-id');

    // Clean up — push null to close readline, then emit exit
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('does not send initial prompt to stdin when resumeSessionId is set', async () => {
    const notion = fakeNotionClient();
    vi.mocked(getRules).mockReturnValue([]);

    const session = new AgentSession(
      'new-id',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      'orig-session-id',
    );

    session.run();

    // Resumed sessions skip the initial prompt — stdin should be empty at start
    expect(mockProc.stdinChunks).toHaveLength(0);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
  });

  // ── AC: PR URL regex matches GitHub PR URLs ──────────────────────────────
  it('PR URL rege
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
- **Active Task Board** (Notion): https://www.notion.so/2932df9453ea47d7827b8c17758d77d8

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
- **M5 — Privacy, Bit-rot & UX Polish**: https://www.notion.so/2932df9453ea47d7827b8c17758d77d8 — 🔲 Active (carries deferred M4 themes + UX cleanup)
- **M6 — Enterprise Adoption Readiness**: https://www.notion.so/3edf1af401744a158c0e116810a8ce07 — 🔲 Not started

## Notes

- Current phase: **M5 — Privacy, Bit-rot & UX Polish**
- Filter the active task board to `💻 Code` type tasks unless instructed otherwise.