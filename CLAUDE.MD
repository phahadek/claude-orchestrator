# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Fix WS dispatch path: duplicate launches, missing fields, task ID sent as URL
- **Notion task**: https://www.notion.so/Fix-WS-dispatch-path-duplicate-launches-missing-fields-task-ID-sent-as-URL-36e22f9152f38153b80fef1074f91a03
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\9425e588-9f82-4a88-8316-ed0baa9de8c4`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\9425e588-9f82-4a88-8316-ed0baa9de8c4`).

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
The WebSocket dispatch path is structurally broken in four orthogonal ways that combined to produce a duplicate launch of a polimarket task with malformed fields. Each cause is independently fixable. After all four land, manual UI dispatch produces the same shape as AutoLauncher and cannot race against an in-flight launch.
## Dependencies
None. Independent of the other auto-revert / lifecycle work. Touches frontend dispatch, WS router, and SessionManager.start.
## Context
### Observed incident (2026-05-28 00:41 UTC)
Two session_launched events for the same polimarket task notion:36d22f9152f3816c90dae66addb48390 ("Add m2-end-to-end taskipy task chaining the analyzer CLIs"), 14 seconds apart:
```javascript
00:41:14.457  session=8c759508  task_kind=milestone     task_url=https://www.notion.so/Add-m2-end-to-end-taskipy-task-chaining-the-analyzer-CLIs-36d22f9152f3816c90dae66addb48390  task_name="Add m2-end-to-end taskipy task chaining the analyzer CLIs"
00:41:28.484  session=4f4305e5  task_kind=non_milestone  task_url=notion:36d22f91-52f3-816c-90da-e66addb48390  task_name=null
```
The first launch is AutoLauncher doing its thing correctly. The second is the WS dispatch path being broken in multiple ways at once.
### Bug 1 — frontend sends taskUrl = t.taskId
packages/frontend/src/hooks/useDispatch.ts:16:
```typescript
send({
  type: 'dispatch',
  tasks: tasks.map((t) => ({
    taskUrl: t.taskId,        // 👈 wrong — taskId is 'notion:<id>', not a URL
    projectContextUrl: project.contextUrl,
    taskType: t.taskType,
    projectId: project.id,
  })),
});
```
After D3, t.taskId is the prefixed form (notion:<id>). The backend's parseNotionPageId happens to extract the ID anyway, so sessions.task_id ends up correct — but sessions.task_url stores the literal notion:<id> string, which is not a URL. Anything that constructs a Notion link from task_url (e.g. an existing test fixture or future surface) breaks.
Fix: send the actual notionUrl field from the TaskView. TaskView already carries notionUrl: string (per taskView.ts); the dispatch hook should use that.
### Bug 2 — WS dispatch handler drops milestoneId, taskKind, taskName
packages/backend/src/ws/router.ts:43-46:
```typescript
sessions.start(t.taskUrl, t.projectContextUrl, {
  taskType: t.taskType,
  projectId: t.projectId,
});
```
No milestoneId, no taskKind, no taskName. By contrast, AutoLauncher.launchTask (AutoLauncher.ts:228-233) passes all four. As a result, manual launches have sessions.task_name = null and the audit log gets a degraded task_kind (see Bug 3).
Fix: extend the dispatch WS message shape (packages/backend/src/ws/types.ts) to include milestoneId?: string | null, taskKind?: 'milestone' | 'non_milestone', and taskName?: string. Frontend dispatch passes them through. Backend router forwards them to sessions.start.
### Bug 3 — SessionManager.start defaults task_kind from milestoneId presence
packages/backend/src/session/SessionManager.ts:557:
```typescript
task_kind: taskKind ?? (milestoneId ? 'milestone' : 'non_milestone'),
```
If the caller (post-Bug-2) passes neither taskKind nor milestoneId, the audit defaults to 'non_milestone' — a heuristic that misleads when the caller simply didn't know. This is what produced the spurious task_kind: non_milestone audit entry: WS dispatch passed neither field, defaulted accordingly.
Fix: Either (a) require taskKind from every caller (no default), or (b) default to 'milestone' (the common case) and only set 'non_milestone' when explicitly passed. Recommend (a) — the type-system catches it at every call site.
### Bug 4 — WS dispatch handler skips the in-flight dedup check
AutoLauncher.launchTask guards against double-launches:
```typescript
if (this.sessionManager.hasLiveSessionForTask(task.id)) return;
if (hasActiveSessionForTask(task.id)) return;
```
The WS dispatch handler in router.ts:32-50 does no such check. If the user clicks Launch on a task while AutoLauncher (or anything else) is mid-launch for it, both succeed and create duplicate sessions.
Fix: Lift the dedup check into SessionManager.start so every caller benefits. Either return early with a sentinel value ({ alreadyRunning: true, sessionId: existing }) or throw a typed error the WS router translates to a user-facing message.
### Why this all matters together
Any one of these bugs alone would produce a visible UI annoyance. Combined, they produce a duplicate session with malformed data that's hard to recognize as the same task in audit/dashboard views. The fix is structural and small — push more of the launch contract into SessionManager.start, make WS dispatch a thin pass-through, and use proper field names on the frontend.
### Out of scope
- The orchestrator-side root-cause CLAUDE.md / scratch-file fixes (already done).
- Backfilling historical sessions with corrected task_url / task_name — forward-only.
- A confirmation prompt in the UI when the user clicks Launch on a task that's already in-flight (could be a follow-up).
## Acceptance criteria
### 🤖 Automated tests
- tsc --noEmit passes for both packages.
- Unit test (frontend useDispatch): the dispatch payload includes taskUrl = task.notionUrl (not task.taskId), and includes milestoneId, taskKind, and taskName when applicable. Existing tests that asserted taskUrl: task.taskId must be updated accordingly.
- Unit test (WS router dispatch handler): forwards milestoneId, taskKind, and taskName from the message into SessionManager.start.
- Unit test (SessionManager.start): when called with no taskKind, throws (rather than defaulting). Update existing callers accordingly.
- Unit test (SessionManager.start): when there's already a live session for the same task ID, returns { alreadyRunning: true, sessionId: existing } (or throws a typed error) without creating a new session.
- Integration test: simulate the 2026-05-28 incident sequence — AutoLauncher launches a task, then a WS dispatch message arrives for the same task within seconds — only ONE session_launched audit entry is written, and the WS response indicates the second was a no-op.
- Regression: AutoLauncher behavior unchanged; existing dispatch tests pass after fixture updates.
## Files / paths affected
- packages/frontend/src/hooks/useDispatch.ts (update — send taskUrl = task.notionUrl, plus the three new optional fields)
- packages/frontend/src/hooks/__tests__/useDispatch.test.ts (update — fixture expectations)
- packages/backend/src/ws/types.ts (update — extend the dispatch message shape)
- packages/backend/src/ws/router.ts (update — forward all four launch options to SessionManager.start)
- packages/backend/src/session/SessionManager.ts (update — require taskKind (no default); lift in-flight dedup check from AutoLauncher into start)
- packages/backend/src/orchestration/AutoLauncher.ts (update — remove the now-redundant local dedup check OR keep as defense-in-depth)
- packages/backend/src/__tests__/SessionManager.test.ts (update — add the new tests; update fixtures for the required taskKind)
- packages/backend/src/__tests__/multiProject.test.ts (update — dispatch message shape regression)
- Wherever else sessions.start(...) is called — must include taskKind.
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/frontend/src/hooks/useDispatch.ts`
```
import { useCallback } from 'react';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

