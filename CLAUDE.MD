# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Fix: task panel empty for all milestones — board cache JSON still carries raw task IDs after D3
- **Notion task**: https://www.notion.so/Fix-task-panel-empty-for-all-milestones-board-cache-JSON-still-carries-raw-task-IDs-after-D3-36d22f9152f381219dced6993942354b
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

<<<<<<< HEAD
> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\340c6ddf-449c-442d-b57e-1119b4b455a8`.**
=======
> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\96c69dcd-9c9a-4d83-9aa0-32fd95498759`.**
>>>>>>> bcc354b (chore: apply autofix [orchestrator])
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

<<<<<<< HEAD
All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\340c6ddf-449c-442d-b57e-1119b4b455a8`).
=======
All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\96c69dcd-9c9a-4d83-9aa0-32fd95498759`).
>>>>>>> bcc354b (chore: apply autofix [orchestrator])

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
<<<<<<< HEAD
After D3 (Unify task_cache write conventions) shipped, the per-task cache rows are now keyed notion:<id> (prefixed) but the board sentinel cache row's raw_json still contains tasks with the raw Notion UUID in their id field. The /api/tasks/active route reads task IDs from the board JSON and queries getActiveTaskAggregates(taskIds) with raw IDs — zero matches against the prefixed per-task rows. The Tasks panel renders "No active tasks found" for every milestone, not just M6. Fix is write-side: have each TaskBackend.fetchReadyTasks re-write the board cache row with task IDs already prefixed, keeping the cache's internal invariants consistent.
## Dependencies
None. Surgical write-side fix; no schema change.
## Context
### How the bug manifests
User observed M6 Tasks panel showing No active tasks found with the Sync button as the only affordance. Other panels (Sessions, PRs) work normally. Probing the DB on 2026-05-27 confirmed the pattern is universal across milestones:
```javascript
M5 | total in board cache: 47 | matched via raw IDs: 0  | matched via 'notion:' IDs: 47
M6 | total in board cache: 43 | matched via raw IDs: 0  | matched via 'notion:' IDs: 43
```
### Why dispatch still works but the panel doesn't
- Dispatch (AutoLauncher / fetch_tasks) uses the in-memory return of TaskBackend.fetchReadyTasks — already prefixed by the existing tasks.map(r => ({...r, task: {...r.task, id: prefixedId}})) block. Unaffected.
- Tasks panel (/api/tasks/active) re-reads the board cache row and harvests tasks.map(t => t.id) from its JSON. The JSON content was written by NotionClient.writeBoardCache with raw IDs, and NotionTaskBackend.fetchReadyTasks never overwrote it. Result: raw IDs land in getActiveTaskAggregates, which queries WHERE tc.task_id IN (?, ?, ...) against prefixed rows — 0 matches.
### What D3 fixed and what it left behind
D3 (PR 7fa5d1d) deleted the per-task raw-fan-out write at NotionClient.writeBoardCache:144 (the for (const task of tasks) upsertTaskCache(task.id, JSON.stringify(task)); loop) so that per-task rows are written only by NotionTaskBackend.fetchReadyTasks (with prefixed keys). The board sentinel write upsertTaskCache(boardCacheKey(boardId), JSON.stringify(tasks)) at line 141 still serializes the original task array — the array whose elements still carry raw IDs. D3 didn't touch that line, so the JSON content drifted from the per-task cache convention.
### What changes
1. NotionTaskBackend.fetchReadyTasks (packages/backend/src/tasks/NotionTaskBackend.ts around line 40-58): after the existing tasks.map(...) that builds prefixed: ResolvedTask[] with prefixed task IDs, overwrite the board cache row so its JSON contains prefixed IDs:
1. LocalTaskBackend.fetchReadyTasks — same pattern with yaml: prefix and the local board key shape used today.
1. JiraTaskSourceProvider.fetchReadyTasks — same pattern with jira: prefix.
1. /api/tasks/active route (packages/backend/src/routes/tasks.ts): no change needed at the read side once the board cache is consistent. The route already does taskIds = tasks.map(t => t.id) and feeds them into getActiveTaskAggregates; once t.id is the prefixed form, the join hits the per-task rows.
1. In-flight existing rows: a board cache TTL (5 min) will naturally heal stale rows on next fetchReadyTasks call. No migration needed — once a user clicks Sync or AutoLauncher fires, the row gets rewritten with prefixed IDs. Document this in the PR description.
### Out of scope
- The dependency-resolver block in /api/tasks/active (~line 416) that re-parses boardCacheRow.raw_json and runs DependencyResolver — the dependency edges reference task IDs as strings, but they were emitted by NotionClient.parseDependsOn with raw IDs. After this fix, the resolver maps consume prefixed IDs both as keys and edges. Verify the resolver doesn't lose edges by string-shape drift. If dependsOn arrays inside the board cache JSON still contain raw IDs after this fix, that's a separate sub-bug to address — file as follow-up rather than expanding scope here.
- Any retroactive cache cleanup beyond the TTL.
- The route-side query simplification — keep getActiveTaskAggregates shape stable.
## Acceptance criteria
### 🤖 Automated tests
- tsc --noEmit passes for both packages
- Unit test: after NotionTaskBackend.fetchReadyTasks(milestoneId) runs, the board cache row keyed board:<sourceId> contains tasks whose id field is the prefixed form (notion:<uuid>), not raw
- Unit test: LocalTaskBackend.fetchReadyTasks writes prefixed IDs (yaml:<id>) into the board cache JSON
- Unit test: JiraTaskSourceProvider.fetchReadyTasks writes prefixed IDs (jira:<key>) into the board cache JSON
- Unit test: getActiveTaskAggregates returns non-empty results when the input task IDs match the board cache JSON's task IDs (regression — today this returns empty)
- Integration test: /api/tasks/active?projectId=<p>&boardId=<milestoneId> returns a non-empty array when the board cache has tasks with corresponding task_cache rows
- Regression: dependency-resolver pass at the end of /api/tasks/active produces blocked and blockerNames populated correctly when dependsOn arrays contain prefixed IDs (verify against a fixture with at least one inter-task dependency)
## Files / paths affected
- packages/backend/src/tasks/NotionTaskBackend.ts (update — re-write board cache with prefixed task IDs after the per-task upsert)
- packages/backend/src/tasks/LocalTaskBackend.ts (update — same)
- packages/backend/src/tasks/JiraTaskSourceProvider.ts (update — same)
- packages/backend/src/tasks/NotionTaskBackend.test.ts (or equivalent) (update — assert board cache JSON shape)
- packages/backend/src/__tests__/tasks.test.ts (update — add the integration assertion against /api/tasks/active)
=======
The Manual Verification Gate requires audit_log to contain entries for: session-launch, commit, PR-open, PR-merge, and status-update. Today only the first, third, fourth, and a separate attribution_missing event are emitted — commit (per-commit observation) and status_updated (task status transitions) are missing. Add the two missing event types at the same per-event granularity, with structured payloads.
## Dependencies
None. Hooks attach to existing emit sites; no schema change to audit_log itself.
## Context
### Current state (verified 2026-05-27)
SELECT event_type, COUNT(*) FROM audit_log GROUP BY event_type returns:
- session_launched (30)
- pr_opened (23)
- attribution_missing (11)
- pr_merged (8)
Gate-required types missing:
- commit — per-commit observation event with {sha, author, has_trailer, pr_number?, repo}
- status_updated — task status transition with {task_id, from, to, source: 'orchestrator' | 'human'}
### commit — emit alongside attribution check
CommitAttributionWatcher (packages/backend/src/github/CommitAttributionWatcher.ts) already iterates pushed commits and inspects each for the AI-Authored-By: trailer. Right now it only emits attribution_missing when the trailer is absent. Extend it to emit a commit event for every commit it inspects, with the trailer-presence captured in the payload:
```typescript
recordEvent({
  event_type: 'commit',
  actor_type: hasAITrailer ? 'ai' : 'human',  // bot commits become 'system' — see the bot-author exemption task
  actor_id: sessionId ?? null,
  task_id: taskId ?? null,
  payload: {
    sha: commit.sha,
    author: commit.author.email,
    has_trailer: hasAITrailer,
    pr_number: prNumber,
    repo,
  },
});
```
The existing attribution_missing event continues to fire when hasAITrailer === false (and the author isn't the orchestrator bot — see the companion bot-author exemption task). The two events are complementary: commit is the per-event observation; attribution_missing is the policy violation flag.
### status_updated — emit on every TaskBackend.updateStatus call
Every task status transition flows through TaskBackend.updateStatus(taskId, status). The two implementations are NotionTaskBackend.updateStatus (packages/backend/src/tasks/NotionTaskBackend.ts:65-68) and LocalTaskBackend.updateStatus. Wrap both call sites — ideally at the factory boundary (getTaskBackend() in TaskBackend.ts) — so the audit emit happens once for every implementation.
Payload:
```typescript
recordEvent({
  event_type: 'status_updated',
  actor_type: source === 'human' ? 'human' : 'system',
  actor_id: sessionId ?? null,
  task_id: taskId,
  payload: {
    from: previousStatus ?? null,  // null if not retrievable without an extra round-trip
    to: newStatus,
    source: 'orchestrator' | 'human',
  },
});
```
previousStatus is a nice-to-have. If retrieving it costs an extra Notion/local round-trip, write null and add a note in payload.notes ("previous status not captured") rather than skip the event. The gate primarily wants the event to fire; the from field is a refinement.
source is set by the caller: SessionManager updates pass 'orchestrator'; manual UI-driven status changes via the routes layer pass 'human'.
### Out of scope
- Exempting bot-author commits from attribution_missing (separate task — see the bot-author task in the M6 board).
- Backfilling historical sessions — audit log is forward-only.
- Surfacing commit / status_updated in any dashboard UI — audit-log only for now.
- Adding new actor_type values beyond the existing ai | human | system enum.
## Acceptance criteria
### 🤖 Automated tests
- tsc --noEmit passes for both packages
- Unit test: CommitAttributionWatcher inspecting a commit WITH the AI-Authored-By: trailer writes exactly one commit audit entry with has_trailer: true and zero attribution_missing entries
- Unit test: same watcher inspecting a commit WITHOUT the trailer writes one commit (with has_trailer: false) and one attribution_missing (unchanged behavior modulo the bot-author exemption from the companion task)
- Unit test: NotionTaskBackend.updateStatus('notion:abc', '👀 In Review') writes one status_updated audit entry with the expected payload shape
- Unit test: LocalTaskBackend.updateStatus(...) writes the equivalent entry
- Unit test: status_updated source field is 'orchestrator' when called from SessionManager's lifecycle hooks, 'human' when called from the PATCH /api/tasks/:id/status route handler
- Integration test: starting a session, opening a PR, and merging it produces all five required event types in audit_log (session_launched, commit for at least one commit, pr_opened, pr_merged, status_updated for at least one transition)
- Regression: existing pr_opened, pr_merged, session_launched, attribution_missing events continue to fire as before
## Files / paths affected
- packages/backend/src/github/CommitAttributionWatcher.ts (update — emit commit alongside existing attribution_missing)
- packages/backend/src/tasks/TaskBackend.ts (update if wrapping at factory boundary)
- packages/backend/src/tasks/NotionTaskBackend.ts (update — alternative: emit at impl boundary)
- packages/backend/src/tasks/LocalTaskBackend.ts (update — same)
- packages/backend/src/audit/types.ts (update — add commit and status_updated event types with payload shapes)
- packages/backend/src/session/SessionManager.ts (update — pass source: 'orchestrator' through any status update path that doesn't already)
- packages/backend/src/routes/tasks.ts (update — pass source: 'human' from manual UI status changes)
>>>>>>> bcc354b (chore: apply autofix [orchestrator])
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

<<<<<<< HEAD
=======
### `packages/backend/src/github/CommitAttributionWatcher.ts`
```
import { recordEvent } from '../audit/AuditLog';
import { setPauseReason } from '../db/queries';
import type { GitHubClient } from './GitHubClient';

/** Matches the AI-Authored-By trailer in a commit message. */
export const AI_TRAILER_REGEX = /^AI-Authored-By:/m;

export interface CommitInfo {
  sha: string;
  message: string;
}

export interface AttributionCheckResult {
  checked: number;
  missing: number;
  paused: boolean;
}

/**
 * Check that all commits in a PR carry the AI-Authored-By trailer.
 * In corporate mode, missing trailers pause the PR and are audit-logged.
 * In non-corporate mode, only audit-logs (no pause).
 *
 * Returns a summary of what was found.
 */
export async function checkCommitAttribution(
  client: GitHubClient,
  repo: string,
  prNumber: number,
  sessionId: string,
  projectId: string | null,
  taskId: string | null,
  isCorporateMode: boolean,
): Promise<AttributionCheckResult> {
  let commits: CommitInfo[];
  try {
    commits = await client.getCommitsForPR(repo, prNumber);
  } catch (err) {
    console.warn(
      `[CommitAttributionWatcher] failed to fetch commits for PR #${prNumber} in ${repo}: ${(err as Error).message}`,
    );
    return { checked: 0, missing: 0, paused: false };
  }

  const missingTrailer = commits.filter(
    (c) => !AI_TRAILER_REGEX.test(c.message),
  );

  if (missingTrailer.length === 0) {
    return { checked: commits.length, missing: 0, paused: false };
  }

  for (const commit of missingTrailer) {
    recordEvent({
      event_type: 'attribution_missing',
      actor_type: 'ai',
      actor_id: sessionId,
      project_id: projectId,
      task_id: taskId,
      payload: { sha: commit.sha, pr_number: prNumber, repo },
    });
  }

  if (isCorporateMode) {
    setPauseReason(prNumber, repo, 'attribution_missing');
    return {
      checked: commits.length,
      missing: missingTrailer.length,
      paused: true,
    };
  }

  return {
    checked: commits.length,
    missing: missingTrailer.length,
    paused: false,
  };
}

