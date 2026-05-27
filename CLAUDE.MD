# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Auto-revert fires on PR-created only, not on subsequent push-detected events
- **Notion task**: https://www.notion.so/Auto-revert-fires-on-PR-created-only-not-on-subsequent-push-detected-events-36d22f9152f38115b820da47286fe30a
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\6752982b-ab59-4457-8fb9-28ec563937c6`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\6752982b-ab59-4457-8fb9-28ec563937c6`).

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
The auto-revert mechanism (PRFileValidator + PRFileReverter) is supposed to fire on both PR-created AND every subsequent push-detected event for the same PR, per the original spec (PR #404). In practice it appears to fire only on the initial PR-created event. PR #410's audit log has exactly one file_pollution_reverted entry across three pushes that each contained CLAUDE.MD. Wire the push-detected hook properly so subsequent pushes also trigger the fixer.
## Dependencies
None. Independent of the companion worktree-sync task (Sync worktree to origin after orchestrator-side commits). Both can land in parallel.
## Context
### Evidence (PR #410, 2026-05-27)
```javascript
SELECT event_type, ts, payload FROM audit_log
  WHERE event_type LIKE 'file_pollution%'
    AND payload LIKE '%410%';

  file_pollution_reverted | 2026-05-27 19:30 | {"files":["CLAUDE.MD"],"pr_number":410,"commit_sha":"3cafdafe..."}
```
Exactly one event. But the PR's commit history and the three review iterations all confirm CLAUDE.MD was re-committed multiple times. The companion worktree-sync task addresses why CLAUDE.MD keeps coming back; this task addresses why the fixer doesn't catch it on subsequent pushes.
### Where the hook should fire
The PR #404 spec wired the auto-revert at two hook sites:
- AgentSession.handlePRCreatedFromContent — first PR open (working)
- The push-detected path (handlePushDetected or equivalent) — every subsequent push from the session (not working in practice)
The push_detected event is already emitted by AgentSession for re-review purposes (see ReviewOrchestrator's subscription to it). The auto-revert hook should subscribe to the same event stream OR be invoked from the same handler.
### Investigation steps
1. Read AgentSession and confirm where push_detected events are emitted.
1. Read PRFileReverter / PRFileValidator call sites — verify whether the push-detected handler actually invokes them.
1. If the call site exists but isn't firing: check for a guard (e.g., a lastAutofixShas or lastRevertShas map that incorrectly short-circuits on subsequent pushes — see the analogous loop-guard pattern in the autofix-on-CI task).
1. If the call site doesn't exist: add it. The handler should mirror the PR-created path: fetch PR files, validate, revert if needed.
### Likely root cause (hypothesis)
A loop-guard map keyed on (pr_number, repo) that records the SHA of the last revert commit may be incorrectly preventing subsequent invocations — even when the new push reintroduces banned files. The guard's intent is to prevent infinite loops on revert-commit-triggering-revert, but it shouldn't suppress reverts for genuinely new violations on new pushes.
If this is the cause, the fix is to scope the guard to the most recent autofix/revert SHA only, and reset it whenever the session itself pushes a new commit.
### What changes
1. Wire the push-detected hook to invoke the file-pollution path (PRFileValidator + PRFileReverter) in the same way PR-created does. The handler should:
1. Audit the loop guard. If a map records the last-processed SHA per PR, the next push from the session (a NEW SHA) should re-engage the validator. The guard should only suppress when the to-be-processed SHA matches the orchestrator's last-pushed SHA (i.e., "don't process my own revert commits").
1. Add an audit log entry on every push detection that ran the validator — even when no banned files were found — so the frequency of validation is observable. Event type: file_pollution_checked with payload {pr_number, repo, head_sha, banned_files_found: number}.
### Out of scope
- The worktree-sync fix (separate task).
- The scratch-file source-cause fix (separate Tooling task).
- The hard-banned pattern matching extension (existing task).
- Distinguishing between session pushes vs orchestrator-bot pushes — the validator should run on both kinds (with the loop-guard preventing infinite re-processing of bot commits).
## Acceptance criteria
### 🤖 Automated tests
- tsc --noEmit passes for both packages.
- Unit test: a second push_detected event for the same PR triggers a fresh validator + reverter cycle when the new HEAD SHA differs from the last orchestrator-processed SHA.
- Unit test: the validator does NOT re-fire for the orchestrator's own revert commit (loop guard: skip when HEAD SHA == last file_pollution_reverted commit_sha for this PR).
- Unit test: a session push that introduces a new banned file (different from a previously-reverted one) is caught on the new push and an additional file_pollution_reverted audit entry is written.
- Unit test: file_pollution_checked audit entries fire on every push-detected event that ran the validator, with banned_files_found: 0 when clean.
- Integration test: simulate the PR #410 sequence — PR with banned file → first push triggers revert → session pushes a SECOND commit that also includes a banned file → revert fires again. audit_log shows two file_pollution_reverted entries for the same PR.
- Existing PR-created path tests continue to pass (regression).
## Files / paths affected
- packages/backend/src/session/AgentSession.ts (update — add validator + reverter invocation in the push-detected handler, alongside the existing PR-created handler)
- packages/backend/src/github/PRFileReverter.ts (update — if a loop guard exists, scope it to last-processed SHA rather than "already ran once")
- packages/backend/src/audit/types.ts (update — add file_pollution_checked event type)
- packages/backend/src/__tests__/AgentSession.filePollution.test.ts (update — add push-detected cases)
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
     * Pass an ApiSessionRunner instance when SESSION_MODE=api.
     */
    runner?: ISessionRunner,
    /**
     * Project id used to resolve the task backend at call time when
     * `taskBackendOverride` is undefined. Appended at the end so legacy
     * positional callers (tests) need not be touched.
     */
    public readonly pr
[... truncated]
```

### `packages/backend/src/github/PRFileReverter.ts`
```
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd });
}

