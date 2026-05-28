# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Fix: sessions.task_id stored dashless while task_cache uses dashed — every Tasks-panel JOIN silently fails
- **Notion task**: https://www.notion.so/Fix-sessions-task_id-stored-dashless-while-task_cache-uses-dashed-every-Tasks-panel-JOIN-silently-36e22f9152f381018dd2f6f7c0b402e9
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\9376b79d-56a5-4cd7-b091-bb83d8fa89a7`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\9376b79d-56a5-4cd7-b091-bb83d8fa89a7`).

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
For multiline commit messages, write the message to `.claude/.commit-msg` with the Write tool, then run `git commit -F .claude/.commit-msg`. **Use that exact path** — the `.claude/` directory is gitignored, so the scratch file is never accidentally staged. Do not invent other filenames (`commit-msg.txt`, `.git-commit-msg.txt`, etc.) — they will leak into the PR diff.

**Rule 4 — Do not write to `/tmp/` or paths outside the worktree.**
Use the Write tool for any file creation. Never use `cat >`, `printf >`, or `echo >` redirects.

**Rule 5 — Use `npx` instead of bare tool names.**
`tsc` → `npx tsc`. Bare commands may not be on PATH.

---

## Task Spec

> This is the full task specification, pre-fetched by the orchestrator.
> Do NOT re-fetch this from Notion — use the content below as your source of truth.