/** Shared hook for dispatching one or more coding sessions via WebSocket. */
export function useDispatch(
  send: (msg: ClientMessage) => void,
  project: ProjectConfig | null,
): (tasks: Array<{ taskId: string; taskType?: string }>) => void {
  return useCallback(
    (tasks) => {
      if (!project || tasks.length === 0) return;
      send({
        type: 'dispatch',
        tasks: tasks.map((t) => ({
          taskUrl: t.taskId,
          projectContextUrl: project.contextUrl,
          taskType: t.taskType,
          projectId: project.id,
        })),
      });
    },
    [send, project],
  );
}

```

### `packages/frontend/src/hooks/__tests__/useDispatch.test.ts`
```
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useDispatch } from '../useDispatch';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Test Project',
    path: '/repos/test',
    contextUrl: 'https://notion.so/context',
    boardId: 'board-1',
    ...overrides,
  } as ProjectConfig;
}

describe('useDispatch', () => {
  it('sends a dispatch WS message with taskId mapped to taskUrl for a single task', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([{ taskId: 'notion-page-id-123', taskType: '💻 Code' }]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'dispatch',
      tasks: [
        {
          taskUrl: 'notion-page-id-123',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          projectId: 'proj-1',
        },
      ],
    });
  });

  it('passes YAML task id as taskUrl (not a URL)', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([{ taskId: 't2-ready-unblocked', taskType: '💻 Code' }]);

    expect(send).toHaveBeenCalledWith({
      type: 'dispatch',
      tasks: [
        {
          taskUrl: 't2-ready-unblocked',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          projectId: 'proj-1',
        },
      ],
    });
  });

  it('does not call send when tasks array is empty', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([]);

    expect(send).not.toHaveBeenCalled();
  });

  it('does not call send when project is null', () => {
    const send = vi.fn();

    const { result } = renderHook(() => useDispatch(send, null));
    result.current([{ taskId: 'some-task-id' }]);

    expect(send).not.toHaveBeenCalled();
  });

  it('sends correct shape for multiple tasks', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([
      { taskId: 'task-id-1', taskType: '💻 Code' },
      { taskId: 'task-id-2', taskType: '💻 Code' },
    ]);

    expect(send).toHaveBeenCalledWith({
      type: 'dispatch',
      tasks: [
        {
          taskUrl: 'task-id-1',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          projectId: 'proj-1',
        },
        {
          taskUrl: 'task-id-2',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          projectId: 'proj-1',
        },
      ],
    });
  });
});