export async function revertBannedFiles(opts: {
  worktreePath: string;
  baseBranch: string;
  bannedFiles: string[];
  prNumber: number;
  repo: string;
}): Promise<{ commitSha: string | null; reverted: string[] }> {
  const { worktreePath, baseBranch, bannedFiles } = opts;

  if (bannedFiles.length === 0) {
    return { commitSha: null, reverted: [] };
  }

  // Save current worktree content for each banned file so we can restore after push
  const saved = new Map<string, Buffer | null>();
  for (const f of bannedFiles) {
    const abs = path.join(worktreePath, f);
    try {
      saved.set(f, fs.readFileSync(abs));
    } catch {
      saved.set(f, null);
    }
  }

  // Fetch base branch from origin so we have origin/<baseBranch> available
  await git(['fetch', 'origin', baseBranch], worktreePath).catch(() => {});

  const reverted: string[] = [];

  for (const f of bannedFiles) {
    try {
      // Try to restore the file from origin/<baseBranch>.
      // This works for tracked files. If the file didn't exist on the base branch
      // (i.e. it was added by the session), the checkout will fail.
      await git(['checkout', `origin/${baseBranch}`, '--', f], worktreePath);
      reverted.push(f);
    } catch {
      // File wasn't on the base branch — remove it entirely
      try {
        await git(['rm', '-f', '--', f], worktreePath);
        reverted.push(f);
      } catch {
        // File may already be gone; still mark as reverted so we attempt the commit
        reverted.push(f);
      }
    }
  }

  if (reverted.length === 0) {
    return { commitSha: null, reverted: [] };
  }

  // Stage the reverted files
  await git(['add', '--', ...reverted], worktreePath).catch(() => {});

  // Check if there's actually a diff to commit
  let hasStagedChanges = false;
  try {
    await git(['diff', '--cached', '--quiet'], worktreePath);
    // exit 0 = no staged changes
  } catch {
    hasStagedChanges = true;
  }

  if (!hasStagedChanges) {
    // Nothing actually changed — restore worktree content and return no-op
    restoreWorktree(worktreePath, saved);
    return { commitSha: null, reverted: [] };
  }

  const fileList = reverted.join(', ');
  const message = `chore: orchestrator-revert: restore ${fileList} [auto-revert]`;

  await git(
    [
      '-c',
      'user.name=Orchestrator',
      '-c',
      'user.email=orchestrator@claude-code',
      'commit',
      '-m',
      message,
    ],
    worktreePath,
  );

  const { stdout: sha } = await git(['rev-parse', 'HEAD'], worktreePath);
  const commitSha = sha.trim();

  // Push the revert commit
  const branch = (
    await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
  ).stdout.trim();
  await git(['push', 'origin', `HEAD:${branch}`], worktreePath);

  // Restore the worktree files (e.g. CLAUDE.md with orchestrator injection)
  restoreWorktree(worktreePath, saved);

  return { commitSha, reverted };
}

function restoreWorktree(
  worktreePath: string,
  saved: Map<string, Buffer | null>,
): void {
  for (const [f, content] of saved) {
    const abs = path.join(worktreePath, f);
    if (content !== null) {
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      } catch {
        // best-effort
      }
    }
  }
}

```

### `packages/backend/src/audit/types.ts`
```
export type EventType =
  | 'session_launched'
  | 'commit'
  | 'pr_opened'
  | 'pr_merged'
  | 'status_updated'
  | 'pr_body_invalid'
  | 'pr_body_invalid_warning'
  | 'attribution_missing'
  | 'session_launch_refused_zdr'
  | 'data_residency_flag_toggled'
  | 'file_pollution_reverted'
  | 'autofix_for_ci_failure';

export type ActorType = 'ai' | 'human' | 'system';

export interface AuditEvent {
  event_type: EventType;
  actor_type: ActorType;
  actor_id?: string | null;
  project_id?: string | null;
  task_id?: string | null;
  payload: Record<string, unknown>;
}

```

### `packages/backend/src/__tests__/AgentSession.filePollution.test.ts`
```
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