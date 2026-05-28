# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Fix: pause_reason='review_failed' not cleared when subsequent re-review approves
- **Notion task**: https://www.notion.so/Fix-pause_reason-review_failed-not-cleared-when-subsequent-re-review-approves-36e22f9152f3814bb3a6fb43de26530b
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\dfd49eb7-be27-4742-8392-4f17b619a027`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\dfd49eb7-be27-4742-8392-4f17b619a027`).

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
When an automatic re-review throws, server.ts sets pull_requests.pause_reason='review_failed'. If a later push triggers another re-review that returns verdict: 'approved', the pause_reason is never cleared — AutoMerger refuses to merge the approved PR because it's still flagged as paused. The success path needs to clear any prior pause.
## Dependencies
None.
## Context
The bug. server.ts:343-349 sets pause_reason='review_failed' in the catch block of the auto-triggered re-review (prReviewService.reReviewPR(...)). The verdict-success path at server.ts:373-407 updates last_reviewed_sha, broadcasts a review_verdict WS event, and (for needs_changes) calls sendOrResume — but never calls setPauseReason(prNumber, repo, null). The only existing clearing path is db/queries.ts:1116-1124 (resetReviewIteration), invoked exclusively from routes/prs.ts (manual re-review), not from this auto-triggered flow.
Real-world hit observed during M6 grooming. PR #67 in phahadek/polimarket-analyser (task "Port Market browser view to React") shows review_result.verdict='approved', last_reviewed_sha === head_sha, pause_reason='review_failed'. AutoMerger refuses to merge.
Fix. After setLastReviewedSha(...) at server.ts:373, when result.verdict === 'approved', also call setPauseReason(prRow.pr_number, prRow.repo, null). Do NOT clear on needs_changes or incomplete — only on the success transition. Match the placement so the clear is atomic with the verdict-success path.
Scope clarification. Other pause_reason values set by different code paths (e.g. 'pr_body_invalid', 'api_overloaded', 'stuck_timeout', 'max_reviews') become equally stale once the reviewer approves the PR. Clear them too — a successful approval supersedes any prior pause state. (If a future pause reason should NOT be cleared by approval, special-case it explicitly at that point.)
## Acceptance criteria
### 🤖 Automated tests
After auto-triggered re-review throws and sets pause_reason='review_failed', a subsequent push that produces verdict: 'approved' clears pause_reason to NULL
verdict: 'needs_changes' does NOT clear pause_reason
verdict: 'incomplete' does NOT clear pause_reason
When pause_reason was already NULL, an approved re-review is a no-op for that field (no spurious write)
pause_reason='stuck_timeout' is cleared on approved verdict
pause_reason='max_reviews' is cleared on approved verdict
## Files / paths affected
- packages/backend/src/server.ts (update — add setPauseReason(prNumber, repo, null) in the approved-verdict branch of the push-detected re-review handler)
- packages/backend/src/__tests__/server.escalation.test.ts or the sibling re-review test file (update — add clear-on-approval cases)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/server.ts`
```
import './bootstrap';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import os from 'os';
import { runMigrations } from './db/schema';
import { db } from './db/db';
import { SessionManager } from './session/SessionManager';
import { handleMessage } from './ws/router';
import { sendInitialStateBurst } from './ws/initialStateBurst';
import { JsonlReader, DEFAULT_SESSIONS_DIR } from './session/JsonlReader';
import type { ServerMessage } from './ws/types';
import {
  permissionEventsRouter,
  permissionDenialsRouter,
} from './routes/rules';
import configRouter from './routes/config';
import settingsRouter, { loadRuntimeSettingsFromDb } from './routes/settings';
import { sessionsRouter, setBroadcast } from './routes/sessions';
import { createPrsRouter, setPRBroadcast } from './routes/prs';
import { createTasksRouter, setTaskBroadcast } from './routes/tasks';
import { analyticsRouter } from './routes/analytics';
import { projectsRouter, setAutoMerger } from './routes/projects';
import { requireDeviceAuth, validateWsToken } from './auth/DeviceAuth';
import {
  createEnrollmentRouter,
  setEnrollmentBroadcast,
} from './auth/Enrollment';
import { getActiveDeviceCount } from './db/queries';
import { importProjectsFromEnv } from './projects/projectImport';
import { GitHubClient } from './github/GitHubClient';
import { PRReviewService } from './github/PRReviewService';
import { ReviewOrchestrator } from './github/ReviewOrchestrator';
import { PRMergeWatcher } from './github/PRMergeWatcher';
import { AutoMerger } from './github/AutoMerger';
import { ReviewerCommentsWatcher } from './github/ReviewerCommentsWatcher';
import { AUTO_REVIEW_ENABLED, AUTO_REVIEW_CONCURRENCY } from './config';
import { getCorporateMode } from './config/corporateMode';
import { AutoLauncher } from './orchestration/AutoLauncher';
import { StuckSessionMonitor } from './orchestration/StuckSessionMonitor';
import {
  deleteGhostSessions,
  getPRBySessionId,
  setPRReviewResult,
  setLastReviewedSha,
  setHeadSha,
  getSetting,
  setPendingPush,
  setPauseReason,
} from './db/queries';
import { shouldAutoReview, formatReviewFeedback } from './github/reviewUtils';
import type { PRReviewResult } from './github/PRReviewService';