```

### `packages/backend/src/ws/types.ts`
```
import type { ResolvedTask } from '../notion/types';
import type { DisplayStatus } from '../tasks/TaskStatusEngine';
import type { PauseReason } from '../db/types';

// ── Server → Client ──────────────────────────────────────────────
export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

/**
 * Persistent state snapshot of a session as synced to frontend clients via
 * `session_started` WS messages. Populated from the `sessions` table joined
 * against `pull_requests` (for prUrl) on each WS connection.
 */
export interface SessionState {
  sessionId: string;
  taskName: string;
  notionTaskUrl: string;
  taskType?: string;
  sessionType?: string;
  prNumber?: number;
  codeSessionId?: string;
  started_at?: number;
  ended_at?: number;
  archived?: boolean;
  favorited?: boolean;
  project_id?: string | null;
  note?: string | null;
  tags?: string[];
  totalInputTokens?: number;
  totalOutputTokens?: number;
  model?: string | null;
  /** PR URL linked to this session, resolved from the pull_requests join. */
  prUrl?: string;
}

/** Full live-state snapshot of a task, sent in task_updated WS messages. */
export interface TaskView {
  taskId: string;
  taskName: string;
  notionStatus: string;
  displayStatus: DisplayStatus;
  /** Non-null when the task is paused (e.g. 'max_reviews', 'stuck_timeout'). */
  pauseReason: PauseReason | null;
  priority: string;
  notionUrl: string;
  taskType: string;
  blocked: boolean;
  blockerNames: string[];
  wave: number;
  codeSession: {
    sessionId: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    lastMessage: string;
    inputTokens: number;
    outputTokens: number;
  } | null;
  pr: {
    prNumber: number;
    prUrl: string;
    title: string;
    headBranch: string;
    baseBranch: string;
    state: string;
    draft: boolean;
    mergeState: string | null;
  } | null;
  review: {
    sessionId: string;
    status: string;
    verdict: string | null;
    summary: string | null;
    iterationCount: number;
    inputTokens: number;
    outputTokens: number;
  } | null;
  totalTokens: { input: number; output: number };
}

