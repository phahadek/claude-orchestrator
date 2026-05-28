# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Fix: NotionTaskBackend double-prefixes task IDs on cache-hit — contaminates task_cache with notion:notion: entries
- **Notion task**: https://www.notion.so/Fix-NotionTaskBackend-double-prefixes-task-IDs-on-cache-hit-contaminates-task_cache-with-notion-n-36e22f9152f3818ab500e17b43d1b61b
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\a2a04836-3273-406f-a6a8-cfeac73505f6`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\a2a04836-3273-406f-a6a8-cfeac73505f6`).

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
NotionTaskBackend.fetchReadyTasks always calls formatTaskId('notion', r.task.id) on every task returned by NotionClient.fetchReadyTasks. After PR #411 made the board cache store prefixed IDs, the cache-hit path returns tasks whose id field is ALREADY notion:<id> — so formatTaskId produces notion:notion:<id> (double-prefix). The double-prefixed IDs then get written back to per-task and board cache rows. The bug self-amplifies on every cache-hit cycle. Today (2026-05-28) there are already 210 contaminated task_cache rows. Add a 'strip-if-already-prefixed' step OR have NotionClient.readBoardCache strip the prefix before returning.
## Dependencies
None. Single-file fix in NotionTaskBackend.ts (plus a one-shot cleanup of contaminated rows).
## Context
### Observed incident (2026-05-28)
After PR cc36fc9 (dashed/dashless fix) shipped + restart, the user reported the Tasks panel detail pane was still showing empty state for 100% of tasks (across both projects, all statuses, after hard refresh).
Browser console showed:
```javascript
[TaskDetail] selectedTaskId "notion:notion:36b22f91-52f3-817a-a8fb-d7aeeceb279d" not found in taskViews (50 tasks). Possible state drift.
[TaskDetail] selectedTaskId "notion:36b22f91-52f3-81e4-93af-d483646bb3bb" not found in taskViews (60 tasks). Possible state drift.
```
DB inspection:
```javascript
=== task_cache with double-prefix ===
count: 210
  notion:notion:36d22f91-52f3-8121-9dce-d6993942354b
  notion:notion:36d22f91-52f3-81ed-8d66-f4c5aef9de16
  notion:notion:36d22f91-52f3-815f-929b-f954dbafb9a5
```
### Root cause walk-through
NotionTaskBackend.ts:40-65 (current code post-#411):
```typescript
const tasks = await this.client.fetchReadyTasks(milestone.sourceId, skipCache);
const prefixed = tasks.map((r) => {
  const prefixedId = formatTaskId('notion', r.task.id);  // 👈 unconditional prefix
  upsertTaskCache(prefixedId, JSON.stringify({ ...r.task, id: prefixedId }));
  return { ...r, task: { ...r.task, id: prefixedId }, source: 'notion' as const };
});
upsertTaskCache(
  `board:${milestone.sourceId}`,
  JSON.stringify(prefixed.map((r) => r.task)),
);
```
NotionClient.fetchReadyTasks returns from either:
- Cache miss path: fetches from Notion API, calls writeBoardCache(tasks) with RAW id fields (page.id from Notion API — a bare dashed UUID), returns resolver.resolve(tasks) with raw IDs. NotionTaskBackend's prefix here is correct: raw → notion:<id>.
- Cache hit path: readBoardCache(boardId) reads the previously-written board cache. After PR #411, that cache contains PREFIXED IDs (notion:<id>). Returns resolver.resolve(cached) with prefixed IDs. NotionTaskBackend's prefix re-prefixes: notion:<id> → notion:notion:<id>.
The re-write at line 60-63 then writes back to task_cache with double-prefixed IDs. Every per-task upsertTaskCache(prefixedId, ...) call at line 48 also writes a double-prefixed key. This pollutes the cache, AND on the next cache-hit cycle, IDs get triple-prefixed (since the source already has notion:notion:<id>), and so on. The bug is recursive.
Why the original PR #411 missed this: the fix's tests covered the cache-write side of the post-D3 mismatch but not the cache-hit shape invariant on r.task.id.
### What changes
Recommended fix: have the layer that owns the cache shape (NotionClient) strip the prefix before returning from readBoardCache. The cache is internal to NotionClient; the outside contract is "NotionClient.fetchReadyTasks returns tasks with raw IDs." NotionTaskBackend is the source-aware layer that adds the prefix — exactly once. This makes the prefix invariant single-sourced.
packages/backend/src/notion/NotionClient.ts:readBoardCache (or equivalent location):
```typescript
function readBoardCache(boardId: string): NotionTask[] | null {
  const row = getTaskCache(`board:${boardId}`);
  if (!row) return null;
  const tasks = JSON.parse(row.raw_json) as NotionTask[];
  // Cache may contain prefixed IDs (post-PR #411 write convention). The contract
  // of fetchReadyTasks is to return raw Notion page IDs; strip the prefix here
  // so NotionTaskBackend's formatTaskId call is the single point of prefixing.
  return tasks.map((t) => ({
    ...t,
    id: t.id.startsWith('notion:') ? t.id.slice('notion:'.length) : t.id,
  }));
}
```
Alternative (also acceptable): make NotionTaskBackend.fetchReadyTasks detect already-prefixed IDs and skip re-prefixing. Less clean (relies on string sniffing in two layers) but smaller diff.
### One-shot DB cleanup (also in this PR's migration)
```sql
-- Delete double-prefixed per-task cache rows. They'll be re-fetched fresh on the next call.
DELETE FROM task_cache WHERE task_id LIKE 'notion:notion:%';

-- Strip double-prefix from any tasks embedded in board-cache JSON, in case the row was re-written.
-- The next fetchReadyTasks call will overwrite anyway, but this prevents the route from serving
-- stale double-prefixed IDs in the window between migration and next fetch.
UPDATE task_cache
SET raw_json = REPLACE(raw_json, '"id":"notion:notion:', '"id":"notion:')
WHERE task_id LIKE 'board:%' AND raw_json LIKE '%notion:notion:%';
```
### Out of scope
- The merge-into-taskViews logic that causes the UI to drop matches when an ID is double-prefixed (the UI is correct — it's just propagating bad data). Once the cache is clean, the UI behaves correctly.
- Adding a defensive assert(!id.startsWith('notion:notion:')) in formatTaskId — worth considering as a regression guard but out of immediate scope.
## Acceptance criteria
### 🤖 Automated tests
- tsc --noEmit passes for both packages.
- Unit test (NotionClient.readBoardCache): cache containing tasks with prefixed IDs returns tasks with RAW IDs (strip-on-read).
- Unit test (NotionTaskBackend.fetchReadyTasks): on a cache-hit path, the returned task IDs are notion:<dashed-uuid> (single prefix), not notion:notion:<...>.
- Unit test (NotionTaskBackend.fetchReadyTasks): calling fetchReadyTasks twice in succession (first cache-miss, second cache-hit) produces identical task IDs. Regression test for the recursive amplification.
- Migration test: a DB seeded with double-prefixed task_cache rows is cleaned by the migration; running the migration twice is a no-op.
- Migration test: board-cache rows with double-prefixed embedded JSON are repaired.
- Integration test: after the fix, /api/tasks/active returns task IDs in notion:<dashed-uuid> form (no notion:notion: anywhere in the response).
## Files / paths affected
- packages/backend/src/notion/NotionClient.ts (update — readBoardCache strips prefix before returning)
- packages/backend/src/db/schema.ts (update — one-shot cleanup migration for the 210 contaminated rows)
- packages/backend/src/notion/NotionClient.test.ts (update — cache-shape tests)
- packages/backend/src/__tests__/taskCacheConventions.test.ts (update — add the recursive-amplification regression case)
- packages/backend/src/__tests__/migrations.taskCacheCleanup.test.ts (new)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

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
    return JSON.parse(row.raw_json) as NotionTask[];
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
 * section boundary only when it matches one of these keywords. Sub-headings
 * like "### 🤖 Automated tests" that do not match any keyword are treated as
 * content within the current section.
 */
export const TOP_LEVEL_SECTIONS = [
  'summary',
  'dependencies',
  'context',
  'acceptance criteria',
  'files',
  'implementation notes',
  'expected size',
];

/** Extract the text content of a named heading section from a markdown string. */
expo
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

### `packages/backend/src/notion/NotionClient.test.ts`
```
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Stub modules with side effects so NotionClient.ts can be imported without
// a real database connection or environment variables.
vi.mock('../config', () => ({
  config: { notionApiKey: 'test', notionDatabaseId: 'test', port: 3000 },
}));
vi.mock('../db/queries', () => ({
  upsertTaskCache: vi.fn(),
  getCacheAge: vi.fn(() => Infinity),
  getTaskCache: vi.fn(() => null),
  updateTaskCacheStatus: vi.fn(),
}));

import {
  parseSection,
  parseDependsOn,
  parseExpectedSize,
  NotionClient,
} from './NotionClient';
import { updateTaskCacheStatus } from '../db/queries';

const source = fs.readFileSync(
  path.join(__dirname, 'NotionClient.ts'),
  'utf-8',
);

describe('NotionClient.fetchReadyTasks() — Notion query filter', () => {
  it('excludes only Deferred tasks (does_not_equal) so Done tasks are included', () => {
    expect(source).toMatch(/does_not_equal.*Deferred|Deferred.*does_not_equal/);
  });

  it('does not restrict to a hard-coded allowlist of statuses (no or-filter with equals)', () => {
    // The old filter used { or: [{ select: { equals: '...' } }, ...] }.
    // The new filter must not have this pattern — it should use does_not_equal instead.
    expect(source).not.toMatch(/select:\s*\{\s*equals:\s*['"]🗂️ Ready['"]/);
    expect(source).not.toMatch(/select:\s*\{\s*equals:\s*['"]✅ Done['"]/);
  });
});

// ─── parseSection unit tests ──────────────────────────────────────────────────

const SAMPLE_MD = `
## Summary

This is the summary.

## Context

Some context here.

## Acceptance Criteria

- Do the thing

### 🤖 Automated tests

- test A
- test B

### 👁️ Manual verification

- check X

## Files / paths affected

- src/foo.ts

## Implementation Notes

Details here.
`.trim();

describe('parseSection()', () => {
  it('captures acceptance criteria including sub-headings', () => {
    const result = parseSection(SAMPLE_MD, 'acceptance criteria');
    expect(result).toContain('🤖 Automated tests');
    expect(result).toContain('👁️ Manual verification');
    expect(result).toContain('test A');
    expect(result).toContain('check X');
  });

  it('stops before the next top-level section (Files)', () => {
    const result = parseSection(SAMPLE_MD, 'acceptance criteria');
    expect(result).not.toContain('src/foo.ts');
    expect(result).not.toContain('paths affected');
  });

  it('returns only summary content (no regression)', () => {
    const result = parseSection(SAMPLE_MD, 'summary');
    expect(result).toBe('This is the summary.');
    expect(result).not.toContain('context');
    expect(result).not.toContain('acceptance');
  });

  it('returns only context content (no regression)', () => {
    const result = parseSection(SAMPLE_MD, 'context');
    expect(result).toBe('Some context here.');
    expect(result).not.toContain('acceptance');
  });

  it('returns only files content (no regression)', () => {
    const result = parseSection(SAMPLE_MD, 'files');
    expect(result).toContain('src/foo.ts');
    expect(result).not.toContain('Implementation Notes');
  });
});

// ─── parseDependsOn unit tests ───────────────────────────────────────────────

describe('parseDependsOn()', () => {
  it('splits a pipe-delimited list (canonical)', () => {
    expect(parseDependsOn('abc123|def456')).toEqual(['abc123', 'def456']);
  });

  it('splits a comma-delimited list (accepted leniently)', () => {
    expect(parseDependsOn('abc123,def456')).toEqual(['abc123', 'def456']);
  });

  it('splits a mixed pipe/comma list', () => {
    expect(parseDependsOn('abc123|def456,ghi789')).toEqual([
      'abc123',
      'def456',
      'ghi789',
    ]);
  });

  it('trims whitespace around delimiters', () => {
    expect(parseDependsOn(' abc123 | def456 , ghi789 ')).toEqual([
      'abc123',
      'def456',
      'ghi789',
    ]);
  });

  it('resolves a single ID with no delimiter to one entry', () => {
    expect(parseDependsOn('abc123')).toEqual(['abc123']);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseDependsOn('')).toEqual([]);
  });

  it('drops empty segments produced by stray delimiters', () => {
    expect(parseDependsOn('abc123,,def456|')).toEqual(['abc123', 'def456']);
  });
});

// ─── parseExpectedSize unit tests ────────────────────────────────────────────

describe('parseExpectedSize()', () => {
  it('returns undefined when the section is absent', () => {
    expect(parseExpectedSize(SAMPLE_MD)).toBeUndefined();
  });

  it('returns the numeric value from a top-level Expected size section', () => {
    const md = `## Expected size\n1500\n\n## Summary\nbody`;
    expect(parseExpectedSize(md)).toBe(1500);
  });

  it('does not bleed into adjacent sections when Summary follows', () => {
    const md = `## Expected size\n1500\n\n## Summary\nThis is the summary.`;
    expect(parseSection(md, 'summary')).toBe('This is the summary.');
    expect(parseSection(md, 'expected size')).toBe('1500');
  });

  it('ignores zero/negative values (treated as unset)', () => {
    expect(parseExpectedSize(`## Expected size\n0\n`)).toBeUndefined();
    expect(parseExpectedSize(`## Expected size\n-100\n`)).toBeUndefined();
  });

  it('returns undefined when the section is empty or non-numeric', () => {
    expect(
      parseExpectedSize(`## Expected size\n\n## Summary\nx`),
    ).toBeUndefined();
    expect(parseExpectedSize(`## Expected size\nlarge\n`)).toBeUndefined();
  });
});

