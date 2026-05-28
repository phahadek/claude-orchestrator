# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Always run autofix on every PR push (including re-reviews)
- **Notion task**: https://www.notion.so/Always-run-autofix-on-every-PR-push-including-re-reviews-36e22f9152f381de857ec83f4b0a1cce
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\7627a480-1ae2-4b04-84bb-2179cc8da52d`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\7627a480-1ae2-4b04-84bb-2179cc8da52d`).

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
Today autofix runs only on the first review of a PR (via ReviewOrchestrator.executeReview lines 384–451). Subsequent pushes go through the re-review path in server.ts:192 push_detected handler, which calls prReviewService.reReviewPR directly and bypasses autofix entirely. This asymmetry means:
- A session push that introduces lint/format violations after iteration 0 is sent to the reviewer with those violations intact.
- The reviewer often flags formatting noise that autofix could have silently resolved.
- More wasted review iterations.
Re-reviews should follow the same autofix → runFilePollutionCheck → review pipeline as first reviews.
## Dependencies
- Autofix bot must not commit CLAUDE.md changes (M6) — without that fix landed first, running autofix on every push would multiply the CLAUDE.md leak from once-per-PR to once-per-push.
## Context
### Current flow asymmetry
- First review (ReviewOrchestrator.executeReview): runAutofix → review.
- Re-review (server.ts push_detected handler → prReviewService.reReviewPR): review only.
### Why the bypass exists today
The push_detected handler was built around "skip re-review for autofix-only pushes" (consumeAutofixSha in ReviewOrchestrator.ts:185), and autofix itself was implicitly treated as a first-review-only step. There is no architectural reason for the asymmetry — it is an incomplete design.
## Approach (locked)
Lift the autofix → runFilePollutionCheck → review pipeline into a shared helper invoked from BOTH:
- ReviewOrchestrator.executeReview (replace the inline block).
- server.ts push_detected handler (before calling prReviewService.reReviewPR).
The consumeAutofixSha mechanism stays — it correctly suppresses iteration-counter increments for autofix-only pushes regardless of whether autofix ran 1×, 2×, or N× during the PR lifetime.
## Acceptance criteria
### 🤖 Automated tests
All tests follow the existing vitest + module-mock pattern. runAutofix and the pollution-check function (from the dependency task) are mocked at the import level; the tests verify the shared helper invokes them in order and that both call sites use it. No real git, prettier, or file-system access.
1. New unit tests on the extracted autofix + pollution-check helper:
1. ReviewOrchestrator.test.ts updates: confirm executeReview now uses the extracted helper. Refactor verification — no externally observable behavior change beyond the dependency task's end state.
1. New unit test on the server.ts push_detected handler path: invokes the extracted helper before prReviewService.reReviewPR. Mock the helper; verify call order with vi.fn() ordering checks.
1. consumeAutofixSha continues to suppress the re-review for an autofix-only push — verified by mocking the helper to record a commit SHA, then issuing a second push_detected whose head SHA matches.
1. Existing tests continue to pass: review-loop.integration.test.ts, reReviewCatchSite.test.ts, server.escalation.test.ts.
## Files / paths affected
- packages/backend/src/server.ts — push_detected handler invokes the shared autofix + pollution-check helper before reReviewPR.
- packages/backend/src/github/ReviewOrchestrator.ts — extract or refactor executeReview's autofix block into a shared helper.
- Corresponding *.test.ts files.
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

