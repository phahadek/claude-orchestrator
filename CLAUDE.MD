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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\340c6ddf-449c-442d-b57e-1119b4b455a8`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\340c6ddf-449c-442d-b57e-1119b4b455a8`).

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