```

### `packages/backend/src/tasks/TaskBackend.ts`
```
import type { ResolvedTask } from './types';
import { ProjectService } from '../projects/ProjectService';
import { NotionClient } from '../notion/NotionClient';
import { NotionTaskBackend } from './NotionTaskBackend';
import { LocalTaskBackend } from './LocalTaskBackend';
import { JiraClient } from './JiraClient';
import {
  JiraTaskSourceProvider,
  type JiraProjectConfig,
} from './JiraTaskSourceProvider';
import { JIRA_HOST, JIRA_TOKEN, JIRA_EMAIL } from '../config';

/**
 * Per-project configuration that identifies where non-milestone tasks are sourced from.
 * Stored as JSON in projects.non_milestone_source_config.
 */
export interface NonMilestoneSourceConfig {
  /** Notion database ID (for notion-backed projects). */
  notionDatabaseId?: string;
  /** tasks.yaml milestone id (for yaml-backed projects). */
  milestoneId?: string;
}

/**
 * Project-scoped task tracker. An instance is bound to a single project via the
 * factory `getTaskBackend(projectId)` — callers do not pass projectId to methods.
 */
export interface TaskBackend {
  /** Backend identifier; reflects the project's task_source. */
  readonly type: 'notion' | 'local' | 'jira';