## Summary
SessionManager.start and NotionTaskBackend store task IDs in different hyphenation forms (dashless vs dashed). Until D4 reverted the Bridge fix's REPLACE(..., '-', '') SQL wrappers, the JOIN papered over the mismatch. Post-D4, every JOIN between sessions and task_cache silently returns no matches — the Tasks panel's detail pane shows "No active sessions or PRs for this task" for every task, including ones with active running sessions. Align both producers to the dashed form (Notion's native) + backfill existing rows.
## Dependencies
None. Independent of other in-flight work. Touches SessionManager, parseNotionPageId, schema migration, and one query call site.
## Context
### Observed incident (2026-05-28)
After restarting with the merged Tasks-panel detail-pane fix (PR b428d69), the user reported the bug persists for every task. Investigation:
```javascript
=== Active session ===
session_id: 9425e588-9f82-4a88-8316-ed0baa9de8c4
task_id:    notion:36e22f9152f38153b80fef1074f91a03   ← DASHLESS

=== task_cache row lookup by ID variant ===
  notion:36e22f9152f38153b80fef1074f91a03            → missing
  notion:36e22f91-52f3-8153-b80f-ef1074f91a03        → FOUND   ← DASHED

=== Board cache (M6) sample task IDs ===
  notion:36e22f91-52f3-8153-b80f-ef1074f91a03         ← all dashed
  notion:36e22f91-52f3-8197-a78a-f71a5e11a3da
  notion:36d22f91-52f3-8115-b820-da47286fe30a
  ...
```
The API endpoint confirmed the JOIN failure pattern:
```javascript
curl /api/tasks/active?projectId=claude-dashboard&boardId=<M6>
  total tasks: 49
  tasks with non-null codeSession/pr/review: 0
```
The TaskDetail component branches on !task.codeSession && !task.pr && !task.review and renders the empty state. So every task hits the empty state, regardless of whether a session is actually live.
### Why now
The mismatch has existed since commit acfa7b5 (PR #393, "fix: prefix sessions.task_id with 'notion:' in SessionManager.start"). That commit added:
```typescript
// SessionManager.ts:412
const notionTaskId = formatTaskId('notion', parseNotionPageId(taskUrl));
```
parseNotionPageId(url) regex is ([a-f0-9]{32})$ — captures 32 hex chars (dashless form Notion appends to URLs). So sessions.task_id writes the dashless form.
NotionTaskBackend.fetchReadyTasks uses the Notion API's page.id field, which IS dashed:
```typescript
// NotionTaskBackend.ts:45
const prefixedId = formatTaskId('notion', r.task.id);  // r.task.id from Notion = dashed UUID
upsertTaskCache(prefixedId, JSON.stringify({ ...r.task, id: prefixedId }));
```
The Bridge fix (PR #398) wrapped both sides of the JOIN with REPLACE(..., '-', '') to tolerate either form. D4 (Revert Bridge fix band-aid in getActiveTaskAggregates) removed those wrappers per spec — the spec assumed all writes had been unified by D1-D3, but the SessionManager dashless path was overlooked.
### What changes
Recommendation: align to the dashed form (Notion's native).
1. Add a helper in packages/backend/src/session/AgentSession.ts (next to parseNotionPageId):
1. SessionManager.start (SessionManager.ts:412) — use the dashed helper:
1. Schema migration in packages/backend/src/db/schema.ts — backfill existing dashless sessions.task_id rows to dashed form. Idempotent (no-op for already-dashed or non-Notion rows). Same pattern for pull_requests.task_id and audit_log.task_id if they store sessions-form task IDs.
1. Regression test that locks the alignment: a session launched against a Notion URL produces sessions.task_id in the dashed form, matching what NotionTaskBackend.fetchReadyTasks stores in task_cache.
### Why not the other direction (align to dashless)
- Notion's REST API returns dashed UUIDs in page.id. Storing dashless requires stripping dashes at every NotionTaskBackend / NotionClient call site, which is wider blast radius than fixing the one SessionManager site.
- The dashed form is also more grep-friendly when debugging.
### Why not restore the SUBSTR band-aid in queries.ts
It would work, but it's the exact thing D4 just removed (and the spec was explicit it should be reverted once writes are unified). The actual fix is to unify writes, which this task does.
### Out of scope
- The earlier WS-dispatch-path bug (separate task already filed).
- Backfilling cosmetic fields like sessions.task_url that already store something other than a real URL (separate concern, also covered by the WS-dispatch task).
- Removing the parseNotionPageId function — it's still useful where the dashless form is wanted (rare).
## Acceptance criteria
### 🤖 Automated tests
- tsc --noEmit passes for both packages.
- Unit test (parseNotionPageIdDashed): converts a 32-hex dashless ID to dashed UUID; returns dashed input unchanged; passes through non-UUID inputs unchanged.
- Unit test (SessionManager.start): writes a sessions.task_id in the dashed form (notion:<dashed-uuid>) when launched with a Notion task URL.
- Migration test: a fresh DB with sample dashless rows in sessions, pull_requests, audit_log is migrated to all-dashed form; running the migration twice is a no-op the second time.
- Migration test: rows that already have dashed form are untouched; non-Notion task IDs (e.g. yaml:, jira:) are untouched.
- Integration test: launch a session, fetch /api/tasks/active, find the task in the response, assert task.codeSession is non-null and contains the session ID. This regression test would have caught the current break.
- Regression: existing queries.taskAggregates.test.ts tests continue to pass; the empty fallback path is still exercised for tasks that genuinely have no session.
## Files / paths affected
- packages/backend/src/session/AgentSession.ts (update — add parseNotionPageIdDashed)
- packages/backend/src/session/SessionManager.ts (update — use the dashed helper at line 412)
- packages/backend/src/db/schema.ts (update — add idempotent dashless→dashed backfill migration for sessions.task_id, pull_requests.task_id, audit_log.task_id)
- packages/backend/src/__tests__/SessionManager.test.ts (update — add the dashed-form assertion)
- packages/backend/src/__tests__/AgentSession.test.ts (update if parseNotionPageId tests need a sibling for the dashed variant)
- packages/backend/src/__tests__/queries.taskAggregates.test.ts (update — verify direct-comparison JOIN works after the alignment)
- packages/backend/src/__tests__/migrations.taskIdDashed.test.ts (new — covers the migration's idempotency + selectivity)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/session/AgentSession.ts`
```
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { ALLOWED_TOOLS, runtimeSettings } from '../config';
import {
  upsertSessionEvent,
  updateSessionStatus,
  markSessionDone,
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
import {
  validatePRBody,
  buildValidationComment,
} from '../github/PRBodyValidator';
import { validatePRFiles } from '../github/PRFileValidator';
import { revertBannedFiles } from '../github/PRFileReverter';
import { checkCommitAttribution } from '../github/CommitAttributionWatcher';
import { recordEvent } from '../audit/AuditLog';
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

/** Walk a directory tree collecting all .gitignore files, root-first. */
function collectGitignoreSources(
  rootDir: string,
): Array<{ dir: string; content: string }> {
  const results: Array<{ dir: string; content: string }> = [];
  function walk(dir: string): void {
    const rel = path.relative(rootDir, dir).replace(/\\/g, '/');
    const gitignorePath = path.join(dir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        results.push({
          dir: rel,
          content: fs.readFileSync(gitignorePath, 'utf8'),
        });
      } catch {
        // ignore unreadable
      }
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') {
        walk(path.join(dir, e.name));
      }
    }
  }
  walk(rootDir);
  return results;
}

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
  /** One-cycle injection skip lock set by PRFileReverter.
   *  Each entry is consumed (deleted) the first time injectContextFile checks it,
   *  blocking exactly one injection attempt per reverted file before resetting. */
  private readonly _revertLock = new Set<string>();

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
    public readonly worktreePath: string,
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
     * Pass an ApiSessionRunner instance when SESSION_MODE
[... truncated]
```

### `packages/backend/src/session/SessionManager.ts`
```
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { recordEvent } from '../audit/AuditLog';
import { scrubSecrets } from '../security/scrubSecrets';
import { AgentSession, parseNotionPageId } from './AgentSession';
import { formatTaskId } from '../tasks/taskId';
import { buildSessionContext } from './ContextBuilder';
import { buildReviewClaudeMd } from './orchestrator-claudemd';
import { resolveStartingPoint, ensureMilestoneBranch } from './branchModel';
import { loadOrchestratorConfig } from './orchestrator-config';
import { CliSessionRunner } from './CliSessionRunner';
import { ApiSessionRunner } from './ApiSessionRunner';
import {
  DockerSessionRunner,
  reapOrphanContainers,
} from './DockerSessionRunner';
import { getCorporateMode } from '../config/corporateMode';
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
  backfillStuckResultSessions,
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
  /** Milestone row id used for starting-point resolution in two_tier branch mode. */
  milestoneId?: string | null;
  /** Whether this is a milestone task or a non-milestone task; recorded in the audit log. */
  taskKind?: 'milestone' | 'non_milestone';
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
    let emitArgs = args;
    if (event === 'message') {
      const msg = args[0] as ServerMessage;
      if (msg.type === 'session_event' && typeof msg.content === 'string') {
        const scrubbed = scrubSecrets(msg.content);
        if (scrubbed !== msg.content) {
          emitArgs = [{ ...msg, content: scrubbed }, ...args.slice(1)];
        }
      }
    }
    const result = super.emit(event, ...emitArgs);
    if (event === 'message' && !this._inTaskUpdate) {
      this._inTaskUpdate = true;
      try {
        this._handleTaskUpdated(emitArgs[0] as ServerMessage);
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
      case 'se
[... truncated]
```

### `packages/backend/src/db/schema.ts`
```
import { db } from './db';

export function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      task_id             TEXT,
      task_url            TEXT,
      project_context_url TEXT,
      status              TEXT    NOT NULL,
      started_at          INTEGER NOT NULL,
      ended_at            INTEGER,
      pr_url              TEXT,
      worktree_path       TEXT,
      favorited           INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE IF NOT EXISTS permission_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      tool_name       TEXT    NOT NULL,
      proposed_action TEXT,
      decision        TEXT    NOT NULL,
      rule_matched    TEXT,
      decided_at      INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE IF NOT EXISTS permission_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_index INTEGER NOT NULL,
      pattern     TEXT    NOT NULL,
      match_type  TEXT    NOT NULL,
      decision    TEXT    NOT NULL,
      label       TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS permission_denials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      tool_name   TEXT    NOT NULL,
      tool_use_id TEXT    NOT NULL,
      tool_input  TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE IF NOT EXISTS task_cache (
      task_id    TEXT    PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_audits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      pr_opened     INTEGER NOT NULL DEFAULT 0,
      pr_targets    TEXT,
      task_status   TEXT,
      violations    TEXT NOT NULL DEFAULT '[]',
      spec_mismatch TEXT,
      audited_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT    PRIMARY KEY,
      name         TEXT    NOT NULL,
      project_dir  TEXT    NOT NULL,
      context_url  TEXT,
      github_repo  TEXT,
      task_source  TEXT    NOT NULL DEFAULT 'notion',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS milestones (
      id            TEXT    PRIMARY KEY,
      project_id    TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      source_id     TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS local_branches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      branch_name   TEXT NOT NULL,
      base_branch   TEXT NOT NULL DEFAULT 'dev',
      status        TEXT NOT NULL DEFAULT 'open',
      review_result TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_branches_project_status ON local_branches(project_id, status);

    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      event_type TEXT    NOT NULL,
      actor_type TEXT    NOT NULL,
      actor_id   TEXT,
      project_id TEXT,
      task_id    TEXT,
      payload    TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);

    CREATE TABLE IF NOT EXISTS devices (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      user_agent  TEXT,
      last_ip     TEXT,
      last_seen   INTEGER,
      enrolled_at INTEGER NOT NULL,
      token       TEXT    NOT NULL UNIQUE,
      revoked     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pr_review_comments_routed (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number  INTEGER NOT NULL,
      repo       TEXT    NOT NULL,
      comment_id TEXT    NOT NULL,
      routed_at  INTEGER NOT NULL,
      UNIQUE(pr_number, repo, comment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pr_review_comments_routed_pr ON pr_review_comments_routed(pr_number, repo);

    CREATE INDEX IF NOT EXISTS idx_session_events_session_id_id ON session_events(session_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_session_events_session_id_event_type ON session_events(session_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_session_events_timestamp ON session_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_archived_started_at ON sessions(archived, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_notion_task_id_session_type ON sessions(task_id, session_type, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pull_requests_task_id_pr_number ON pull_requests(task_id, pr_number DESC);
  `);

  // Idempotent column additions for existing databases
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN project_id TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN session_type TEXT DEFAULT 'standard'`,
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN note TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN tags TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE session_events ADD COLUMN message_id TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN review_session_id TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      `ALTER TABLE pull_requests ADD COLUMN review_iteration INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN head_sha TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN last_reviewed_sha TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      `ALTER TABLE projects ADD COLUMN auto_launch_enabled INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN auto_launch_milestone_id TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN pause_reason TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN 
[... truncated]
```

### `packages/backend/src/__tests__/SessionManager.test.ts`
```
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { normalizePath } from '../config';

// ── AC: SessionManager.start() updates task status to In Progress ──────────
describe('SessionManager.start() — In Progress status', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('routes updateStatus through getTaskBackend(projectId) for In Progress', () => {
    // Must call getTaskBackend(projectId).updateStatus(notionTaskId, '🔄 In Progress', ...)
    expect(source).toMatch(
      /getTaskBackend\(projectId\)\s*\.updateStatus\s*\(\s*notionTaskId\s*,\s*'🔄 In Progress'/,
    );
  });

  it('In Progress call is fire-and-forget with .catch() error handler', () => {
    expect(source).toMatch(
      /getTaskBackend\(projectId\)\s*\.updateStatus\s*\(\s*notionTaskId\s*,\s*'🔄 In Progress'[\s\S]*?\.catch\b/,
    );
  });

  it('In Progress call is gated on sessionType === standard', () => {
    expect(source).toMatch(/sessionType\s*===\s*'standard'/);
    const gateIdx = source.indexOf("sessionType === 'standard'");
    const inProgressIdx = source.indexOf(
      "updateStatus(notionTaskId, '🔄 In Progress'",
    );
    expect(inProgressIdx).toBeGreaterThan(gateIdx);
  });
});

// ── AC: SessionManager.start() — code-only session limit ────────────────────
describe('SessionManager.start() — code-only session limit', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('code session is rejected when code session count reaches the limit', () => {
    // Must check config.maxConcurrentCodeSessions for non-review sessions
    expect(source).toMatch(/config\.maxConcurrentCodeSessions/);
    // Error message references maxConcurrentCodeSessions
    expect(source).toMatch(/Max concurrent code sessions/);
  });

  it('review session bypasses the cap check entirely', () => {
    // The limit check must be gated on sessionType !== review
    expect(source).toMatch(/sessionType\s*!==\s*'review'/);
    // The cap check block is inside the sessionType !== review guard
    const guardIdx = source.indexOf("sessionType !== 'review'");
    const capCheckIdx = source.indexOf('maxConcurrentCodeSessions');
    expect(capCheckIdx).toBeGreaterThan(guardIdx);
  });

  it('counts only non-review sessions against the cap', () => {
    // Must filter sessions by sessionType !== review before counting
    expect(source).toMatch(
      /\.filter\s*\(\s*\(s\)\s*=>\s*s\.sessionType\s*!==\s*'review'\s*\)/,
    );
  });
});

// ── AC: run() is called fire-and-forget in SessionManager.start() ──────────
// This is a structural check — verify the source code does NOT await run().

describe('SessionManager.start() structural check', () => {
  it('calls run() fire-and-forget (not awaited)', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    // Must contain a .catch() handler (directly or via .then().catch()) to guard against unhandled rejections
    expect(source).toMatch(/session\.run\(\)/);
    expect(source).toMatch(/\.catch\s*\(\s*\(err\)/);

    // Must NOT contain "await session.run()"
    expect(source).not.toMatch(/await\s+session\.run\(\)/);
  });

  it('does not import @anthropic-ai/claude-agent-sdk', () => {
    const agentSource = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'AgentSession.ts'),
      'utf-8',
    );
    expect(agentSource).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});

// ── AC: send() echoes user message as session_event ────────────────────────
describe('SessionManager.send() user_message echo', () => {
  it('calls insertEvent with event_type user_message after sending', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(source).toMatch(/insertEvent/);
    expect(source).toMatch(/event_type.*user_message|user_message.*event_type/);
  });

  it('emits a session_event with eventType user_message', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(source).toMatch(/eventType.*user_message|user_message/);
    expect(source).toMatch(/this\.emit\('message'/);
  });
});

// ── AC: sendOrResume() calls send() directly when session is live ────────────
describe('SessionManager.sendOrResume()', () => {
  it('calls send() directly when session is live in the sessions map', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    // Must contain sendOrResume method
    expect(source).toMatch(/sendOrResume\s*\(/);

    // When live: delegates to send()
    expect(source).toMatch(/this\.sessions\.has\(sessionId\)/);
    expect(source).toMatch(/this\.send\(sessionId,\s*text\)/);
  });

  it('creates a new AgentSession with resumeSessionId when session is not live', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    // Must look up original session from DB
    expect(source).toMatch(/getSession\(sessionId\)/);

    // Must create AgentSession with sessionId as resumeSessionId
    expect(source).toMatch(/new AgentSession/);
    expect(source).toMatch(
      /resumeSessionId|sessionId,\s*\/\/\s*resumeSessionId/,
    );
  });
});

// ── AC: PROJECT_DIR read from env with fallback to process.cwd() ───────────
describe('config.projectDir', () => {
  it('config.ts reads PROJECT_DIR with cwd fallback', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'config.ts'),
      'utf-8',
    );

    expect(source).toContain('PROJECT_DIR');
    expect(source).toContain('process.cwd()');
  });
});

// ── AC: SessionManager.start() accepts sessionType and customPrompt options ─
describe('SessionManager.start() — StartOptions', () => {
  it('accepts sessionType and customPrompt in options', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    expect(source).toMatch(/StartOptions/);
    expect(source).toMatch(/sessionType/);
    expect(source).toMatch(/customPrompt/);
  });

  it('passes session_type to insertSession', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    expect(source).toMatch(
      /session_type.*sessionType|sessionType.*session_type/,
    );
    expect(source).toMatch(/insertSession/);
  });

  it('includes sessionType in session_started broadcast', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    expect(source).toMatch(/sessionType/);
    expect(source).toMatch(/session_started/);
  });

  it('includes totalInputTokens and totalOutputTokens in session_started message', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );

    // Find the session_started broadcast block and verify token fields are present
    const sessionStartedBlock = source.match(
      /type:\s*['"]session_started['"][\s\S]*?satisfies ServerMessage/,
    );
    expect(sessionStartedBlock).not.toBeNull();
    expect(sessionStartedBlock![0]).toMatch(/totalInputTokens/);
    expect(sessionStartedBlock![0]).toMatch(/totalOutputTokens/);
  });
});

// ── AC: normalizePath converts Git Bash paths to Windows-native ─────────────
describe('normalizePath()', () => {
  it('converts /c/Users/... to C:/Users/... on Windows, no-op on other platforms', () => {
    if (process.platform === 'win32') {
      expect(normalizePath('/c/Users/testuser/foo')).toBe(
        'C:/Users/testuser/foo',
      );
  
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
  execFile: vi.fn(),
}));

// Mock DB queries — these would hit a real SQLite db otherwise
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
  markSessionDone,
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

  // ── AC: PR URL regex mat
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