// ─── NotionClient prefix-stripping tests ─────────────────────────────────────

describe('NotionClient — prefix stripping in public methods', () => {
  let client: NotionClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(updateTaskCacheStatus).mockReset();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    client = new NotionClient();
  });

  it('updateStatus calls Notion API at /pages/abc (not /pages/notion:abc)', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await client.updateStatus('notion:abc', '✅ Done');

    const [url] = fetchSpy.mock.calls[0] as [string, unknown];
    expect(url).toContain('/pages/abc');
    expect(url).not.toContain('notion:abc');
  });

  it('updateStatus updates task_cache keyed notion:abc (not abc)', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await client.updateStatus('notion:abc', '✅ Done');

    expect(vi.mocked(updateTaskCacheStatus)).toHaveBeenCalledWith(
      'notion:abc',
      '✅ Done',
    );
    expect(vi.mocked(updateTaskCacheStatus)).not.toHaveBeenCalledWith(
      'abc',
      expect.anything(),
    );
  });

  it('fetchTaskPage calls Notion API at /pages/abc (not /pages/notion:abc)', async () => {
    const mockPage = {
      id: 'abc',
      url: 'https://notion.so/abc',
      properties: {
        'Task Name': { type: 'title', title: [{ text: { content: 'Test' } }] },
        Status: { type: 'select', select: null },
        Type: { type: 'select', select: null },
        'Depends On': { type: 'rich_text', rich_text: [] },
        Notes: { type: 'rich_text', rich_text: [] },
      },
    };
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => mockPage })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [], has_more: false, next_cursor: null }),
      });

    await client.fetchTaskPage('notion:abc');

    const firstUrl = fetchSpy.mock.calls[0][0] as string;
    expect(firstUrl).toContain('/pages/abc');
    expect(firstUrl).not.toContain('notion:abc');
  });
});