  /**
   * Fetch tasks that are ready to be dispatched for the given milestone.
   * For Notion projects, milestoneId is resolved to the milestone row's source_id
   * (the Notion database ID). For YAML projects, pass null to fetch all tasks
   * across all milestones, or a milestone id to scope to one.
   */
  fetchReadyTasks(
    milestoneId: string | null,
    skipCache?: boolean,
  ): Promise<ResolvedTask[]>;

  /** Mark a task as in-review and attach a PR URL. */
  attachPR(taskId: string, prUrl: string): Promise<void>;

  /** Update task status (display-format string with emoji prefix). */
  updateStatus(taskId: string, status: string): Promise<void>;

  /** Fetch the full task page body as markdown (for review/session context). */
  fetchTaskPage(taskId: string): Promise<string>;

  /**
   * Fetch tasks ready to launch that are not tied to a milestone.
   * sourceConfig identifies which source (Notion database or YAML milestone) to query.
   * Returns [] when sourceConfig is null or the source is not configured.
   */
  fetchNonMilestoneReadyTasks(
    sourceConfig: NonMilestoneSourceConfig | null,
    projectId?: string,
  ): Promise<ResolvedTask[]>;
}

/**
 * Backwards-compatible alias for the previous interface name.
 * Prefer `TaskBackend` in new code.
 */
export type TaskTrackerBackend = TaskBackend;

// ── Factory ─────────────────────────────────────────────────────────────────

let _notionBackend: NotionTaskBackend | undefined;

function getNotionBackend(): NotionTaskBackend {
  _notionBackend ??= new NotionTaskBackend(new NotionClient());
  return _notionBackend;
}

/**
 * Resolve the task backend for a project, honoring its `task_source` column.
 * Throws if the project is not found.
 */
export function getTaskBackend(projectId: string): TaskBackend {
  const project = ProjectService.getById(projectId);
  if (!project) {
    throw new Error(`[getTaskBackend] project not found: ${projectId}`);
  }
  if (project.taskSource === 'yaml') {
    return new LocalTaskBackend(project.projectDir);
  }
  if (project.taskSource === 'jira') {
    return buildJiraBackend(project.taskSourceConfig);
  }
  return getNotionBackend();
}

function buildJiraBackend(
  taskSourceConfigJson: string | null,
): JiraTaskSourceProvider {
  let projectConfig: JiraProjectConfig;
  try {
    projectConfig = taskSourceConfigJson
      ? (JSON.parse(taskSourceConfigJson) as JiraProjectConfig)
      : { host: JIRA_HOST, project_key: '' };
  } catch {
    projectConfig = { host: JIRA_HOST, project_key: '' };
  }
  const host = projectConfig.host || JIRA_HOST;
  const token = JIRA_TOKEN;
  const email = JIRA_EMAIL || undefined;
  const client = new JiraClient(host, token, email);
  return new JiraTaskSourceProvider(client, { ...projectConfig, host });
}