export type ServerMessage =
  | ({ type: 'session_started' } & SessionState)
  | {
      type: 'session_event';
      sessionId: string;
      eventType:
        | 'text'
        | 'tool_use'
        | 'tool_result'
        | 'system'
        | 'user_message';
      content: string;
      messageId?: string;
    }
  | {
      type: 'session_status';
      sessionId: string;
      status:
        | 'starting'
        | 'running'
        | 'needs_permission'
        | 'done'
        | 'error'
        | 'killed'
        | 'retrying';
      replay?: boolean;
    }
  | {
      type: 'permission_request';
      sessionId: string;
      toolName: string;
      proposedAction: string;
    }
  | {
      type: 'permission_denials';
      sessionId: string;
      denials: PermissionDenial[];
    }
  | { type: 'session_ended'; sessionId: string; status: string; prUrl?: string }
  | { type: 'pr_created'; sessionId: string; prUrl: string }
  | {
      type: 'session_updated';
      sessionId: string;
      note?: string | null;
      tags?: string[];
      totalInputTokens?: number;
      totalOutputTokens?: number;
      model?: string;
    }
  | { type: 'tasks_ready'; tasks: ResolvedTask[] }
  | {
      type: 'pr_review_complete';
      prNumber: number;
      repo: string;
      verdict: string;
      summary: string;
      draft?: boolean;
      replay?: boolean;
    }
  | { type: 'push_detected'; sessionId: string; prNumber: number; repo: string }
  | {
      type: 'review_verdict';
      prNumber: number;
      repo: string;
      verdict: string;
      summary: string;
      iteration: number;
      replay?: boolean;
    }
  | { type: 'pr_merged'; prNumber: number; repo: string; sha: string }
  | { type: 'pr_closed'; prNumber: number; repo: string }
  | {
      type: 'pr_state_changed';
      prNumber: number;
      repo: string;
      mergeable: boolean | null;
      mergeState: string | null;
    }
  | {
      type: 'pr_mergeability_changed';
      prNumber: number;
      repo: string;
      mergeable: boolean | null;
      mergeState: string | null;
      failingChecks?: string[] | null;
    }
  | {
      type: 'review_escalated';
      prNumber: number;
      repo: string;
      message: string;
    }
  | {
      type: 'review_failed';
      prNumber: number;
      repo: string;
      message: string;
    }
  | {
      type: 'review_incomplete';
      prNumber: number;
      repo: string;
      message: string;
    }
  | {
      type: 'stuck_session_notified';
      sessionId: string;
      taskName: string;
      message: string;
    }
  | {
      type: 'stuck_session_paused';
      sessionId: string;
      taskName: string;
      prNumber?: number;
      repo?: string;
    }
  | { type: 'stuck_session_killed'; sessionId: string; taskName: string }
  | {
      type: 'api_overloaded_paused';
      sessionId: string;
      prNumber?: number;
      repo?: string;
    }
  | {
      type: 'session_audit';
      sessionId: string;
      prOpened: boolean;
      prTargetsBranch: string | null;
      violations: (string | import('../db/types').WorktreeEscapeViolation)[];
      specMismatch: string | null;
      auditedAt: string;
    }
  | { type: 'task_status_changed'; notionTaskId: string; newStatus: string }
  | { type: 'task_updated'; task: TaskView }
  | {
      type: 'auto_launch';
      projectId: string;
      taskId: string;
      taskTitle: string;
      sessionId: string;
    }
  | { type: 'error'; message: string }
  | { type: 'pr_pause_cleared'; prNumber: number; repo: string }
  | { type: 'autofix_started'; prNumber: number; repo: string }
  | {
      type: 'autofix_complete';
      prNumber: number;
      repo: string;
      success: boolean;
      summary?: string;
    }
  | { type: 'review_started'; prNumber: number; sessionId: string }
  | {
      type: 'local_branch_submitted';
      projectId: string;
      sessionId: string;
      branchName: string;
      baseBranch: string;
    }
  | {
      type: 'local_branch_merged';
      projectId: string;
      sessionId: string;
      branchName: string;
      commitSha: string | null;
    }
  | {
      type: 'enrollment_request';
      code: string;
      deviceName: string;
      userAgent: string;
      ip: string;
      expiresAt: number;
    }
  | {
      type: 'enrollment_approved';
      code: string;
      deviceId: string;
    };