```

### `packages/backend/src/__tests__/taskCacheConventions.test.ts`
```
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── In-memory SQLite (tables required by module-level db.prepare() in queries.ts) ──
vi.mock('../db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      task_id             TEXT,
      task_url            TEXT,
      project_context_url TEXT,
      status              TEXT    NOT NULL DEFAULT 'running',
      started_at          INTEGER NOT NULL DEFAULT 0,
      ended_at            INTEGER,
      pr_url              TEXT,
      worktree_path       TEXT,
      archived            INTEGER NOT NULL DEFAULT 0,
      project_id          TEXT,
      session_type        TEXT    NOT NULL DEFAULT 'standard',
      favorited           INTEGER NOT NULL DEFAULT 0,
      note                TEXT,
      tags                TEXT,
      task_name           TEXT,
      model               TEXT,
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      review_result       TEXT,
      metadata            TEXT
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message_id   TEXT
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      tool_name       TEXT    NOT NULL,
      proposed_action TEXT,
      decision        TEXT    NOT NULL,
      rule_matched    TEXT,
      decided_at      INTEGER NOT NULL
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
      timestamp   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id    TEXT    PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json   TEXT    NOT NULL
    );
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
  `);
  return { db };
});

vi.mock('../config.js', () => ({
  config: { notionApiKey: 'test-key', port: 3000 },
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getMilestone: vi.fn(),
  },
}));

import os from 'os';
import fs from 'fs';
import path from 'path';
import { getTaskCache, upsertTaskCache } from '../db/queries.js';
import { NotionClient } from '../notion/NotionClient.js';
import { NotionTaskBackend } from '../tasks/NotionTaskBackend.js';
import { LocalTaskBackend } from '../tasks/LocalTaskBackend.js';
import { JiraTaskSourceProvider } from '../tasks/JiraTaskSourceProvider.js';
import type { JiraClient } from '../tasks/JiraClient.js';
import { ProjectService } from '../projects/ProjectService.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BOARD_ID = 'aabbccdd-1122-3344-5566-778899aabbcc';
const TASK_1 = '11111111-1111-1111-1111-111111111111';
const TASK_2 = '22222222-2222-2222-2222-222222222222';
const TASK_3 = '33333333-3333-3333-3333-333333333333';

function makeNotionQueryResponse(taskIds: string[]) {
  return {
    results: taskIds.map((id) => ({
      id,
      url: `https://notion.so/${id}`,
      properties: {
        'Task Name': {
          type: 'title',
          title: [{ text: { content: `Task ${id.slice(0, 4)}` } }],
        },
        Status: { type: 'select', select: { name: '🗂️ Ready' } },
        Type: { type: 'select', select: { name: '💻 Code' } },
        'Depends On': { type: 'rich_text', rich_text: [] },
        Notes: { type: 'rich_text', rich_text: [] },
      },
    })),
    has_more: false,
    next_cursor: null,
  };
}