/**
 * Test-only: reset the cached Notion backend so subsequent `getTaskBackend()`
 * calls re-instantiate it. Useful for vi.mocked NotionClient.
 */
export function _resetTaskBackendCacheForTests(): void {
  _notionBackend = undefined;
}

```

>>>>>>> bcc354b (chore: apply autofix [orchestrator])
### `packages/backend/src/tasks/NotionTaskBackend.ts`
```
import type { TaskBackend, NonMilestoneSourceConfig } from './TaskBackend';
import type { ResolvedTask } from './types';
import { formatTaskId } from './taskId';
import { NotionClient } from '../notion/NotionClient';
import { ProjectService } from '../projects/ProjectService';
import { upsertTaskCache } from '../db/queries';

/**
 * Notion-backed implementation of TaskBackend. Resolves the Notion database ID
 * from the milestone row's `source_id`, then delegates to NotionClient.
 *
 * All public methods accept prefixed task IDs (e.g. 'notion:abc123') and strip
 * the prefix before calling the Notion API.
 */
export class NotionTaskBackend implements TaskBackend {
  readonly type = 'notion' as const;

  constructor(private readonly client: NotionClient) {}

  async fetchReadyTasks(
    milestoneId: string | null,
    skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    if (milestoneId === null) {
      throw new Error(
        `[NotionTaskBackend] milestoneId is required for Notion projects`,
      );
    }
    const milestone = ProjectService.getMilestone(milestoneId);
    if (!milestone) {
      throw new Error(
        `[NotionTaskBackend] milestone not found: ${milestoneId}`,
      );
    }
    if (!milestone.sourceId) {
      throw new Error(
        `[NotionTaskBackend] milestone ${milestoneId} has no source_id — set it to the Notion database ID`,
      );
    }
    const tasks = await this.client.fetchReadyTasks(
      milestone.sourceId,
      skipCache,
    );
    return tasks.map((r) => {
      const prefixedId = formatTaskId('notion', r.task.id);
      // Also cache under the prefixed key so getTaskTitleFromCache works with
      // prefixed session.task_id lookups.
      upsertTaskCache(
        prefixedId,
        JSON.stringify({ ...r.task, id: prefixedId }),
      );
      return {
        ...r,
        task: { ...r.task, id: prefixedId },
        source: 'notion' as const,
      };
    });
  }

  async attachPR(taskId: string, prUrl: string): Promise<void> {
    return this.client.attachPR(taskId, prUrl);
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    return this.client.updateStatus(taskId, status);
  }

  async fetchTaskPage(taskId: string): Promise<string> {
    const page = await this.client.fetchTaskPage(taskId);
    return page.rawMarkdown;
  }

  async fetchNonMilestoneReadyTasks(
    sourceConfig: NonMilestoneSourceConfig | null,
    projectId?: string,
  ): Promise<ResolvedTask[]> {
    if (!sourceConfig?.notionDatabaseId) return [];
    const tasks = await this.client.fetchReadyTasks(
      sourceConfig.notionDatabaseId,
      true,
    );
    const resolved = tasks.map((r) => {
      const prefixedId = formatTaskId('notion', r.task.id);
      upsertTaskCache(
        prefixedId,
        JSON.stringify({ ...r.task, id: prefixedId }),
      );
      return {
        ...r,
        task: { ...r.task, id: prefixedId },
        source: 'notion' as const,
      };
    });
    // Cache full task list under the project's non-milestone key so the HTTP endpoint can serve it.
    if (projectId) {
      upsertTaskCache(
        `non_milestone:${projectId}`,
        JSON.stringify(resolved.map((r) => r.task)),
      );
    }
    return resolved;
  }
}

```

### `packages/backend/src/tasks/LocalTaskBackend.ts`
```
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { TaskBackend, NonMilestoneSourceConfig } from './TaskBackend';
import type { ResolvedTask } from './types';
import type { NotionTask } from '../notion/types';
import { toExternalId, formatTaskId } from './taskId';
import { DependencyResolver } from '../notion/DependencyResolver';
import { upsertTaskCache } from '../db/queries';

// ── tasks.yaml schema ────────────────────────────────────────────────────────

interface LocalTask {
  id: string;
  name: string;
  status: string; // Backlog | Ready | In Progress | In Review | Done
  priority?: string; // High | Medium | Low
  type?: string; // Code | Planning | Testing
  depends_on?: string[];
  pr_url?: string | null;
  context?: string;
  acceptance_criteria?: string;
  files_affected?: string[];
  notes?: string;
}

interface LocalMilestone {
  id: string;
  name: string;
  tasks: LocalTask[];
}

/** New milestone-keyed schema. */
interface MilestoneTasksFile {
  project?: { id: string; name?: string };
  milestones: LocalMilestone[];
}

/** Old flat schema, kept only for migration. */
interface FlatTasksFile {
  board_id?: string;
  tasks: LocalTask[];
}

type AnyTasksFile = MilestoneTasksFile | FlatTasksFile;

// ── Status mapping ───────────────────────────────────────────────────────────

const STATUS_DISPLAY: Record<string, string> = {
  Backlog: '🔲 Backlog',
  Ready: '🗂️ Ready',
  'In Progress': '🔄 In Progress',
  'In Review': '👀 In Review',
  Done: '✅ Done',
};

const TYPE_DISPLAY: Record<string, string> = {
  Code: '💻 Code',
  Planning: '📋 Planning',
  Testing: '🧪 Testing',
};

function toDisplayStatus(status: string): string {
  return STATUS_DISPLAY[status] ?? status;
}

function toDisplayType(type: string): string {
  return TYPE_DISPLAY[type] ?? type;
}

function fromDisplayStatus(display: string): string {
  const entry = Object.entries(STATUS_DISPLAY).find(([, v]) => v === display);
  return entry ? entry[0] : display;
}

// ── Schema helpers ───────────────────────────────────────────────────────────