// ── Client → Server ──────────────────────────────────────────────
export type ClientMessage =
  | {
      type: 'dispatch';
      tasks: {
        taskUrl: string;
        projectContextUrl: string;
        taskType?: string;
        projectId: string;
      }[];
    }
  | { type: 'approve'; sessionId: string }
  | { type: 'deny'; sessionId: string; reason?: string }
  | { type: 'send_message'; sessionId: string; message: string }
  | { type: 'kill'; sessionId: string }
  | { type: 'end_session'; sessionId: string }
  | {
      type: 'fetch_tasks';
      projectId: string;
      milestoneId: string;
      skipCache?: boolean;
    }
  | { type: 'enrollment_approve'; code: string };

```

### `packages/backend/src/ws/router.ts`
```
import { WebSocket } from 'ws';
import { ClientMessage } from './types';
import { SessionManager } from '../session/SessionManager';
import { getTaskBackend } from '../tasks/TaskBackend';
import { getProjectById } from '../config';
import { approveEnrollment } from '../auth/Enrollment';

export function handleMessage(
  ws: WebSocket,
  raw: string,
  sessions: SessionManager,
): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    return;
  }

  switch (msg.type) {
    case 'dispatch':
      if (!Array.isArray(msg.tasks)) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'dispatch requires tasks array',
          }),
        );
        break;
      }
      msg.tasks.forEach((t) => {
        if (!t.taskUrl) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'dispatch task requires a non-empty taskUrl',
            }),
          );
          return;
        }
        try {
          sessions.start(t.taskUrl, t.projectContextUrl, {
            taskType: t.taskType,
            projectId: t.projectId,
          });
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', message: String(e) }));
        }
      });
      break;
    case 'approve':
      // The claude CLI --print mode does not support mid-session permission approval.
      // Tools are pre-approved via --allowedTools at spawn time. This is a no-op.
      console.log(
        `[router] approve ignored — CLI does not support mid-session approval`,
      );
      break;
    case 'deny':
      console.log(
        `[router] deny ignored — CLI does not support mid-session denial`,
      );
      break;
    case 'send_message':
      sessions.send(msg.sessionId, msg.message);
      break;
    case 'kill':
      sessions.kill(msg.sessionId);
      break;
    case 'end_session':
      sessions.endSession(msg.sessionId);
      break;
    case 'fetch_tasks': {
      const rawMsg = msg as Record<string, unknown>;
      // Reject the legacy { boardId } payload with a clear error so callers update.
      if ('boardId' in rawMsg && !('milestoneId' in rawMsg)) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message:
              'fetch_tasks payload changed: send { projectId, milestoneId }, not { boardId }',
          }),
        );
        break;
      }
      if (typeof msg.projectId !== 'string' || !msg.projectId) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'fetch_tasks requires projectId',
          }),
        );
        break;
      }
      if (typeof msg.milestoneId !== 'string' || !msg.milestoneId) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'fetch_tasks requires milestoneId',
          }),
        );
        break;
      }
      const project = getProjectById(msg.projectId);
      if (!project) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: `Project not found: ${msg.projectId}`,
          }),
        );
        break;
      }
      let backend;
      try {
        backend = getTaskBackend(msg.projectId);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: String(e) }));
        break;
      }
      backend
        .fetchReadyTasks(msg.milestoneId, msg.skipCache)
        .then((tasks) =>
          ws.send(JSON.stringify({ type: 'tasks_ready', tasks })),
        )
        .catch((e) =>
          ws.send(JSON.stringify({ type: 'error', message: String(e) })),
        );
      break;
    }
    case 'enrollment_approve': {
      const result = approveEnrollment(msg.code);
      if (!result) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'invalid or expired enrollment code',
          }),
        );
        break;
      }
      ws.send(
        JSON.stringify({
          type: 'enrollment_approved',
          code: msg.code,
          deviceId: result.deviceId,
        }),
      );
      break;
    }
    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
      ws.send(
        JSON.stringify({ type: 'error', message: 'Unknown message type' }),
      );
    }
  }
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