function makeNotionPageResponse(id: string) {
  return {
    id,
    url: `https://notion.so/${id}`,
    properties: {
      'Task Name': {
        type: 'title',
        title: [{ text: { content: 'Test Task' } }],
      },
      Status: { type: 'select', select: { name: '🗂️ Ready' } },
      Type: { type: 'select', select: { name: '💻 Code' } },
      'Depends On': { type: 'rich_text', rich_text: [] },
      Notes: { type: 'rich_text', rich_text: [] },
      'Expected size': { type: 'number', number: null },
    },
  };
}

beforeEach(async () => {
  const { db } = await import('../db/db.js');
  db.prepare('DELETE FROM task_cache').run();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── getTaskCache: exact-match only, no dashless/dashed fallback ──────────────

describe('getTaskCache — no UUID format fallback', () => {
  it('returns the row for an exact prefixed key match', () => {
    upsertTaskCache('notion:abc', '{"id":"notion:abc"}');
    const row = getTaskCache('notion:abc');
    expect(row).toBeDefined();
    expect(row!.task_id).toBe('notion:abc');
  });

  it('returns undefined for a raw (unprefixed) key when only the prefixed row exists', () => {
    upsertTaskCache('notion:abc', '{"id":"notion:abc"}');
    expect(getTaskCache('abc')).toBeUndefined();
  });

  it('returns undefined for a dashed UUID when the dashless UUID is stored (no format normalization)', () => {
    const dashless = 'abcdef1234567890abcdef1234567890';
    upsertTaskCache(`notion:${dashless}`, '{}');
    const dashed = 'abcdef12-3456-7890-abcd-ef1234567890';
    expect(getTaskCache(dashed)).toBeUndefined();
  });
});

// ─── NotionTaskBackend.fetchReadyTasks: cache write shape ─────────────────────

describe('NotionTaskBackend.fetchReadyTasks — task_cache write shape', () => {
  it('writes exactly 4 rows: 3 notion:<id> + 1 board:<id>, no raw-UUID rows', async () => {
    vi.mocked(ProjectService.getMilestone).mockReturnValue({
      id: 'milestone-1',
      projectId: 'proj-1',
      name: 'M1',
      sourceId: BOARD_ID,
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeNotionQueryResponse([TASK_1, TASK_2, TASK_3]),
      }),
    );

    const backend = new NotionTaskBackend(new NotionClient());
    await backend.fetchReadyTasks('milestone-1');

    const { db } = await import('../db/db.js');
    const rows = db
      .prepare('SELECT task_id FROM task_cache ORDER BY task_id')
      .all() as { task_id: string }[];

    expect(rows).toHaveLength(4);

    const keys = rows.map((r) => r.task_id);
    expect(keys).toContain(`board:${BOARD_ID}`);
    expect(keys).toContain(`notion:${TASK_1}`);
    expect(keys).toContain(`notion:${TASK_2}`);
    expect(keys).toContain(`notion:${TASK_3}`);

    // No raw UUID keys (dashed or dashless)
    const rawDashedRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rawDashlessRe = /^[0-9a-f]{32}$/i;
    expect(keys.filter((k) => rawDashedRe.test(k))).toHaveLength(0);
    expect(keys.filter((k) => rawDashlessRe.test(k))).toHaveLength(0);
  });
});

// ─── NotionTaskBackend.fetchReadyTasks: board cache JSON has prefixed IDs ────────

describe('NotionTaskBackend.fetchReadyTasks — board cache JSON content', () => {
  it('board cache JSON contains prefixed 
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