function isMilestoneSchema(
  parsed: AnyTasksFile | null,
): parsed is MilestoneTasksFile {
  return !!parsed && Array.isArray((parsed as MilestoneTasksFile).milestones);
}

function isFlatSchema(parsed: AnyTasksFile | null): parsed is FlatTasksFile {
  return !!parsed && Array.isArray((parsed as FlatTasksFile).tasks);
}

// ── LocalTaskBackend ─────────────────────────────────────────────────────────

const resolver = new DependencyResolver();

/**
 * File-based implementation of TaskBackend. Reads/writes task definitions from
 * `<projectDir>/tasks.yaml` using the milestone-keyed schema. Old flat-schema
 * files are auto-migrated on first read.
 *
 * All public methods accept prefixed task IDs (e.g. 'yaml:my-task') and strip
 * the prefix before operating on the file.
 */
export class LocalTaskBackend implements TaskBackend {
  readonly type = 'local' as const;

  constructor(private readonly projectDir: string) {}

  private get filePath(): string {
    return path.join(this.projectDir, 'tasks.yaml');
  }

  /** Read tasks.yaml, migrating old flat schema to milestone schema if needed. */
  private readFile(): MilestoneTasksFile {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(
        `[LocalTaskBackend] tasks.yaml not found at ${this.filePath}`,
      );
    }
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const parsed = yaml.load(raw) as AnyTasksFile | null;

    if (isMilestoneSchema(parsed)) {
      return parsed;
    }

    if (isFlatSchema(parsed)) {
      const migrated = this.migrateFlatToMilestones(parsed);
      this.writeFile(migrated);
      console.log(
        `[LocalTaskBackend] Migrated ${this.filePath} to milestone schema.`,
      );
      return migrated;
    }

    throw new Error(
      `[LocalTaskBackend] tasks.yaml at ${this.filePath} is missing both 'milestones' and 'tasks' keys`,
    );
  }

  /** Wrap a flat-schema file's tasks under a single milestone. */
  private migrateFlatToMilestones(flat: FlatTasksFile): MilestoneTasksFile {
    const id =
      flat.board_id && flat.board_id !== 'default' ? flat.board_id : 'm1';
    const name =
      flat.board_id && flat.board_id !== 'default' ? flat.board_id : 'Default';
    return {
      milestones: [{ id, name, tasks: flat.tasks ?? [] }],
    };
  }

  private writeFile(file: MilestoneTasksFile): void {
    fs.writeFileSync(
      this.filePath,
      yaml.dump(file, { lineWidth: 120 }),
      'utf-8',
    );
  }

  private mapToNotionTask(t: LocalTask): NotionTask {
    return {
      id: t.id,
      title: t.name,
      status: toDisplayStatus(t.status),
      type: toDisplayType(t.type ?? 'Code'),
      dependsOn: t.depends_on ?? [],
      notionUrl: '',
      prUrl: t.pr_url ?? undefined,
      priority: t.priority,
    };
  }

  /** Locate the milestone containing a given raw task id (no prefix), or undefined. */
  private findTaskById(
    file: MilestoneTasksFile,
    rawTaskId: string,
  ): { milestone: LocalMilestone; task: LocalTask } | undefined {
    for (const m of file.milestones) {
      const task = m.tasks.find((t) => t.id === rawTaskId);
      if (task) return { milestone: m, task };
    }
    return undefined;
  }

  async fetchReadyTasks(
    milestoneId: string | null,
    _skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    const file = this.readFile();
    let allTasks: NotionTask[];
    if (milestoneId === null) {
      allTasks = file.milestones.flatMap((m) =>
        m.tasks.map((t) => this.mapToNotionTask(t)),
      );
    } else {
      const milestone = file.milestones.find((m) => m.id === milestoneId);
      if (!milestone) {
        throw new Error(
          `[LocalTaskBackend] milestone not found in ${this.filePath}: ${milestoneId}`,
        );
      }
      allTasks = milestone.tasks.map((t) => this.mapToNotionTask(t));
      upsertTaskCache(`board:${milestoneId}`, JSON.stringify(allTasks));
    }
    // Cache each task under its prefixed key
    for (const task of allTasks) {
      upsertTaskCache(formatTaskId('yaml', task.id), JSON.stringify(task));
    }
    const resolved = resolver.resolve(allTasks, 'yaml');
    // Prepend yaml: prefix to task IDs in returned results
    return resolved.map((r) => ({
      ...r,
      task: { ...r.task, id: formatTaskId('yaml', r.task.id) },
    }));
  }

  async attachPR(taskId: string, prUrl: string): Promise<void> {
    const externalId = toExternalId(taskId);
    const file = this.readFile();
    const found = this.findTaskById(file, externalId);
    if (!found) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);
    found.task.pr_url = prUrl;
    this.writeFile(file);
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    const externalId = toExternalId(taskId);
    const file = this.readFile();
    const found = this.findTaskById(file, externalId);
    if (!found) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);
    found.task.status = fromDisplayStatus(status);
    this.writeFile(file);
  }

  async fetchTaskPage(taskId: string): Promise<string> {
    const externalId = toExternalId(taskId);
    const file = this.readFile();
    const found = this.findTaskById(file, externalId);
    if (!found) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);
    const task = found.task;

    const sections: string[] = [`# ${task.name}`];
    if (task.context?.trim()) {
      sections.push(`## Context\n${task.context.trim()}`);
    }
    if (task.acceptance_criteria?.trim()) {
      sections.push(
        `## Acceptance Criteria\n${task.acceptance_criteria.trim()}`,
      );
    }
    if (task.files_affected && task.files_affected.length > 0) {
      sections.push(
        `## Files\n${task.files_affected.map((f) => `- ${f}`).join('\n')}`,
      );
    }
    if (task.notes?.trim()) {
      sections.push(`## Notes\n${task.notes.trim()}`);
    }
    return 
[... truncated]
```

<<<<<<< HEAD
### `packages/backend/src/tasks/JiraTaskSourceProvider.ts`
```
import type { TaskBackend } from './TaskBackend';
import type { ResolvedTask } from './types';
import type { NotionTask } from '../notion/types';
import { formatTaskId, toExternalId } from './taskId';
import { JiraClient } from './JiraClient';
import { DependencyResolver } from '../notion/DependencyResolver';
import { upsertTaskCache } from '../db/queries';

