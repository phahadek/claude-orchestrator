# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Fix: dependency waves and blocked-by badges silently broken — task.dependsOn never prefixed alongside task.id
- **Notion task**: https://www.notion.so/Fix-dependency-waves-and-blocked-by-badges-silently-broken-task-dependsOn-never-prefixed-alongsid-36e22f9152f38134b587c71397fd7cdf
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\16b0622f-dda3-4023-8709-7c79e042c039`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\16b0622f-dda3-4023-8709-7c79e042c039`).

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
The dashboard's wave-grouping and blocked-by badges are silently broken across all milestones. The Ready section in the task list collapses every task into a single "Wave 1", and no ↳ blocked by: ... annotation appears on any task card, even when Depends On clearly references a non-Done task.
The protection mechanisms ARE in place — they just receive malformed data inside /api/tasks/active. AutoLauncher's launch-blocking is NOT affected (the resolver run inside NotionClient.fetchReadyTasks operates on a stripped-prefix form via readBoardCache).
## Dependencies
- Fix: task panel empty for all milestones — board cache JSON still carries raw task IDs after D3 (Done — PR #411) — this fix introduced the regression for the Notion path.
- Fix: NotionTaskBackend double-prefixes task IDs on cache-hit (Done — commit c8ac261) — partially mitigated the round-trip but only for id, not for dependsOn.
## Context
### Symptoms (observed)
- In the dashboard's Ready section, every task appears under a single "Wave 1 (N)" header. No "Wave 2", "Wave 3" subsections exist even on milestones where multiple tasks have Depends On pointing at non-Done tasks.
- No ↳ blocked by: ... annotation appears on any task card (CompactTaskCard.tsx:73).
- The milestone-progress popover's <WaveView /> shows a single wave containing every non-Done non-Deferred task.
### Root cause
After PR #411, NotionTaskBackend.fetchReadyTasks prefixes each task's id (notion:<raw-uuid>) before writing to the board cache and returning. This was correct for the original goal (fixing the /api/tasks/active JOIN).
But task.dependsOn is never prefixed. It is parsed from the Notion Depends On rich-text field as raw page IDs by NotionClient.parseDependsOn (NotionClient.ts:207-209) and flows through untouched.
DependencyResolver.resolve (DependencyResolver.ts:14-30) builds its lookup map like this:
```typescript
const byId = new Map(tasks.map((t) => [stripHyphens(t.id), t]));
// After PR #411: byId key = "notion:abc1234567890abcdef"

const dep = byId.get(stripHyphens(depId));
// depId from Depends On field: "abc-1234-5678-90ab-cdef"
// stripHyphens(depId)        : "abc1234567890abcdef"  (no "notion:" prefix)
// → byId.get() returns undefined
```
Every dep lookup returns undefined. The resolver then silently treats every dependency as satisfied:
- computeWave line 51: if (!dep || dep.status === '✅ Done') continue; → maxDepWave stays 0 → every task gets wave = 1.
- findBlockers line 73: if (!dep) continue; → blockers list always empty → every task gets blocked: false.
Both downstream consumers (view.wave, view.blocked in routes/tasks.ts:429-431) receive these wrong values. Frontend renders accordingly.
### Why AutoLauncher's launch-blocking is unaffected
AutoLauncher consumes resolved.blocked from TaskBackend.fetchReadyTasks → NotionClient.fetchReadyTasks. On the cache-hit path, NotionClient.fetchReadyTasks reads through readBoardCache (NotionClient.ts:131-146), which strips the notion: prefix from id back to raw before returning. The resolver inside NotionClient.fetchReadyTasks thus receives raw id + raw dependsOn (consistent) and computes blocked/wave correctly. AutoLauncher gets the correct values.
The bug only manifests where the board cache is parsed DIRECTLY (bypassing readBoardCache) — which is routes/tasks.ts:404 and the resolver call at routes/tasks.ts:423-424.
### Scope spans three backends, not one
board:${milestoneId} cache is written by all three task backends using the same dual-writer pattern:
- NotionTaskBackend.ts:60-63 (active in production today)
- JiraTaskSourceProvider.ts:83-86 (no production projects today)
- LocalTaskBackend.ts:212-215 (no production projects today)
All three write {id: "<source>:<raw>", dependsOn: ["<raw>", ...]}. All three are read by routes/tasks.ts:404 via the same direct JSON.parse, which then runs DependencyResolver — same broken-byId-vs-broken-depId mismatch regardless of source. Jira and Yaml backends have the identical bug latent today; it will manifest the moment a project uses them.
The non-milestone route (routes/tasks.ts:336-373) does NOT run the resolver — non-milestone tasks render as a flat list with no wave/blocked awareness — so it is unaffected.
## Approach (locked)
Prefix dependsOn alongside id at each task backend's boundary, and update NotionClient.readBoardCache to strip the prefix from dependsOn on read just like it already does for id.
The invariant becomes: cached task entries are prefixed across all ID-shaped fields (id AND dependsOn); in-memory entries returned from <Backend>.fetchReadyTasks are prefixed-everywhere; entries returned from NotionClient.fetchReadyTasks (the source-of-truth fetcher, internal to NotionClient) are raw-everywhere. The resolver continues to operate on raw IDs internally; the boundary is what does the translation.
### Concrete changes
1. packages/backend/src/tasks/NotionTaskBackend.ts — fetchReadyTasks and fetchNonMilestoneReadyTasks:
1. packages/backend/src/tasks/JiraTaskSourceProvider.ts — fetchReadyTasks (and any equivalent non-milestone method):
1. packages/backend/src/tasks/LocalTaskBackend.ts — fetchReadyTasks (and fetchNonMilestoneReadyTasks):
1. packages/backend/src/notion/NotionClient.ts — readBoardCache:
1. No changes to DependencyResolver.ts. The resolver stays source-agnostic and operates on whatever IDs it receives — the prefix-or-raw decision lives at the boundary.
1. No changes to routes/tasks.ts. After the fix, the route's direct JSON.parse of boardCacheRow.raw_json sees the prefixed-everywhere shape, so the resolver run there matches both sides.
### No cache migration
Existing pre-fix board cache rows will have prefixed id but raw dependsOn. The new readBoardCache (extended to strip from dependsOn) will see t.dependsOn entries that do not start with notion: and leave them alone — safe. The next cache refresh (TTL: 10 minutes per TASK_PAGE_CACHE_TTL_MS) will overwrite the row with the prefixed-everywhere shape. No proactive migration needed.
### Why this shape over in-resolver normalization
- Keeps the resolver source-agnostic. Pushing normalization into the resolver would require it to know about source-specific prefixes (notion:, jira:, yaml:) or to invent a generic strip rule that risks over-stripping IDs that legitimately contain colons.
- Maintains the invariant established by PR #411: "all task IDs flowing past the backend boundary are prefixed." Extending the same rule to dependsOn is the consistent next step.
- Localizes the rule at one seam per backend instead of pushing "did I remember to strip?" into every consumer.
## Acceptance criteria
### 🤖 Automated tests
All tests follow the existing vitest + module-mock pattern. No real Notion/Jira API, no real file system, no real git.
1. NotionTaskBackend.test.ts (new or extended): fetchReadyTasks returns tasks where every dependsOn entry is prefixed with notion:.
1. NotionTaskBackend.test.ts: fetchReadyTasks writes the board cache and per-task cache with the prefixed-everywhere shape (both id and dependsOn entries prefixed). Same assertion for fetchNonMilestoneReadyTasks.
1. JiraTaskSourceProvider.test.ts (new or extended): equivalent assertions for the jira: prefix.
1. LocalTaskBackend.test.ts (new or extended): equivalent assertions for the yaml: prefix.
1. NotionClient.test.ts (extended): readBoardCache strips the notion: prefix from each dependsOn entry as well as from id. Covers the cache-hit path of NotionClient.fetchReadyTasks.
1. routes/tasks.test.ts or tasks.test.ts: /api/tasks/active integration-style test (existing pattern via in-memory SQLite, mocked deps) where the board cache contains a 3-task chain A ← B ← C with A Done and B, C Ready. Response must show B at wave: 1, blocked: false; C at wave: 2, blocked: true, blockerNames: ['B']. Same assertions for a jira:-keyed cache and a yaml:-keyed cache to lock in cross-backend behavior.
1. Existing tests continue to pass: DependencyResolver.test.ts (unchanged — resolver behavior is preserved), taskCacheConventions.test.ts, migrations.taskCacheCleanup.test.ts.
## Files / paths affected
- packages/backend/src/tasks/NotionTaskBackend.ts — prefix dependsOn in both fetchReadyTasks and fetchNonMilestoneReadyTasks.
- packages/backend/src/tasks/JiraTaskSourceProvider.ts — prefix dependsOn in fetchReadyTasks.
- packages/backend/src/tasks/LocalTaskBackend.ts — prefix dependsOn in fetchReadyTasks and fetchNonMilestoneReadyTasks.
- packages/backend/src/notion/NotionClient.ts — extend readBoardCache to strip prefix from dependsOn entries.
- Corresponding *.test.ts files (one new/extended per backend, plus NotionClient.test.ts and tasks.test.ts).
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

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
    const prefixed = tasks.map((r) => {
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
    // Overwrite board cache with prefixed IDs so /api/tasks/active joins correctly
    // against per-task rows (fixes post-D3 mismatch where raw IDs were stored).
    upsertTaskCache(
      `board:${milestone.sourceId}`,
      JSON.stringify(prefixed.map((r) => r.task)),
    );
    return prefixed;
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
    milestoneId: string | null,
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
    const prefixed = resolved.map((r) => ({
      ...r,
      task: { ...r.task, id: formatTaskId('jira', r.task.id) },
    }));
    // Overwrite board cache with prefixed IDs so /api/tasks/active joins correctly.
    if (milestoneId !== null) {
      upsertTaskCache(
        `board:${milestoneId}`,
        JSON.stringify(prefixed.map((r) => r.task)),
      );
    }
    return prefixed;
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
    }
    // Cache each task under its prefixed key
    for (const task of allTasks) {
      upsertTaskCache(formatTaskId('yaml', task.id), JSON.stringify(task));
    }
    const resolved = resolver.resolve(allTasks, 'yaml');
    // Prepend yaml: prefix to task IDs in returned results
    const prefixed = resolved.map((r) => ({
      ...r,
      task: { ...r.task, id: formatTaskId('yaml', r.task.id) },
    }));
    // Overwrite board cache with prefixed IDs so /api/tasks/active joins correctly.
    if (milestoneId !== null) {
      upsertTaskCache(
        `board:${milestoneId}`,
        JSON.stringify(prefixed.map((r) => r.task)),
      );
    }
    return prefixed;
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
      sections.p
[... truncated]
```

### `packages/backend/src/notion/NotionClient.ts`
```
import { config } from '../config';
import {
  upsertTaskCache,
  getCacheAge,
  getTaskCache,
  updateTaskCacheStatus,
} from '../db/queries';
import { NotionTask, NotionApiError, ResolvedTask } from './types';
import { DependencyResolver } from './DependencyResolver';
import { toExternalId } from '../tasks/taskId';

// ─── Board validation types ─────────────────────────────────────────────────

export interface DatabaseValidation {
  type: 'database';
  title: string;
  id: string;
}

export interface PageValidation {
  type: 'page';
  childDatabaseId: string | null;
  childDatabaseTitle: string | null;
}

export type BoardValidation = DatabaseValidation | PageValidation;

// ─── ID helpers ─────────────────────────────────────────────────────────────

function formatAsUuid(raw: string): string {
  const clean = raw.replace(/-/g, '');
  if (clean.length !== 32) return raw;
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

export function extractNotionId(input: string): string | null {
  const cleaned = input.split('?')[0].split('#')[0];
  const match = cleaned.match(
    /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i,
  );
  if (!match) return null;
  return match[1].replace(/-/g, '');
}

export function normalizeNotionId(input: string): string | null {
  const trimmed = input.trim();
  const raw = extractNotionId(trimmed);
  if (!raw) return null;
  return formatAsUuid(raw);
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TASK_PAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const NOTION_VERSION = '2022-06-28';
const resolver = new DependencyResolver();

// ─── NotionTaskPage — structured page body for review ──────────────────────

export interface NotionTaskPage {
  taskId: string;
  name: string;
  summarySection: string;
  contextSection: string;
  acceptanceCriteria: string;
  filesSection: string;
  rawMarkdown: string;
  /**
   * Per-task LOC budget from the Notion "Expected size" property, used as an
   * override of the global oversized-PR heuristic. Undefined when the property
   * is unset (most tasks fall back to the global heuristic).
   */
  expectedSize?: number;
}

// ─── Internal Notion API response shapes ───────────────────────────────────

interface NotionRichTextItem {
  text: { content: string };
}

interface NotionPage {
  id: string;
  url: string;
  properties: {
    'Task Name': { type: 'title'; title: NotionRichTextItem[] };
    Status: { type: 'select'; select: { name: string } | null };
    Type: { type: 'select'; select: { name: string } | null };
    Priority?: { type: 'select'; select: { name: string } | null };
    'Depends On': { type: 'rich_text'; rich_text: NotionRichTextItem[] };
    Notes: { type: 'rich_text'; rich_text: NotionRichTextItem[] };
    PR?: { type: 'url'; url: string | null };
    'Expected size'?: { type: 'number'; number: number | null };
    [key: string]: unknown;
  };
}

interface NotionQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionDatabaseResponse {
  id: string;
  object: string;
  title: Array<{ plain_text?: string; text?: { content: string } }>;
}

interface NotionChildBlock {
  id: string;
  type: string;
  child_database?: { title: string };
}

interface NotionBlocksChildrenResponse {
  results: NotionChildBlock[];
}

// ─── Cache helpers ──────────────────────────────────────────────────────────

// Board-level cache uses a sentinel key so the full result can be stored
// without requiring a board_id column on task_cache.
function boardCacheKey(boardId: string): string {
  return `board:${boardId}`;
}

function isBoardCacheFresh(boardId: string): boolean {
  return getCacheAge(boardCacheKey(boardId)) < CACHE_TTL_MS;
}

function readBoardCache(boardId: string): NotionTask[] | null {
  const row = getTaskCache(boardCacheKey(boardId));
  if (!row) return null;
  try {
    const tasks = JSON.parse(row.raw_json) as NotionTask[];
    // Strip notion: prefix if present — cache may store prefixed IDs (post-PR #411 write
    // convention). The contract of fetchReadyTasks is to return raw Notion page IDs so
    // NotionTaskBackend's formatTaskId call is the single point of prefixing.
    return tasks.map((t) => ({
      ...t,
      id: t.id.startsWith('notion:') ? t.id.slice('notion:'.length) : t.id,
    }));
  } catch {
    return null;
  }
}

function writeBoardCache(boardId: string, tasks: NotionTask[]): void {
  upsertTaskCache(boardCacheKey(boardId), JSON.stringify(tasks));
}

// ─── Notion API helpers ─────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.notionApiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `https://api.notion.com/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new NotionApiError(res.status, text);
  }

  return res.json() as Promise<T>;
}

// ─── Page mapper ────────────────────────────────────────────────────────────

/**
 * Parse the Depends On field into a list of task IDs.
 *
 * `|` is the canonical delimiter; `,` is accepted leniently because it's a
 * common authoring mistake that previously caused the whole field to be
 * silently treated as a single unparseable ID.
 */
export function parseDependsOn(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[|,]/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function mapPageToTask(page: NotionPage): NotionTask {
  const titleItems = page.properties['Task Name']?.title ?? [];
  const title = titleItems.map((t) => t.text.content).join('');

  const status = page.properties.Status?.select?.name ?? '';
  const type = page.properties.Type?.select?.name ?? '';
  const priority = page.properties['Priority']?.select?.name ?? '';

  const dependsOnRaw =
    page.properties['Depends On']?.rich_text?.[0]?.text?.content ?? '';
  const dependsOn = parseDependsOn(dependsOnRaw);

  const prUrl = page.properties['PR']?.url ?? undefined;

  return {
    id: page.id,
    title,
    status,
    type,
    dependsOn,
    notionUrl: page.url,
    prUrl,
    priority,
  };
}

// ─── Block helpers for fetchTaskPage ────────────────────────────────────────

interface NotionRichText {
  text?: { content: string };
  plain_text?: string;
}

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

function richTextToString(items: NotionRichText[]): string {
  return items.map((t) => t.plain_text ?? t.text?.content ?? '').join('');
}

function blockToLine(block: NotionBlock): string {
  const type = block.type as string;
  const inner = block[type] as
    | { rich_text?: NotionRichText[]; language?: string }
    | undefined;
  if (!inner) return '';
  const text = inner.rich_text ? richTextToString(inner.rich_text) : '';
  switch (type) {
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'code':
      return `\`\`\`${inner.language ?? ''}\n${text}\n\`\`\``;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'quote':
      return `> ${text}`;
    case 'callout':
      return `> ${text}`;
    case 'divider':
      return '---';
    default:
      return text;
  }
}

/**
 * Known top-level section keywords. A heading is considered a top-level
 * section boundary only when it matches one of these keyw
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