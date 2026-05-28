# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Non-milestone tasks render with no wave or blocked-by awareness
- **Notion task**: https://www.notion.so/Non-milestone-tasks-render-with-no-wave-or-blocked-by-awareness-36e22f9152f381a0ac56de8c06e7d05b
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\7db42ba8-ac0c-494b-8d62-6d8ba2ca8713`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\7db42ba8-ac0c-494b-8d62-6d8ba2ca8713`).

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
The /api/tasks/non-milestone route (packages/backend/src/routes/tasks.ts:336-373) returns task views without ever running DependencyResolver. As a result, every non-milestone task is sent to the frontend with view.wave = 1 and view.blocked = false defaulted, regardless of what its Depends On field says.
The frontend already wave-groups non-milestone tasks (the TaskList component is shared with milestone views via App.tsx:347's __non_milestone__ board ID), so the visible effect is identical to the M6 milestone bug: every non-milestone task collapses into a single "Wave 1 (N)" group with no ↳ blocked by: … annotations.
AutoLauncher is NOT affected — it consumes the resolver output from fetchNonMilestoneReadyTasks directly, which runs the resolver inside NotionClient.fetchReadyTasks on freshly-fetched raw data. Only the UI rendering is broken.
## Dependencies
- Fix: dependency waves and blocked-by badges silently broken — task.dependsOn never prefixed alongside task.id (Ready) — must land first. After it lands, the non-milestone cache will hold the prefixed-everywhere shape, so the resolver wired in here receives consistent data without further prefix work.
## Context
### Where the gap is
routes/tasks.ts:336-373:
```typescript
const aggregates = getActiveTaskAggregates(taskIds);
const cap = getReviewIterationCap();
const views: TaskView[] = aggregates
  .map((row) => buildTaskViewFromRow(row, cap))
  .filter((v) => !v.notionStatus.includes('Deferred'));

res.json(views);   // ← view.wave=1, view.blocked=false defaulted on every view
```
Compare routes/tasks.ts:418-437 (/api/tasks/active), which after building views runs DependencyResolver over allBoardTasks and back-fills view.wave, view.blocked, view.blockerNames. The non-milestone handler is missing that block.
### Why AutoLauncher is unaffected
AutoLauncher.runOnceForProject calls fetchNonMilestoneReadyTasks (NotionTaskBackend.ts:80-109), which delegates to client.fetchReadyTasks(notionDatabaseId, skipCache=true). The resolver inside NotionClient.fetchReadyTasks runs on freshly-fetched raw data (consistent IDs throughout) and produces correct blocked / wave on each ResolvedTask. The launcher then checks resolved.blocked at AutoLauncher.ts:176 and correctly skips blocked tasks.
This is purely an HTTP-route bug: the route reads the cache directly and never wires the resolver in. Fixing it brings the UI into agreement with what the launcher already knows.
### Cross-database dependencies — explicitly out of scope
A non-milestone task's Depends On can technically reference any task ID, including milestone tasks in a different Notion database. Today, both AutoLauncher and (after this fix) the UI run the resolver over a single database's worth of tasks; any depId outside that universe silently resolves to undefined and is treated as satisfied.
This is existing behavior, not a regression. Supporting cross-database deps would require either fetching multiple Notion databases per request or maintaining a unified cross-database task cache — a substantial design lift. If it ever becomes a real need, address as a separate task.
## Approach (locked)
Mirror the resolver-back-fill block from /api/tasks/active (routes/tasks.ts:418-437) inside the non-milestone handler (routes/tasks.ts:336-373). After building views, parse the non-milestone cache, run DependencyResolver, build a resolvedMap keyed by task ID, and back-fill view.wave, view.blocked, view.blockerNames for each view.
After the dependency task lands, the non-milestone cache holds the prefixed-everywhere shape, so the resolver receives consistent IDs on both sides of the byId/depId comparison — no additional prefix-stripping or normalisation needed here.
### Why this shape
- Reuses the exact pattern from the /api/tasks/active handler, so the two endpoints stay symmetric — easier to reason about, harder to drift out of sync.
- No frontend changes: TaskList already renders wave-grouped non-milestone sections (App.tsx:347 routes non-milestone through the same component as milestones). Populating view.wave correctly is all that's needed.
- No changes to DependencyResolver, NotionTaskBackend, NotionClient, or AutoLauncher.
## Acceptance criteria
### 🤖 Automated tests
All tests follow the existing vitest + module-mock pattern.
1. tasks.test.ts or routes/tasks.test.ts (extended): /api/tasks/non-milestone runs the resolver and back-fills view.wave, view.blocked, view.blockerNames on each view. Mocked deps; in-memory SQLite for task_cache and sessions per the existing test scaffold.
1. Same test file: with a 3-task chain A ← B ← C (A Done, B, C Ready) in the non-milestone cache, the response must show B at wave: 1, blocked: false; C at wave: 2, blocked: true, blockerNames: ['B'].
1. Same test file: non-milestone task with a dependsOn entry referencing an ID NOT in the non-milestone cache resolves to blocked: false (documents the cross-database-dep "treated as satisfied" behavior, matching today's AutoLauncher).
1. Existing tests continue to pass.
## Files / paths affected
- packages/backend/src/routes/tasks.ts — add resolver back-fill block to the /api/tasks/non-milestone handler at lines 336-373, mirroring lines 418-437.
- Corresponding *.test.ts file.
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/routes/tasks.ts`
```
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getProjectById } from '../config';
import { ProjectService } from '../projects/ProjectService';
import { getTaskBackend } from '../tasks/TaskBackend';
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
        return formatToolCall
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