export interface JiraProjectConfig {
  host: string;
  project_key: string;
  /** Full JQL override. When set, ready_statuses is ignored for fetchReadyTasks. */
  default_jql?: string;
  /** Jira status names that map to "ready to launch". Defaults to DEFAULT_READY_STATUSES. */
  ready_statuses?: string[];
  /**
   * Maps orchestrator display statuses (emoji-prefixed) to Jira status names.
   * Defaults to DEFAULT_STATUS_MAPPING.
   */
  status_mapping?: Record<string, string>;
}

const DEFAULT_READY_STATUSES = ['To Do', 'Ready'];

const DEFAULT_STATUS_MAPPING: Record<string, string> = {
  '🔲 Backlog': 'Backlog',
  '🗂️ Ready': 'To Do',
  '🔄 In Progress': 'In Progress',
  '👀 In Review': 'In Review',
  '✅ Done': 'Done',
};

const TYPE_MAP: Record<string, string> = {
  Bug: '🧪 Testing',
  Task: '💻 Code',
  Story: '💻 Code',
  Epic: '📋 Planning',
};

function mapIssueType(issuetype: string): string {
  return TYPE_MAP[issuetype] ?? '💻 Code';
}

const resolver = new DependencyResolver();

export class JiraTaskSourceProvider implements TaskBackend {
  readonly type = 'jira' as const;

  constructor(
    private readonly client: JiraClient,
    private readonly projectConfig: JiraProjectConfig,
  ) {}

  async fetchReadyTasks(
    _milestoneId: string | null,
    _skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    const jql = this.buildReadyJql();
    const issues = await this.client.searchIssues(jql);

    const tasks: NotionTask[] = issues.map((issue) => ({
      id: issue.key,
      title: issue.fields.summary,
      status: issue.fields.status.name,
      type: mapIssueType(issue.fields.issuetype.name),
      dependsOn: [],
      notionUrl: '',
      priority: issue.fields.priority?.name,
    }));

    for (const task of tasks) {
      const prefixedId = formatTaskId('jira', task.id);
      upsertTaskCache(prefixedId, JSON.stringify({ ...task, id: prefixedId }));
    }

    const resolved = resolver.resolve(tasks, 'jira');
    return resolved.map((r) => ({
      ...r,
      task: { ...r.task, id: formatTaskId('jira', r.task.id) },
    }));
  }

  async attachPR(taskId: string, prUrl: string): Promise<void> {
    const externalId = toExternalId(taskId);
    await this.client.addComment(externalId, `PR: ${prUrl}`);
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    const externalId = toExternalId(taskId);
    const mapping = this.projectConfig.status_mapping ?? DEFAULT_STATUS_MAPPING;
    const targetJiraStatus = mapping[status];
    if (!targetJiraStatus) {
      throw new Error(
        `[JiraTaskSourceProvider] no Jira status mapping for: "${status}"`,
      );
    }
    const transitions = await this.client.getTransitions(externalId);
    const transition = transitions.find(
      (t) => t.to.name.toLowerCase() === targetJiraStatus.toLowerCase(),
    );
    if (!transition) {
      throw new Error(
        `[JiraTaskSourceProvider] no transition to "${targetJiraStatus}" for issue ${externalId}`,
      );
    }
    await this.client.transitionIssue(externalId, transition.id);
  }

  async fetchTaskPage(taskId: string): Promise<string> {
    const externalId = toExternalId(taskId);
    const issue = await this.client.getIssue(externalId);
    const lines: string[] = [`# ${issue.fields.summary}`];
    lines.push(`**Status:** ${issue.fields.status.name}`);
    lines.push(`**Type:** ${issue.fields.issuetype.name}`);
    if (issue.fields.priority) {
      lines.push(`**Priority:** ${issue.fields.priority.name}`);
    }
    const desc = issue.fields.description;
    if (desc && typeof desc === 'string' && desc.trim()) {
      lines.push('', '## Description', desc.trim());
    }
    return lines.join('\n');
  }

  async fetchNonMilestoneReadyTasks(): Promise<ResolvedTask[]> {
    return [];
  }

  private buildReadyJql(): string {
    if (this.projectConfig.default_jql) {
      return this.projectConfig.default_jql;
    }
    const readyStatuses =
      this.projectConfig.ready_statuses ?? DEFAULT_READY_STATUSES;
    return this.client.buildReadyJql(
      this.projectConfig.project_key,
      readyStatuses,
    );
  }
}

```

### `packages/backend/src/__tests__/tasks.test.ts`
```
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import yaml from 'js-yaml';
import type { TaskAggregateRow } from '../db/queries.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getTaskCache: vi.fn(),
  getActiveTaskAggregates: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
  getMilestoneById: vi.fn().mockReturnValue(null),
}));

vi.mock('../config.js', () => ({
  getProjectById: vi.fn((id: string) => {
    if (id === 'proj-1') {
      return {
        id: 'proj-1',
        name: 'Test Project',
        projectDir: '/test',
        contextUrl: 'https://notion.so/ctx',
        boardId: 'board-1',
      };
    }
    return undefined;
  }),
}));