### `packages/backend/src/orchestration/AutoLauncher.ts`
```
import type { SessionManager } from '../session/SessionManager';
import type { TaskBackend } from '../tasks/TaskBackend';
import { getTaskBackend } from '../tasks/TaskBackend';
import { getAllProjects, runtimeSettings } from '../config';
import type { ProjectConfig } from '../config';
import type { ResolvedTask } from '../notion/types';
import type { ServerMessage } from '../ws/types';
import {
  hasActiveSessionForTask,
  getPausedPrReasonForTask,
} from '../db/queries';

const READY_STATUS = '🗂️ Ready';
const CODE_TYPE = '💻 Code';
const MIN_POLL_INTERVAL_MS = 5_000;

/**
 * Backend service that polls each enabled project's milestone for Ready 💻 Code
 * tasks with no unmet dependencies and launches sessions for them, up to a
 * configurable global concurrency cap.
 *
 * Polling is async-safe: cycles never overlap. Calls into SessionManager.start()
 * use the same code path as a manual UI launch.
 */
export class AutoLauncher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = true;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly broadcast?: (msg: ServerMessage) => void,
    private readonly options: {
      /** Project lister — defaulted to getAllProjects for production. */
      listProjects?: () => ProjectConfig[];
      /** Task backend resolver — defaulted to getTaskBackend for production. */
      resolveBackend?: (projectId: string) => TaskBackend;
      /** Whether to immediately run a poll cycle when start() is called. Defaults to true. */
      pollOnStart?: boolean;
    } = {},
  ) {}

  /**
   * Begin polling. Returns immediately. The first poll runs synchronously
   * inside the start() body (after `await`) so callers can sequence it after
   * SessionManager.resumeOrphanSessions() and avoid races on this.sessions.size.
   */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.options.pollOnStart !== false) {
      await this.pollOnce();
    }
    this.scheduleNext();
  }

  /** Stop polling and clear any pending timer. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const interval = Math.max(
      MIN_POLL_INTERVAL_MS,
      runtimeSettings.auto_launch_poll_interval_ms,
    );
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => this.scheduleNext());
    }, interval);
    this.timer.unref?.();
  }

  /**
   * Run a single poll cycle. Exposed for tests and for the initial in-line call
   * from start(). Guarded against overlap so a slow Notion fetch can't pile up.
   */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const listProjects = this.options.listProjects ?? getAllProjects;
      const projects = listProjects().filter((p) => p.autoLaunchEnabled);
      for (const project of projects) {
        try {
          await this.processProject(project);
        } catch (err) {
          console.error(`[AutoLauncher] project ${project.id} failed:`, err);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async processProject(project: ProjectConfig): Promise<void> {
    const resolveBackend = this.options.resolveBackend ?? getTaskBackend;
    const backend = resolveBackend(project.id);

    if (backend.type === 'local') {
      return;
    }

    let milestoneId: string | null = null;
    if (backend.type === 'notion') {
      milestoneId = this.resolveMilestoneId(project);
      if (!milestoneId) {
        console.warn(
          `[AutoLauncher] project ${project.id}: no milestone configured — skipping`,
        );
        return;
      }
    }

    const milestoneTasks = await backend.fetchReadyTasks(
      milestoneId,
      backend.type === 'notion' ? true : undefined,
    );

    // Also fetch non-milestone tasks and merge into the eligible pool.
    let nonMilestoneTasks: ResolvedTask[] = [];
    const nmConfig = project.nonMilestoneSourceConfig ?? null;
    if (nmConfig) {
      try {
        nonMilestoneTasks = await backend.fetchNonMilestoneReadyTasks(
          nmConfig,
          project.id,
        );
      } catch (err) {
        console.warn(
          `[AutoLauncher] project ${project.id}: fetchNonMilestoneReadyTasks failed: ${err}`,
        );
      }
    }

    const allTasks = [...milestoneTasks, ...nonMilestoneTasks];
    const candidates = allTasks.filter((t) => this.isLaunchCandidate(t));
    if (candidates.length === 0) return;

    for (const candidate of candidates) {
      if (!this.hasCapacity()) {
        return;
      }
      // Non-milestone tasks have no milestoneId — they branch off dev directly.
      const isNonMilestone = nonMilestoneTasks.includes(candidate);
      this.launchTask(
        project,
        candidate,
        isNonMilestone ? null : milestoneId,
        isNonMilestone ? 'non_milestone' : 'milestone',
      );
    }
  }

  /**
   * Determine the milestone the launcher should poll for a project:
   * explicit `autoLaunchMilestoneId` wins; otherwise fall back to the first
   * milestone in display order with a non-empty sourceId.
   */
  private resolveMilestoneId(project: ProjectConfig): string | null {
    if (project.autoLaunchMilestoneId) return project.autoLaunchMilestoneId;
    const firstWithSource = project.boards?.find((b) => b.sourceId);
    return firstWithSource?.id ?? null;
  }

  /** Decide whether a ResolvedTask is eligible for auto-launch this cycle. */
  private isLaunchCandidate(resolved: ResolvedTask): boolean {
    const { task } = resolved;
    if (task.status !== READY_STATUS) return false;
    if (task.type !== CODE_TYPE) return false;
    // Skip if any direct or transitive Depends On entry isn't Done.
    if (resolved.blocked) return false;
    // Pause-reason metadata: when a Notion task has a non-null pause_reason
    // property, the user has explicitly held it back from auto-launch.
    const maybePauseReason = (task as { pause_reason?: string | null })
      .pause_reason;
    if (maybePauseReason != null && maybePauseReason !== '') return false;
    // Also skip if the task's most recent PR is paused (e.g. stuck_timeout)
    // so we don't relaunch a session that was force-paused.
    if (getPausedPrReasonForTask(task.id) != null) return false;
    return true;
  }

  /**
   * True when launching another session would not exceed the global cap. The
   * cap counts all live standard (non-review) sessions, including ones that
   * resumeOrphanSessions() restored at boot — this keeps the launcher from
   * racing with orphan-resume slot reservations.
   */
  private hasCapacity(): boolean {
    const cap = Math.max(0, runtimeSettings.auto_launch_concurrency);
    if (cap === 0) return false;
    const liveCodeSessions = this.countLiveCodeSessions();
    return liveCodeSessions < cap;
  }

  /** Count live (in-memory) standard sessions via SessionManager's public API. */
  private countLiveCodeSessions(): number {
    // SessionManager exposes only isAlive() publicly. We can't iterate, but the
    // launcher only needs a comparison against the cap. Fall back to a private
    // accessor: SessionManager#sessions is private, so go via the public-ish
    // sessions getter exposed for the AutoLauncher.
    return this.sessionManager.getLiveCodeSessionCount();
  }

  private launchTask(
    project: ProjectConfig,
    resolved: ResolvedTask,
    milestoneId: string | null = null,
    taskKind: 'milestone' | 'non_milestone' = 'milestone',
  ): void {
    const task = resolved.task;
    const taskUrl =
      task.notionUrl || `https://www.notion.so/${task.id.replace(/-/g, '')}`;

    // Skip if a session for this task is already active. Check both the
    // in-memory SessionManager (catches launches whose Notion status update
    // hasn't propagated back yet) and th
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

