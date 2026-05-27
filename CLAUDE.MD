# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Add regression test that resumeOrphan spawn args use a real CLI-resolvable session_id
- **Notion task**: https://www.notion.so/Add-regression-test-that-resumeOrphan-spawn-args-use-a-real-CLI-resolvable-session_id-36c22f9152f381c9acd0c2e3d74d2fd2
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\b31446ac-9155-4b06-81e8-5efeb14d6b90`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\b31446ac-9155-4b06-81e8-5efeb14d6b90`).

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
The existing resumeOrphan.integration.test.ts mocks the CLI subprocess (a MockProcess that accepts any spawn args and returns canned events), so it never validated that --resume <orchestrator-session-id> actually works against the real CLI. That's why the broken-resume bug shipped. Add stricter spawn-arg assertions so a regression would fail this test.
## Dependencies
- Fix: claude --resume always fails because orchestrator's session_id isn't passed as the CLI's conversation_id
## Context
### Root cause
resumeOrphan.integration.test.ts:162-338 uses vi.mock to replace child_process.spawn with a mock that constructs MockProcess (defined in the same test file). The mock captures the spawn arguments but the assertions on lines 313-333 only verify:
- That a session_status message of running was broadcast
- That RESUME_NUDGE_MESSAGE was written to mock stdin
- That a user_message WS event with the nudge content was emitted
There is no assertion that the spawn args include --session-id <sessionId> on initial spawn, nor that the resume spawn uses the same UUID for --session-id (on initial) and --resume (on resume). A broken implementation that omits --session-id (today's behaviour) passes this test.
### Fix
Add two assertions to the existing test (or split into a new test):
1. Initial spawn (when the session is first created): assert the captured spawn args include '--session-id' followed by the session's UUID.
1. Resume spawn: assert the captured spawn args include '--resume' followed by the same UUID used in the initial spawn.
Reuse the existing mockProc.spawnArgs (or capture them via a new spy on spawn). No need to invoke a real CLI — the goal is to lock in the contract that the same UUID is used for both --session-id (originally) and --resume (on resume).
## Acceptance criteria
### 🤖 Automated tests
tsc --noEmit passes for both packages
New assertion: resume spawn args include '--resume', <sessionId> where <sessionId> is the row's session_id
New assertion: initial spawn args (whichever test covers initial spawn) include '--session-id', <sessionId>
If the companion --session-id fix is reverted (re-introducing the bug), the new assertions fail
### 👁️ Manual verification
Covered by the Manual Verification Gate task.
## Files / paths affected
- packages/backend/src/__tests__/resumeOrphan.integration.test.ts (update — add spawn-arg assertions)
- Possibly packages/backend/src/__tests__/SessionManager.test.ts (update — if it's a better home for the assertion)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/__tests__/resumeOrphan.integration.test.ts`
```
/**
 * Integration tests for SessionManager.resumeOrphanSessions().
 *
 * These tests "seed" sessions via the mocked DB layer and call
 * resumeOrphanSessions() on a real SessionManager. They verify the three
 * end-to-end behaviors required by the hardening task:
 *   1. Missing worktree → session marked error, server stays alive, other
 *      sessions resume normally.
 *   2. Healthy worktree → session re-attached, status broadcast, resume nudge
 *      delivered via stdin to the CLI runner.
 *   3. pr_url carry-forward → AgentSession.prUrl populated from row.pr_url so
 *      a subsequent clean exit does not delete the PR branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Module mocks ─────────────────────────────────────────────────────────────
// All vi.mock calls must appear before importing the code under test.

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
    exitCode: null as number | null,
  });
  return { proc, stdinChunks, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execSync: vi.fn(() => ''),
  execFile: vi.fn(),
}));

// fs is mocked so existsSync can be controlled per-test; readFileSync /
// statSync / writeFileSync are no-ops because the SessionManager paths under
// test (resumeOrphanSessions → resumeSession) only need existsSync. Anything
// else used transitively is shimmed below as a safe no-op.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => ''),
      writeFileSync: vi.fn(),
      statSync: vi.fn(() => ({ isFile: () => true })),
    },
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => ({ isFile: () => true })),
  };
});

const projectFixture = {
  id: 'test-project',
  name: 'Test Project',
  projectDir: '/fake/project',
  contextUrl: 'https://notion.so/ctx',
  boardId: 'board-1',
  githubRepo: 'owner/repo',
  taskSource: 'notion' as const,
};

vi.mock('../config', () => ({
  AUTO_REVIEW_ENABLED: false,
  AUTO_REVIEW_CONCURRENCY: 1,
  ALLOWED_TOOLS: [],
  config: {
    claudePath: '/fake/claude',
    maxConcurrentCodeSessions: 20,
    projectDir: '/fake/project',
  },
  getProjectById: vi.fn((id: string) =>
    id === 'test-project' ? projectFixture : undefined,
  ),
  getAllProjects: vi.fn(() => [projectFixture]),
  normalizePath: (p: string) => p,
  runtimeSettings: {
    session_mode: 'cli',
    code_session_model: '',
    review_session_model: '',
    max_concurrent_code_sessions: 20,
  },
}));

vi.mock('../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn(() => ({
    allowedTools: [],
    prGate: { typeCheck: '', build: '' },
    bootstrapScript: '',
    bashRules: [],
  })),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn(() => ''),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn(() => ''),
}));

const fakeTaskBackend = {
  fetchTaskPage: vi.fn(async () => ''),
  fetchReadyTasks: vi.fn(async () => []),
  updateStatus: vi.fn(async () => {}),
  attachPR: vi.fn(async () => {}),
};

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => fakeTaskBackend),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn(() => 'Running'),
}));

vi.mock('../db/queries', () => ({
  getSessionsByStatus: vi.fn(() => []),
  getSession: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  backfillStuckResultSessions: vi.fn(() => 0),
  insertSession: vi.fn(),
  insertEvent: vi.fn(),
  upsertSessionEvent: vi.fn(() => 1),
  upsertPullRequest: vi.fn(),
  insertPermissionDenial: vi.fn(),
  incrementTokens: vi.fn(),
  insertSessionAudit: vi.fn(),
  setSessionModel: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  setHeadSha: vi.fn(),
}));

// Now import the modules under test (after all mocks are in place).
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import {
  SessionManager,
  RESUME_NUDGE_MESSAGE,
} from '../session/SessionManager';
import * as queries from '../db/queries';
import type { ServerMessage } from '../ws/types';
import type { Session } from '../db/types';
import { backfillStuckResultSessions } from '../db/queries';

function makeRunningSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'session-uuid-default',
    task_id: 'notion-task-id',
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/ctx',
    project_id: 'test-project',
    status: 'running',
    started_at: 1_000_000,
    ended_at: null,
    pr_url: null,
    worktree_path: '/fake/project/.claude/worktrees/session-uuid-default',
    archived: 0,
    favorited: 0,
    session_type: 'standard',
    note: null,
    tags: null,
    model: null,
    task_name: 'fixture-task',
    ...overrides,
  } as Session;
}

beforeEach(() => {
  mockProc = createMockProc();
  vi.clearAllMocks();
  // execSync no-op stub (used for git fetch / git rev-parse / git worktree).
  vi.mocked(execSync).mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test 1: missing-worktree pre-check ─────────────────────────────────────
describe('resumeOrphanSessions() — missing-worktree pre-check (integration)', () => {
  it('marks the orphan with a missing worktree as error and emits session_ended without throwing', async () => {
    const missing = makeRunningSession({
      session_id: 'missing-session',
      worktree_path: '/fake/project/.claude/worktrees/missing-session',
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([missing]);

    // fs.existsSync(missing.worktreePath) → false (worktree was deleted).
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    // Server-alive proxy: resumeOrphanSessions must not throw.
    await expect(sm.resumeOrphanSessions()).resolves.not.toThrow();

    // The missing session must be marked as error.
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'missing-session',
      'error',
      expect.any(Number),
    );
    // ... and a session_ended (status=error) broadcast must have been emitted.
    const ended = messages.filter(
      (m) =>
        m.type === 'session_ended' &&
        (m as { sessionId: string }).sessionId === 'missing-session',
    );
    expect(ended).toHaveLength(1);
    expect((ended[0] as { status: string }).status).toBe('error');

    // No CLI process should have been spawned for the missing-worktree orphan.
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resumes a healthy orphan in the same batch even when another orphan has a missing worktree', async () => {
    const missing = makeRunningSession({
      session_id: 'missing-session',
      worktree_path: '/fake/project/.claude/worktrees/missing-session',
    });
    const healthy = makeRunningSession({
      session_id: 'healthy-session',
      worktree_path: '/fake/project/.claude/worktrees/healthy-session',
    });
    vi.mocked(querie
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