import { createTasksRouter, summarizeEvent } from '../routes/tasks.js';
import * as queries from '../db/queries.js';
import type { NotionTask } from '../notion/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAggregate(
  notionTaskId: string,
  notionStatus: string,
  overrides: Partial<TaskAggregateRow> = {},
): TaskAggregateRow {
  const task: NotionTask = {
    id: notionTaskId,
    title: `Task ${notionTaskId}`,
    status: notionStatus,
    type: '💻 Code',
    dependsOn: [],
    notionUrl: `https://notion.so/${notionTaskId}`,
  };
  return {
    task_id: notionTaskId,
    raw_json: JSON.stringify(task),
    code_session_id: null,
    code_session_status: null,
    code_session_started_at: null,
    code_session_ended_at: null,
    code_session_input_tokens: null,
    code_session_output_tokens: null,
    code_session_last_event_payload: null,
    review_session_id: null,
    review_session_status: null,
    review_session_input_tokens: null,
    review_session_output_tokens: null,
    pr_number: null,
    pr_url: null,
    pr_title: null,
    pr_head_branch: null,
    pr_base_branch: null,
    pr_state: null,
    pr_draft: null,
    pr_review_result: null,
    pr_review_iteration: null,
    pr_merge_state: null,
    pr_pause_reason: null,
    review_session_result: null,
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createTasksRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: board cache returns three task IDs
  vi.mocked(queries.getTaskCache).mockReturnValue({
    cache_key: 'board:board-1',
    raw_json: JSON.stringify([
      { id: 'task-ready' },
      { id: 'task-done' },
      { id: 'task-deferred' },
      { id: 'task-backlog' },
      { id: 'task-in-progress' },
    ]),
    fetched_at: Date.now(),
  } as never);
});

// ── GET /api/tasks/active filtering ──────────────────────────────────────────

describe('GET /api/tasks/active', () => {
  // Done tasks are excluded at the SQL layer (getActiveTaskAggregates) so they
  // never reach the route. Backlog tasks are intentionally surfaced in the
  // Tasks panel. Only Deferred is filtered at the route level.

  it('does not include tasks with Deferred Notion status', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-ready', '🗂️ Ready'),
      makeAggregate('task-deferred', '⏸️ Deferred'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const ids = res.body.map((t: { taskId: string }) => t.taskId);
    expect(ids).not.toContain('task-deferred');
    expect(ids).toContain('task-ready');
  });

  it('returns Ready, In Progress, and Backlog tasks while excluding Deferred', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-ready', '🗂️ Ready'),
      makeAggregate('task-deferred', '⏸️ Deferred'),
      makeAggregate('task-backlog', '🔲 Backlog'),
      makeAggregate('task-in-progress', '🔄 In Progress'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const ids = res.body.map((t: { taskId: string }) => t.taskId);
    expect(ids).toContain('task-ready');
    expect(ids).toContain('task-in-progress');
    expect(ids).toContain('task-backlog');
    expect(ids).not.toContain('task-deferred');
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await supertest(buildApp()).get('/api/tasks/active');
    expect(res.status).toBe(400);
  });

  it('returns 404 when project is not found', async () => {
    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=unknown',
    );
    expect(res.status).toBe(404);
  });
});

// ── totalTokens aggregation ────────────────────────────────────────────────────

describe('buildTaskViewFromRow — totalTokens', () => {
  it('sums code and review session tokens into totalTokens', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-tokens', '🔄 In Progress', {
        code_session_id: 'cs-1',
        code_session_status: 'done',
        code_session_started_at: 1000,
        code_session_input_tokens: 400,
        code_session_output_tokens: 200,
        review_session_id: 'rs-1',
        review_session_status: 'done',
        review_session_input_tokens: 100,
        review_session_output_tokens: 50,
      }),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.find(
      (t: { taskId: string }) => t.taskId === 'task-tokens',
    );
    expect(task.totalTokens.input).toBe(500);
    expect(task.totalTokens.output).toBe(250);
  });

  it('totalTokens counts only code session when review is absent', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-code-only', '🔄 In Progress', {
        code_session_id: 'cs-2',
        code_session_status: 'done',
        code_session_started_at: 1000,
        code_session_input_tokens: 300,
        code_session_output_tokens: 150,
        review_session_id: null,
        review_session_input_tokens: null,
        review_session_output_tokens: null,
      }),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.find(
      (t: { taskId: string }) => t.taskId === 'task-code-only',
    );
    expect(task.totalTokens.input).toBe(300);
    expect(task.totalTokens.output).toBe(150);
  });

  it('review.inputTokens and review.outputTokens are populated from row', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-review-tokens', '🔍 In Review', {
        review_session_id: 'rs-2',
        review_session_status: 'done',
        review_session_input_tokens: 80,
        review_session_output_tokens: 40,
      }),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.find(
      (t: { taskId: string }) => t.taskId === 'task-review-tokens',
    );
    expect(task.review.inputTokens).toBe(80);
    expect(task.review.outputTokens).toBe(40);
  });
});

// ── GET /api/tasks/export?format=yaml ─────────────────────────────────────────