### `packages/backend/src/__tests__/multiProject.test.ts`
```
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── AC: SessionManager.start() throws if projectId is not found ─────────────

describe('SessionManager.start() — projectId validation', () => {
  it('source throws when projectId is not found in PROJECTS', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    // Must call getProjectById(projectId)
    expect(source).toMatch(/getProjectById\(projectId\)/);
    // Must throw if project not found
    expect(source).toMatch(/throw new Error.*Project not found/);
  });

  it('passes projectId to insertSession as project_id', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(source).toMatch(/project_id:\s*projectId/);
  });

  it('resolves projectDir from project config rather than global config.projectDir', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    // Must use project.projectDir, not config.projectDir for worktree creation
    expect(source).toMatch(/project\.projectDir/);
    // Must import getProjectById
    expect(source).toMatch(/import.*getProjectById.*from.*config/);
  });
});

// ── AC: getSessionsByProject() filters by project_id ───────────────────────

describe('getSessionsByProject()', () => {
  it('source queries sessions WHERE project_id = ?', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'queries.ts'),
      'utf-8',
    );
    expect(source).toContain('getSessionsByProject');
    expect(source).toMatch(/WHERE project_id = \?/);
  });

  it('INSERT statements include project_id column', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'queries.ts'),
      'utf-8',
    );
    // Both INSERT statements should include project_id
    const insertMatches =
      source.match(/INSERT.*INTO sessions[\s\S]*?VALUES/g) ?? [];
    expect(insertMatches.length).toBeGreaterThanOrEqual(1);
    for (const match of insertMatches) {
      expect(match).toContain('project_id');
    }
  });
});

// ── AC: schema.ts runMigrations() adds project_id column idempotently ───────

describe('schema.ts runMigrations()', () => {
  it('adds project_id column via idempotent try/catch ALTER TABLE', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    // Must contain the idempotent migration
    expect(source).toMatch(/ALTER TABLE sessions ADD COLUMN project_id TEXT/);
    // Must be wrapped in try/catch (idempotent)
    const idx = source.indexOf(
      'ALTER TABLE sessions ADD COLUMN project_id TEXT',
    );
    const before = source.slice(Math.max(0, idx - 60), idx);
    expect(before).toContain('try');
  });
});

// ── AC: NotionClient.fetchReadyTasks() accepts boardId parameter ─────────────

describe('NotionClient.fetchReadyTasks()', () => {
  it('accepts a boardId parameter and uses it for the database query', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'notion', 'NotionClient.ts'),
      'utf-8',
    );
    // Method signature must accept boardId as the first parameter
    expect(source).toMatch(/fetchReadyTasks\(boardId:\s*string/);
    // Must use boardId in the API call (not a hardcoded value)
    expect(source).toMatch(/\/databases\/\$\{boardId\}\/query/);
  });
});

// ── AC: tsc --noEmit passes ─────────────────────────────────────────────────
// (Covered by the pre-PR gate, not as a vitest test)

// ── AC: ProjectConfig has id and projectDir fields ──────────────────────────

describe('ProjectConfig interface', () => {
  it('includes id and projectDir fields', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'config.ts'),
      'utf-8',
    );
    expect(source).toMatch(/id:\s*string/);
    expect(source).toMatch(/projectDir:\s*string/);
    expect(source).toContain('getProjectById');
  });
});

// ── AC: ws/types.ts dispatch includes projectId ─────────────────────────────

describe('WS ClientMessage types', () => {
  it('dispatch task items include projectId field', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'ws', 'types.ts'),
      'utf-8',
    );
    // dispatch tasks must have projectId
    expect(source).toMatch(/dispatch.*projectId:\s*string/s);
  });

  it('fetch_tasks requires both projectId and milestoneId', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'ws', 'types.ts'),
      'utf-8',
    );
    expect(source).toMatch(/fetch_tasks.*projectId:\s*string/s);
    expect(source).toMatch(/fetch_tasks.*milestoneId:\s*string/s);
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