### `packages/backend/src/github/ReviewOrchestrator.ts`
```
import { getProjectByGithubRepo, getProjectById } from '../config';
import {
  setPRReviewResult,
  getSetting,
  getPRByNumber,
  setPendingPush,
  setPauseReason,
  getLocalBranchBySession,
  setLocalBranchPauseReason,
  getSession,
} from '../db/queries';
import type {
  PRReviewService,
  PRReviewResult,
  WorkItem,
} from './PRReviewService';
import { FetchRetryExhaustedError } from './PRReviewService';
import type { SessionManager } from '../session/SessionManager';
import type { GitHubClient } from './GitHubClient';
import type { ReviewJob } from './types';
import { GitHubDiffSource, LocalDiffSource } from './DiffSource';
import { formatReviewFeedback, formatCIFailureFeedback } from './reviewUtils';
import { runVerifyAsGate } from '../orchestration/verifyRunner';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { loadAutofixCommands, runAutofix } from '../session/autofix-runner';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';

const REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ITERATIONS = 3;

function getMaxReviewIterations(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_ITERATIONS;
}

interface LocalBranchJob {
  type: 'local_branch';
  localBranchId: number;
  projectId: string;
  sessionId: string;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  taskId: string | null;
  contextUrl: string;
}

type QueuedJob = (ReviewJob & { type?: 'pr' }) | LocalBranchJob;

export class ReviewOrchestrator {
  private queue: QueuedJob[] = [];
  private running = 0;
  /** SHA of the last autofix commit per PR, keyed by "prNumber:repo". */
  private lastAutofixShas = new Map<string, string>();
  /** In-flight post-revert worktree sync promises, keyed by "prNumber:repo". */
  private pendingSyncs = new Map<string, Promise<void>>();

  constructor(
    private reviewService: PRReviewService,
    private sessionManager: SessionManager,
    private maxConcurrency: number = 1,
    private enabled: boolean = true,
    private github?: GitHubClient,
  ) {
    sessionManager.on('pr_opened', (job: ReviewJob) => this.onPrOpened(job));
    sessionManager.on('message', (msg: ServerMessage) => this.onMessage(msg));
    sessionManager.on(
      'revert_sync_registered',
      (payload: {
        prNumber: number;
        repo: string;
        syncPromise: Promise<void>;
      }) => {
        this.registerRevertSync(
          payload.prNumber,
          payload.repo,
          payload.syncPromise,
        );
      },
    );
  }

  /** Store a pending sync promise so executeReview can await it before fetching the diff. */
  registerRevertSync(
    prNumber: number,
    repo: string,
    syncPromise: Promise<void>,
  ): void {
    const key = `${prNumber}:${repo}`;
    this.pendingSyncs.set(key, syncPromise);
  }

  private onPrOpened(job: ReviewJob): void {
    if (!this.enabled) return;
    if (!job.taskId) {
      console.warn(
        `[ReviewOrchestrator] PR #${job.prNumber} has no Notion task — skipping`,
      );
      return;
    }
    this.queue.push(job);
    void this.drain();
  }

  private onMessage(msg: ServerMessage): void {
    if (!this.enabled) return;
    if (msg.type !== 'local_branch_submitted') return;

    const { projectId, sessionId, branchName, baseBranch } = msg;

    const sessionRow = getSession(sessionId);
    if (!sessionRow?.worktree_path) {
      console.warn(
        `[ReviewOrchestrator] local_branch_submitted for session ${sessionId} — no worktree_path, skipping`,
      );
      return;
    }

    const localBranchRow = getLocalBranchBySession(sessionId);
    if (!localBranchRow) {
      console.warn(
        `[ReviewOrchestrator] local_branch_submitted for session ${sessionId} — no local_branch row found, skipping`,
      );
      return;
    }

    const project = getProjectById(projectId);
    const contextUrl = project?.contextUrl ?? '';

    this.queue.push({
      type: 'local_branch',
      localBranchId: localBranchRow.id,
      projectId,
      sessionId,
      branchName,
      baseBranch,
      worktreePath: sessionRow.worktree_path,
      taskId: sessionRow.task_id,
      contextUrl,
    });
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      this.running++;
      const job = this.queue.shift()!;
      try {
        if (job.type === 'local_branch') {
          await this.executeLocalBranchReview(job);
        } else {
          await this.executeReview(job as ReviewJob);
        }
      } catch (e) {
        if (job.type === 'local_branch') {
          console.error(
            `[ReviewOrchestrator] review failed for local branch ${job.branchName}:`,
            e,
          );
        } else {
          const prJob = job as ReviewJob;
          console.error(
            `[ReviewOrchestrator] review failed for PR #${prJob.prNumber}:`,
            e,
          );
        }
      } finally {
        this.running--;
        void this.drain();
      }
    }
  }

  /**
   * Returns true (and consumes the entry) when the given SHA is the autofix
   * commit that was pushed during the last executeReview() for this PR.
   * Used by the push_detected handler to skip re-reviews for autofix-only pushes
   * so they do not count against the iteration cap.
   */
  consumeAutofixSha(prNumber: number, repo: string, sha: string): boolean {
    const key = `${prNumber}:${repo}`;
    if (this.lastAutofixShas.get(key) === sha) {
      this.lastAutofixShas.delete(key);
      return true;
    }
    return false;
  }

  private async executeLocalBranchReview(job: LocalBranchJob): Promise<void> {
    const project = getProjectById(job.projectId);
    if (project) {
      const config = loadOrchestratorConfig(project.projectDir);
      const verifyResult = await runVerifyAsGate(
        job.worktreePath,
        config.verify,
      );
      if (!verifyResult.passed) {
        const autofixCommands = loadAutofixCommands(project.projectDir);
        if (autofixCommands.length > 0) {
          try {
            const autofixResult = await runAutofix(
              job.worktreePath,
              project.projectDir,
              autofixCommands,
              (msg) =>
                console.log(
                  `[ReviewOrchestrator] autofix local branch ${job.branchName}: ${msg}`,
                ),
            );
            if (autofixResult.commitSha) {
              recordEvent({
                event_type: 'autofix_for_ci_failure',
                actor_type: 'system',
                task_id: job.taskId ?? null,
                payload: {
                  pr_number: job.localBranchId,
                  commit_sha: autofixResult.commitSha,
                  failing_checks: verifyResult.failedCommand
                    ? [verifyResult.failedCommand]
                    : [],
                  source: 'verify',
                },
              });
              // Re-run verify to see if autofix resolved it
              const retryResult = await runVerifyAsGate(
                job.worktreePath,
                config.verify,
              );
              if (retryResult.passed) {
                // Autofix fixed the gate — fall through to AI review
              } else {
                setLocalBranchPauseReason(job.localBranchId, 'ci_failing');
                this.sessionManager.send(
                  job.sessionId,
                  formatCIFailureFeedback({
                    source: 'verify',
                    failedCommand: retryResult.failedCommand,
                    truncatedOutput: retryResult.truncatedOutput,
                  }),
                );
                return;
              }
            } else {
              setLocalBranchPauseReason(job.l
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