describe('GET /api/tasks/export?format=yaml', () => {
  const boardTasks = [
    {
      id: 'task-a',
      title: 'Task A',
      status: '🗂️ Ready',
      type: '💻 Code',
      priority: '🔴 High',
      dependsOn: [],
      notionUrl: 'https://notion.so/task-a',
    },
    {
      id: 'task-b',
      title: 'Task B',
      status: '⏭️ Deferred',
      type: '💻 Code',
      priority: '🟡 Medium',
      dependsOn: [],
      notionUrl: 'https://notion.so/task-b',
    },
  ];

  beforeEach(() =>
=======
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

### `packages/backend/src/routes/tasks.ts`
```
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getProjectById } from '../config';
import { ProjectService } from '../projects/ProjectService';
import {
  getTaskCache,
  getActiveTaskAggregates,
  getSetting,
} from '../db/queries';
import type { TaskAggregateRow } from '../db/queries';
import { deriveDisplayStatus } from '../tasks/TaskStatusEngine';
import type { NotionTask } from '../notion/types';
import { DependencyResolver } from '../notion/DependencyResolver';
import type { PRReviewResult } from '../github/PRReviewService';
import type { ServerMessage, TaskView } from '../ws/types';
import type { PauseReason } from '../db/types';
import yaml from 'js-yaml';
export type { TaskView } from '../ws/types';

/**
 * The frontend sends milestone row ids as `boardId` after the milestone schema migration.
 * Resolve to the milestone's `source_id` (the Notion database id) for cache key lookup.
 * Falls back to the input value when no matching milestone exists (back-compat for callers
 * that still pass a raw source_id).
 */
function resolveBoardCacheKey(boardId: string): string {
  const milestone = ProjectService.getMilestone(boardId);
  if (milestone?.sourceId) return milestone.sourceId;
  return boardId;
}

const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

function getReviewIterationCap(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_REVIEW_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_REVIEW_ITERATIONS;
}

// ── Broadcast infrastructure ─────────────────────────────────────────────────
let taskBroadcastFn: ((msg: ServerMessage) => void) | null = null;

export function setTaskBroadcast(fn: (msg: ServerMessage) => void): void {
  taskBroadcastFn = fn;
}

/** Build a TaskView for a single notionTaskId and broadcast it as task_updated. */
export function emitTaskUpdated(notionTaskId: string): void {
  if (!taskBroadcastFn) return;
  const task = buildTaskView(notionTaskId);
  if (task) taskBroadcastFn({ type: 'task_updated', task });
}

/** Build a TaskView for a single notionTaskId from current DB state. Returns null if not found. */
export function buildTaskView(notionTaskId: string): TaskView | null {
  const rows = getActiveTaskAggregates([notionTaskId]);
  if (rows.length === 0) return null;
  return buildTaskViewFromRow(rows[0], getReviewIterationCap());
}

// ── Row → TaskView mapping ───────────────────────────────────────────────────

function buildTaskViewFromRow(row: TaskAggregateRow, cap: number): TaskView {
  let notionTask: NotionTask | null = null;
  try {
    notionTask = JSON.parse(row.raw_json) as NotionTask;
  } catch {
    // leave as null
  }

  const notionStatus = notionTask?.status ?? '';
  const priority = notionTask?.priority ?? '';

  let codeSession: TaskView['codeSession'] = null;
  if (row.code_session_id) {
    const lastMessage = row.code_session_last_event_payload
      ? summarizeEvent(row.code_session_last_event_payload)
      : '';
    codeSession = {
      sessionId: row.code_session_id,
      status: row.code_session_status ?? '',
      startedAt: row.code_session_started_at ?? 0,
      endedAt: row.code_session_ended_at ?? null,
      lastMessage,
      inputTokens: row.code_session_input_tokens ?? 0,
      outputTokens: row.code_session_output_tokens ?? 0,
    };
  }

  let pr: TaskView['pr'] = null;
  if (row.pr_number != null && row.pr_url) {
    pr = {
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      title: row.pr_title ?? '',
      headBranch: row.pr_head_branch ?? '',
      baseBranch: row.pr_base_branch ?? '',
      state: row.pr_state ?? '',
      draft: row.pr_draft === 1,
      mergeState: row.pr_merge_state ?? null,
    };
  }

  let review: TaskView['review'] = null;
  let reviewVerdict: string | null = null;
  let reviewSummary: string | null = null;
  if (row.review_session_id) {
    // Prefer PR-level review result (GitHub flow); fall back to session-level (local-only).
    const rawReviewResult = row.pr_review_result ?? row.review_session_result;
    if (rawReviewResult) {
      try {
        const result = JSON.parse(rawReviewResult) as PRReviewResult;
        reviewVerdict = result.verdict ?? null;
        reviewSummary = result.summary ?? null;
      } catch {
        // ignore
      }
    }
    review = {
      sessionId: row.review_session_id,
      status: row.review_session_status ?? '',
      verdict: reviewVerdict,
      summary: reviewSummary,
      iterationCount: row.pr_review_iteration ?? 0,
      inputTokens: row.review_session_input_tokens ?? 0,
      outputTokens: row.review_session_output_tokens ?? 0,
    };
  }

  const pauseReason = (row.pr_pause_reason ?? null) as PauseReason | null;

  const displayStatus = deriveDisplayStatus({
    notionStatus,
    codeSessionStatus: row.code_session_status ?? null,
    prState: row.pr_state ?? null,
    prDraft: row.pr_draft === 1,
    reviewVerdict,
    reviewIterationCount: row.pr_review_iteration ?? 0,
    reviewIterationCap: cap,
    pauseReason,
  });

  const totalTokens = {
    input:
      (row.code_session_input_tokens ?? 0) +
      (row.review_session_input_tokens ?? 0),
    output:
      (row.code_session_output_tokens ?? 0) +
      (row.review_session_output_tokens ?? 0),
  };

  return {
    taskId: row.task_id,
    taskName: notionTask?.title ?? row.task_id,
    notionStatus,
    displayStatus,
    pauseReason,
    priority,
    notionUrl: notionTask?.notionUrl ?? '',
    taskType: notionTask?.type ?? '',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession,
    pr,
    review,
    totalTokens,
  };
}

const TOOL_MAX = 80;

function extractToolArg(name: string, input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      const p = str(input.file_path);
      return p ? (p.replace(/\\/g, '/').split('/').pop() ?? p) : '';
    }
    case 'Bash':
      return str(input.command).trim().split(/\s+/)[0] ?? '';
    case 'Grep':
      return str(input.pattern);
    case 'Glob':
      return str(input.pattern);
    case 'Agent':
      return str(input.description);
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
      return str(input.query);
    default:
      return '';
  }
}

function formatToolCall(name: string, input: unknown): string {
  const inputObj =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const arg = extractToolArg(name, inputObj);
  const label = arg ? `${name}(${arg})` : name;
  return label.length > TOOL_MAX ? label.slice(0, TOOL_MAX - 1) + '…' : label;
}

/** Extract a brief human-readable summary from a raw session event payload (max 120 chars). */
export function summarizeEvent(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload.slice(0, 120);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return String(parsed).slice(0, 120);
  }

  const p = parsed as Record<string, unknown>;

  // Assistant text event: { type: 'assistant', message: { content: [...] } }
  const msg = p.message as Record<string, unknown> | undefined;
  const content = msg?.content ?? p.content;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (
        b.type === 'text' &&
        typeof b.text === 'string' &&
        b.text.trim().length > 0
      ) {
        const text = b.text.trim().replace(/\s+/g, ' ');
        return text.length > 120 ? text.slice(0, 117) + '…' : text;
      }
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        return formatToolCall(b.name, b.input);
      }
    }
  }

  if (typeof cont
>>>>>>> bcc354b (chore: apply autofix [orchestrator])
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