runMigrations();
loadRuntimeSettingsFromDb();
importProjectsFromEnv(process.env.PROJECTS);

const _cm = getCorporateMode();
console.log(
  `[corporateMode] mode=${_cm.enabled ? 'corporate' : 'personal'} envLocked=${_cm.envLocked} gates=${JSON.stringify(_cm.gates)}`,
);

const ghostsRemoved = deleteGhostSessions();
if (ghostsRemoved > 0) {
  console.log(
    `[server] cleaned up ${ghostsRemoved} ghost session(s) with no events`,
  );
}

const rawSessionsDir = process.env.SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;
const sessionsDir = rawSessionsDir.replace(/^~/, os.homedir());
const jsonlReader = new JsonlReader(sessionsDir);

if (process.env.TASK_BACKEND) {
  console.warn(
    '[startup] TASK_BACKEND env var is deprecated and ignored. ' +
      'task_source is now configured per-project in SQLite.',
  );
}

const githubClient = new GitHubClient();

const sessionManager = new SessionManager(githubClient);
const prReviewService = new PRReviewService(
  githubClient,
  undefined,
  sessionManager,
);
// Retained so push_detected handler can call consumeAutofixSha() to detect
// autofix-only pushes and suppress iteration-counter increments for them.
const reviewOrchestrator = new ReviewOrchestrator(
  prReviewService,
  sessionManager,
  AUTO_REVIEW_CONCURRENCY,
  AUTO_REVIEW_ENABLED,
  githubClient,
);

const PORT = parseInt(process.env.PORT ?? '3000');

const app = express();
app.use(express.json());
// Enrollment endpoints are public — mount before the device auth middleware
app.use('/api/enrollment', createEnrollmentRouter());
app.use(requireDeviceAuth);
app.use('/api/permission-events', permissionEventsRouter);
app.use('/api/permission-denials', permissionDenialsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/sessions', sessionsRouter);
// PRMergeWatcher created early so routes and sync jobs can delegate lifecycle to it.
// .start() is called later after server boots.
const prMergeWatcher = new PRMergeWatcher(
  githubClient,
  sessionManager,
  undefined,
  broadcast,
);
// After an approved verdict, the review service should trigger an immediate
// watcher-style mergeability check so we don't wait for the next 5-min poll.
prReviewService.setMergeWatcher(prMergeWatcher);
const autoMerger = new AutoMerger(
  githubClient,
  prMergeWatcher,
  broadcast,
  sessionManager,
);
prMergeWatcher.setAutoMerger(autoMerger);
prReviewService.setAutoMerger(autoMerger);
setAutoMerger(autoMerger);
const reviewerCommentsWatcher = new ReviewerCommentsWatcher(
  githubClient,
  sessionManager,
);
app.use(
  '/api',
  createPrsRouter(
    githubClient,
    prReviewService,
    sessionManager,
    undefined,
    prMergeWatcher,
    autoMerger,
  ),
);
app.use('/api', createTasksRouter());
app.use('/api/analytics', analyticsRouter);
app.use('/api', projectsRouter);
app.use('/api', configRouter);
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')),
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg: ServerMessage) {
  const json = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  });
}

// Wire broadcast into the sessions router (for PATCH note/tags)
setBroadcast(broadcast);
// Wire broadcast into the prs router (for merge/close events)
setPRBroadcast(broadcast);
// Wire broadcast into the tasks route (for task_updated WS messages)
setTaskBroadcast(broadcast);
// Wire broadcast into enrollment (for enrollment_request events)
setEnrollmentBroadcast(broadcast);

// Broadcast all session events to every connected WS client
sessionManager.on('message', broadcast);

// ── Push-detected re-review loop ─────────────────────────────────────────────

const PUSH_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REVIEW_ITERATIONS = 3;
const pendingReReviews = new Set<string>();

function getMaxReviewIterations(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_REVIEW_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_REVIEW_ITERATIONS;
}

sessionManager.on(
  'push_detected',
  ({ sessionId: codingSessionId }: { sessionId: string }) => {
    console.log(
      `[server] push_detected from session ${codingSessionId.slice(0, 8)}`,
    );
    if (!AUTO_REVIEW_ENABLED) {
      console.log('[server] push_detected: auto-review disabled');
      return;
    }
    if (pendingReReviews.has(codingSessionId)) {
      console.log('[server] push_detected: already pending for this session');
      return;
    }

    const prRow = getPRBySessionId(codingSessionId);
    if (!prRow || prRow.state !== 'open') {
      console.log(
        `[server] push_detected: no open PR for session (found=${!!prRow})`,
      );
      return;
    }
    if (prRow.pause_reason === 'human_changes_requested') {
      // Session addressed human review feedback and pushed — clear the pause so
      // AutoMerger can re-check the review state (re-approve or request more changes).
      setPauseReason(prRow.pr_number, prRow.repo, null);
      autoMerger.attempt(prRow.pr_number, prRow.repo);
      console.log(
        `[server] push_detected: human_changes_requested cleared for PR #${prRow.pr_number} — AutoMerger restarted`,
      );
      return;
    }

    if (!prRow.review_session_id) {
      // Initial review hasn't started yet — queue the push so it triggers
      // re-review after the initial review session is established.
      setPendingPush(prRow.pr_number, prRow.repo, 1);
      console.log(
       
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