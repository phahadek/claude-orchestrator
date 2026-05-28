# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Fix: autofix dedup misses revert commits and clears on restart, causing spurious re-reviews
- **Notion task**: https://www.notion.so/Fix-autofix-dedup-misses-revert-commits-and-clears-on-restart-causing-spurious-re-reviews-36e22f9152f381fca400f4281ec3e688
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\0588f1ec-23f4-4067-926c-b40d5431d21f`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\0588f1ec-23f4-4067-926c-b40d5431d21f`).

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
ReviewOrchestrator.consumeAutofixSha is meant to prevent autofix-generated push webhooks from triggering re-reviews. It misses two cases — file-pollution revert commits, and any push that arrives after a backend restart — letting those pushes flow into reReviewPR, which both increments review_iteration and wakes the coding session via sendOrResume. The parallel PRMergeWatcher.lastAutofixShas has the same restart bug for its own use case.
## Dependencies
None.
## Context
The bugs. Two failure modes share one root cause — the autofix dedup store at ReviewOrchestrator.ts:60 (private lastAutofixShas = new Map<string, string>()) is incomplete and ephemeral.
1. Revert commits aren't tracked. runAutofixPipeline (ReviewOrchestrator.ts:185-270) registers only the autofix commit's SHA at line 222. The same pipeline at line 230 invokes runFilePollutionCheck, which can produce a separate revert commit (filePollutionCheck.ts:136, returned as revertCommitSha at line 177). That SHA is dropped on the floor. When GitHub fires push_detected for it, consumeAutofixSha returns false at server.ts:272-285, autofix re-runs, reReviewPR increments review_iteration at PRReviewService.ts:650, and the coding session is woken via sendOrResume at server.ts:385-388.
1. In-memory only. lastAutofixShas is a plain new Map(). A backend restart between the autofix push and the webhook arrival loses the entry — same downstream effect. PRMergeWatcher.ts:38 has its own duplicate in-memory Map with the same restart vulnerability (CI-failure path; on restart, autofix would re-run for a SHA already autofixed).
1. Single SHA per key. Even within one pipeline, the Map shape (Map<string, string>) cannot represent two commits — so any fix for (1) must also widen the shape.
Fix approach.
- New SQLite table orchestrator_autofix_shas (pr_number INTEGER, repo TEXT, sha TEXT, created_at TEXT, PRIMARY KEY (pr_number, repo, sha)). Multiple rows per (pr_number, repo) allowed.
- DB queries: addAutofixSha(prNumber, repo, sha), consumeAutofixSha(prNumber, repo, sha) -> boolean (returns true and deletes the row on match), deleteAllAutofixShasForPR(prNumber, repo).
- In ReviewOrchestrator.runAutofixPipeline: register both the autofix commitSha AND the revertCommitSha returned by runFilePollutionCheck. Replace the in-memory Map with the DB queries.
- In PRMergeWatcher: replace its own lastAutofixShas Map with the same DB-backed queries.
- In PRMergeWatcher.handleMerged (line 338): call deleteAllAutofixShasForPR to clean up entries when the PR merges (this is the same function that marks the Notion task ✅ Done at line 360, so invalidation tracks the task lifecycle exactly). Also clean up when a PR is closed without merging — find the closed-PR code path and call the same delete.
- No TTL — entries live as long as the PR is open.
Out-of-scope constraint: Do NOT change the autofix_started / autofix_complete WS broadcasts emitted from runAutofixPipeline (ReviewOrchestrator.ts:196-200, 257-263). Those drive UI affordances and are intentional. The concern in this task is only the coding-session interaction path (sendOrResume) and the review_iteration counter.
## Acceptance criteria
### 🤖 Automated tests
runAutofixPipeline writes both the autofix commit SHA and the file-pollution revert commit SHA to orchestrator_autofix_shas when both commits occur
consumeAutofixSha returns true (and deletes the row) for a revert commit SHA registered by runFilePollutionCheck
After registering an autofix SHA, a simulated backend restart (new ReviewOrchestrator instance reading from the same DB) still returns true from consumeAutofixSha for that SHA
review_iteration is NOT incremented when push_detected fires for a revert-commit SHA registered by runFilePollutionCheck
sessionManager.sendOrResume is NOT called for the coding session when push_detected fires for a SHA registered by runAutofixPipeline (either autofix or revert)
PRMergeWatcher.handleMerged deletes all rows in orchestrator_autofix_shas for the merged (pr_number, repo)
PR closed without merging also deletes all rows for that (pr_number, repo)
PRMergeWatcher CI-failure path reads dedup state from the DB — after a simulated restart, autofix does NOT re-run for a SHA registered before the restart
Existing consumeAutofixSha semantics preserved: a match deletes only the matching row, leaves siblings for the same PR untouched
## Files / paths affected
- packages/backend/src/github/ReviewOrchestrator.ts (update — remove in-memory lastAutofixShas, use DB; register revert SHA in runAutofixPipeline)
- packages/backend/src/github/PRMergeWatcher.ts (update — remove in-memory lastAutofixShas, use DB; call deleteAllAutofixShasForPR in handleMerged and the PR-closed path)
- packages/backend/src/db/schema.ts (update — add orchestrator_autofix_shas table)
- packages/backend/src/db/queries.ts (update — add addAutofixSha, consumeAutofixSha, deleteAllAutofixShasForPR)
- packages/backend/src/github/ReviewOrchestrator.test.ts (update — new test cases for revert-SHA registration and restart persistence)
- packages/backend/src/github/PRMergeWatcher.test.ts (update — restart persistence test for CI-failure path, cleanup on merge/close)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

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
import { runFilePollutionCheck } from '../session/filePollutionCheck';
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
   * Runs the autofix + file-pollution-check pipeline for a PR.
   * Called from both executeReview (first review) and the server.ts
   * push_detected re-review path so every push goes through the same pipeline.
   */
  async runAutofixPipeline(
    prNumber: number,
    repo: string,
    taskId: string | null,
  ): Promise<void> {
    const project = getProjectByGithubRepo(repo);
    if (!project) return;

    const autofixCommands = loadAutofixCommands(project.projectDir);
    if (autofixCommands.length === 0) return;

    this.sessionManager.emit('message', {
      type: 'autofix_started',
      prNumber,
      repo,
    });

    const prRow = getPRByNumber(prNumber, repo);
    const worktreePath = prRow?.session_id
      ? (getSession(prRow.session_id)?.worktree_path ?? '')
      : '';

    let autofixSuccess = true;
    let autofixSummary = 'no worktree available — autofix skipped';

    if (worktreePath) {
      try {
        const result = await runAutofix(
          worktreePath,
          project.projectDir,
          autofixCommands,
          (msg) =>
            console.log(`[ReviewOrchestrator] autofix PR #${prNumber}: ${msg}`),
        );
        autofixSuccess = result.success;
        autofixSummary = result.summary;
        if (result.commitSha) {
          this.lastAutofixShas.set(`${prNumber}:${repo}`, result.commitSha);
          if (prRow?.session_id && result.touchedFiles?.length) {
            this.sessionManager.addToRevertLock(
              prRow.session_id,
              result.touchedFiles,
            );
          }
          if (this.github) {
            await runFilePollutionCheck({
              github: this.github,
              worktreePath,
              repo,
              prNumber,
              baseBranch: prRow?.base_branch ?? 'dev',
              sessionId: prRow?.session_id ?? null,
              projectId: project.id,
              taskId,
              onReverted: (files) => {
                if (prRow?.session_id) {
                  this.sessionManager.addToRevertLock(prRow.session_id, files);
                }
              },
            });
          }
        }
      } catch (err) {
        autofixSuccess = false;
        autofixSummary = `autofix threw: ${String(err)}`;
        console.error(
          `[ReviewOrchestrator] autofix error for PR #${prNumber}:`,
          err,
        );
      }
    }

    this.sessionManager.emit('message', {
      type: 'autofix_complete',
      prNumber,
      repo,
      success: autofixSuccess,
      summary: autofixSummary,
    });

    if (!autofixSuccess) {
      console.warn(
        `[ReviewOrchestrator] autofix failed for PR #${prNu
[... truncated]
```

### `packages/backend/src/github/PRMergeWatcher.ts`
```
import type { GitHubClient } from './GitHubClient';
import type { MergeabilityCategory } from './types';
import type { SessionManager } from '../session/SessionManager';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { getProjectByGithubRepo } from '../config';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { loadAutofixCommands, runAutofix } from '../session/autofix-runner';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow } from '../db/types';
import type { AutoMerger } from './AutoMerger';
import { formatCIFailureFeedback } from './reviewUtils';
import {
  getAllOpenPRs,
  updatePRState,
  updateMergeState,
  getPRByNumber,
  setPauseReason,
  getSession,
} from '../db/queries';
import { emitTaskUpdated } from '../routes/tasks';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class PRMergeWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * True until the first poll after boot completes. On that first poll, PRs
   * that GitHub reports as already merged are state-transitioned in SQLite
   * without emitting pr_merged — otherwise a backend restart re-fires merge
   * notifications for every PR that closed while the backend was down.
   */
  private firstPollPending = true;
  private autoMerger: AutoMerger | undefined;
  /** SHA of the last autofix commit per PR, keyed by "prNumber:repo". Used to
   *  prevent re-triggering autofix when the autofix commit itself fails CI. */
  private lastAutofixShas = new Map<string, string>();

  constructor(
    private github: GitHubClient,
    private sessions: SessionManager,
    /**
     * Optional fixed task backend. When provided (typically by tests), all status
     * updates go through it. In production this is left undefined and the backend
     * is resolved per-call via getTaskBackend(project.id).
     */
    private taskBackendOverride: TaskBackend | undefined,
    private broadcast: (msg: ServerMessage) => void,
  ) {}

  setAutoMerger(autoMerger: AutoMerger): void {
    this.autoMerger = autoMerger;
  }

  private resolveBackendForRepo(repo: string): TaskBackend | undefined {
    if (this.taskBackendOverride) return this.taskBackendOverride;
    const project = getProjectByGithubRepo(repo);
    if (!project) {
      console.warn(
        `[PRMergeWatcher] no project found for repo ${repo} — skipping task backend update`,
      );
      return undefined;
    }
    return getTaskBackend(project.id);
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((err: unknown) =>
        console.warn('[PRMergeWatcher] poll error:', (err as Error).message),
      );
    }, intervalMs);
    console.log(`[PRMergeWatcher] started (interval=${intervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll(): Promise<void> {
    const silentMerges = this.firstPollPending;
    const openPRs = getAllOpenPRs();
    for (const pr of openPRs) {
      await this.checkPR(pr, silentMerges);
    }
    this.firstPollPending = false;
  }

  private async checkPR(
    pr: PullRequestRow,
    silentMerges: boolean,
  ): Promise<void> {
    let state: string;
    try {
      state = await this.github.getPRState(pr.pr_number, pr.repo);
    } catch (err) {
      console.warn(
        `[PRMergeWatcher] getPRState failed for PR #${pr.pr_number}:`,
        (err as Error).message,
      );
      return;
    }

    if (state === 'merged') {
      await this.handleMerged(pr, null, { silent: silentMerges });
    } else if (state === 'closed') {
      updatePRState(pr.pr_number, pr.repo, 'closed');
      this.broadcast({
        type: 'pr_closed',
        prNumber: pr.pr_number,
        repo: pr.repo,
      });
    } else {
      // PR is still open — check mergeability for approved PRs
      await this.checkMergeability(pr);
    }
  }

  private async checkMergeability(pr: PullRequestRow): Promise<void> {
    // Only poll mergeability for PRs that have an approved verdict
    if (!pr.review_result) return;
    let verdict: string | undefined;
    try {
      const parsed = JSON.parse(pr.review_result) as { verdict?: string };
      verdict = parsed.verdict;
    } catch {
      return;
    }
    if (verdict !== 'approved') return;
    await this.runMergeabilityCheck(pr);
  }

  /**
   * Run an immediate mergeability check for the given PR, regardless of verdict.
   * Called after a review completes with verdict 'approved' so the DB merge_state
   * and Merge button reflect current state without waiting for the next 5-min poll.
   */
  async checkMergeabilityNow(prNumber: number, repo: string): Promise<void> {
    const pr = getPRByNumber(prNumber, repo);
    if (!pr) return;
    await this.runMergeabilityCheck(pr);
  }

  private async runMergeabilityCheck(pr: PullRequestRow): Promise<void> {
    if (pr.state === 'merged' || pr.state === 'closed') return;

    const project = getProjectByGithubRepo(pr.repo);
    const ciCheckNames = project
      ? loadOrchestratorConfig(project.projectDir).ci_check_name
      : [];

    let category: MergeabilityCategory;
    try {
      category = await this.github.categorizeMergeability(
        pr.pr_number,
        pr.repo,
        ciCheckNames,
      );
    } catch (err) {
      console.warn(
        `[PRMergeWatcher] categorizeMergeability failed for PR #${pr.pr_number}:`,
        (err as Error).message,
      );
      return;
    }

    // Re-read DB after the network round-trip. If the PR merged or closed while
    // we were waiting on GitHub, suppress all downstream side effects — the
    // session was endSession()'d on merge and we must not sendOrResume it back to life.
    const fresh = getPRByNumber(pr.pr_number, pr.repo);
    if (fresh?.state === 'merged' || fresh?.state === 'closed') return;

    // Skip if GitHub hasn't computed mergeability yet
    if (category.category === 'unknown' && category.rawMergeableState === null)
      return;

    const failingNames = category.failingChecks.map((c) => c.name);
    const prevFailingNames = parseFailingChecksRaw(pr.failing_checks);
    const stateChanged = pr.merge_state !== category.mergeState;
    const failingChecksChanged = !arraysShallowEqual(
      prevFailingNames,
      failingNames,
    );

    // Only update + broadcast if something actually changed.
    if (!stateChanged && !failingChecksChanged) {
      this.tryCIFailingRecovery(pr, category.mergeState);
      return;
    }

    const mergeableInt = category.category === 'clean' ? 1 : 0;
    const failingNamesOrNull = failingNames.length > 0 ? failingNames : null;
    updateMergeState(
      pr.pr_number,
      pr.repo,
      mergeableInt,
      category.mergeState,
      failingNamesOrNull,
    );
    this.broadcast({
      type: 'pr_mergeability_changed',
      prNumber: pr.pr_number,
      repo: pr.repo,
      mergeable: category.category === 'clean',
      mergeState: category.mergeState,
      failingChecks: failingNamesOrNull,
    });
    if (pr.task_id) {
      emitTaskUpdated(pr.task_id);
    }

    this.tryCIFailingRecovery(pr, category.mergeState);

    // Send session messages only when the state itself transitioned, so the
    // agent doesn't get re-pinged every 5-minute poll for unchanged states.
    if (!stateChanged) return;

    if (category.category === 'conflict') {
      console.log(
        `[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} has merge conflicts`,
      );
      if (pr.session_id) {
        const baseBranch = pr.base_branch ?? 'dev';
        const msg = `PR #${pr.pr_number} has merge conflicts with the base branch. Rebase onto \`${baseBranch}\`, resolve the conflicts, and push the fixed branch.`;
        this.sessions
          .sendOrResume(pr
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

### `packages/backend/src/db/queries.ts`
```
import { db } from './db';
import type {
  Session,
  NewSession,
  SessionEvent,
  NewSessionEvent,
  PermissionEvent,
  NewPermissionEvent,
  PermissionRule,
  NewPermissionRule,
  PermissionDenialRow,
  NewPermissionDenialRow,
  TaskCache,
  PullRequestRow,
  PauseReason,
  ProjectRow,
  NewProjectRow,
  MilestoneRow,
  NewMilestoneRow,
  LocalBranchRow,
  NewLocalBranchRow,
  DeviceRow,
  NewDeviceRow,
} from './types';

// ─── sessions ──────────────────────────────────────────────────────────────

const stmtInsertSession = db.prepare<NewSession>(`
  INSERT INTO sessions
    (session_id, task_id, task_url, project_context_url,
     project_id, status, started_at, ended_at, pr_url, worktree_path, session_type, task_name)
  VALUES
    (@session_id, @task_id, @task_url, @project_context_url,
     @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path, @session_type, @task_name)
`);

const stmtUpdateSessionStatus = db.prepare<{
  session_id: string;
  status: string;
  ended_at: number | null;
}>(`
  UPDATE sessions
  SET status = @status, ended_at = @ended_at
  WHERE session_id = @session_id
`);

const stmtGetSession = db.prepare<{ session_id: string }>(`
  SELECT * FROM sessions WHERE session_id = @session_id
`);

const stmtGetAllSessions = db.prepare(`
  SELECT * FROM sessions ORDER BY started_at DESC
`);

const stmtGetAllSessionIds = db.prepare(`
  SELECT session_id FROM sessions
`);

const stmtDeleteSessionEvents = db.prepare<{ session_id: string }>(`
  DELETE FROM session_events WHERE session_id = @session_id
`);

const stmtDeleteSession = db.prepare<{ session_id: string }>(`
  DELETE FROM sessions WHERE session_id = @session_id
`);

const stmtInsertSessionOrIgnore = db.prepare<NewSession>(`
  INSERT OR IGNORE INTO sessions
    (session_id, task_id, task_url, project_context_url,
     project_id, status, started_at, ended_at, pr_url, worktree_path, session_type, task_name)
  VALUES
    (@session_id, @task_id, @task_url, @project_context_url,
     @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path, @session_type, @task_name)
`);

export function insertSession(s: NewSession): void {
  stmtInsertSession.run({
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    project_id: null,
    session_type: 'standard',
    ...s,
    task_name: s.task_name ?? null,
  });
}

export function updateSessionStatus(
  sessionId: string,
  status: string,
  endedAt?: number,
): void {
  stmtUpdateSessionStatus.run({
    session_id: sessionId,
    status,
    ended_at: endedAt ?? null,
  });
}

const stmtMarkSessionDone = db.prepare<{
  session_id: string;
  ended_at: number;
  pr_url: string | null;
}>(`
  UPDATE sessions
  SET status = 'done', ended_at = @ended_at, pr_url = COALESCE(@pr_url, pr_url)
  WHERE session_id = @session_id
`);

/**
 * Atomically mark a session as done, setting ended_at and pr_url in a single
 * write. Preferred over updateSessionStatus for clean-exit paths because it
 * also persists pr_url without a second round-trip.
 * pr_url is only overwritten when non-null — existing value is preserved otherwise.
 */
export function markSessionDone(
  sessionId: string,
  endedAt: number,
  prUrl?: string | null,
): void {
  stmtMarkSessionDone.run({
    session_id: sessionId,
    ended_at: endedAt,
    pr_url: prUrl ?? null,
  });
}

/**
 * Backfill sessions that are stuck at status='running' but whose last recorded
 * event is a 'result' event (the CLI's clean-exit signal). These sessions
 * completed normally but the done transition was missed — most likely because
 * the downstream review pipeline threw before handleCleanExit could persist it.
 * Returns the number of sessions updated.
 */
export function backfillStuckResultSessions(): number {
  const stuckRows = db
    .prepare(
      `
    SELECT s.session_id, e.timestamp AS last_ts
    FROM sessions s
    JOIN session_events e ON e.session_id = s.session_id
    WHERE s.status = 'running'
      AND e.id = (
        SELECT MAX(id) FROM session_events WHERE session_id = s.session_id
      )
      AND e.event_type = 'result'
  `,
    )
    .all() as Array<{ session_id: string; last_ts: number }>;

  if (stuckRows.length === 0) return 0;

  const updateStmt = db.prepare(
    `UPDATE sessions SET status = 'done', ended_at = ? WHERE session_id = ? AND status = 'running'`,
  );

  for (const row of stuckRows) {
    updateStmt.run(row.last_ts, row.session_id);
    console.log(
      `[backfill] session ${row.session_id.slice(0, 8)} running→done (last_event=result at ${new Date(row.last_ts).toISOString()})`,
    );
  }
  return stuckRows.length;
}

export function getSession(sessionId: string): Session | undefined {
  return stmtGetSession.get({ session_id: sessionId }) as Session | undefined;
}

export function getAllSessions(): Session[] {
  return stmtGetAllSessions.all() as Session[];
}

export function getAllSessionIds(): string[] {
  return (stmtGetAllSessionIds.all() as { session_id: string }[]).map(
    (r) => r.session_id,
  );
}

export function insertSessionOrIgnore(s: NewSession): void {
  stmtInsertSessionOrIgnore.run({
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    project_id: null,
    session_type: 'standard',
    ...s,
    task_name: s.task_name ?? null,
  });
}

export function deleteSession(sessionId: string): boolean {
  stmtDeleteSessionEvents.run({ session_id: sessionId });
  const result = stmtDeleteSession.run({ session_id: sessionId });
  return result.changes > 0;
}

/**
 * Delete sessions that have no events — these are "ghost sessions" created by
 * either empty JSONL imports or session starts that never ran the subprocess.
 * Returns the number of sessions deleted.
 */
export function deleteGhostSessions(): number {
  const result = db
    .prepare(
      `
    DELETE FROM sessions
    WHERE session_id NOT IN (SELECT DISTINCT session_id FROM session_events)
  `,
    )
    .run();
  return result.changes;
}

export function getSessionsByStatus(statuses: string[]): Session[] {
  const placeholders = statuses.map(() => '?').join(', ');
  return db
    .prepare(
      `
    SELECT * FROM sessions WHERE status IN (${placeholders}) ORDER BY started_at DESC
  `,
    )
    .all(...statuses) as Session[];
}

/**
 * Returns true when a standard (non-review) session is currently active for the
 * given task id. "Active" means not in a terminal status (done, error, killed).
 * Used by AutoLauncher to avoid re-launching a task whose status hasn't yet
 * propagated back from the task backend.
 * Strips hyphens from both sides to normalize UUID format differences.
 */
export function hasActiveSessionForTask(taskId: string): boolean {
  const norm = taskId.replace(/-/g, '');
  const row = db
    .prepare<{ task_id: string }>(
      `
    SELECT 1 FROM sessions
    WHERE REPLACE(COALESCE(task_id, ''), '-', '') = @task_id
      AND status NOT IN ('done', 'error', 'killed')
      AND (session_type = 'standard' OR session_type IS NULL)
    LIMIT 1
  `,
    )
    .get({ task_id: norm });
  return !!row;
}

export function getActiveSessions(): Session[] {
  // LEFT JOIN pull_requests so that prUrl is populated even when sessions.pr_url
  // is NULL (e.g. sessions started before their PR was linked back to the row).
  return db
    .prepare(
      `
    SELECT
      s.session_id, s.task_id, s.task_url, s.project_context_url,
      s.project_id, s.status, s.started_at, s.ended_at, s.worktree_path,
      s.archived, s.favorited, s.session_type, s.note, s.tags,
      s.total_input_tokens, s.total_output_tokens, s.model, s.task_name,
      COALESCE(s.pr_url, (
        SELECT p.pr_url FROM pull_requests p WHERE p.session_id = s.session_id LIMIT 1
      )) AS pr_url
    FROM sessions s
    WHERE s.archived = 0
    ORDER BY s.started_at DESC
  `,
    )
    .all() as Session[];
}

export function getArchivedSessions(): Session[] {
  return db
    .prepare(
      'SELECT * FROM sessions WHERE archived = 1 ORDER BY started_at DESC',
   
[... truncated]
```

### `packages/backend/src/github/ReviewOrchestrator.test.ts`
```
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../db/queries.js', () => ({
  setPRReviewResult: vi.fn(),
  getPRByNumber: vi.fn(),
  getSession: vi.fn().mockReturnValue(undefined),
  getSetting: vi.fn().mockReturnValue(undefined),
  incrementReviewIteration: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  setPendingPush: vi.fn(),
  setPauseReason: vi.fn(),
  getLocalBranchBySession: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
}));

vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
}));

vi.mock('../session/filePollutionCheck.js', () => ({
  runFilePollutionCheck: vi
    .fn()
    .mockResolvedValue({ headSha: null, revertCommitSha: null }),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

const projectFixture = {
  id: 'proj-1',
  name: 'Project 1',
  githubRepo: 'owner/repo',
  projectDir: '/tmp',
  contextUrl: 'https://notion.so/ctx',
  boardId: 'board-1',
  gitMode: 'github' as const,
};

const localOnlyProjectFixture = {
  id: 'proj-local',
  name: 'Local Project',
  projectDir: '/repos/local',
  contextUrl: 'https://notion.so/ctx-local',
  boardId: 'board-local',
  gitMode: 'local-only' as const,
};

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === 'owner/repo' ? projectFixture : undefined,
  ),
  getAllProjects: vi.fn(() => [projectFixture]),
  getProjectById: vi.fn((id: string) => {
    if (id === 'proj-1') return projectFixture;
    if (id === 'proj-local') return localOnlyProjectFixture;
    return undefined;
  }),
}));

vi.mock('../orchestration/verifyRunner.js', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    verify: [],
    autofix: [],
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    bootstrap_script: '',
  }),
}));

import { ReviewOrchestrator } from './ReviewOrchestrator';
import {
  setPRReviewResult,
  getPRByNumber,
  getSession,
  updatePRDraftStatus,
  setPauseReason,
  getLocalBranchBySession,
  setLocalBranchPauseReason,
} from '../db/queries';
import { loadAutofixCommands, runAutofix } from '../session/autofix-runner';
import { runFilePollutionCheck } from '../session/filePollutionCheck';
import { recordEvent } from '../audit/AuditLog';
import { runVerifyAsGate } from '../orchestration/verifyRunner';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import type { PRReviewService } from './PRReviewService';
import type { GitHubClient } from './GitHubClient';
import type { PullRequest } from './types';
import type { ReviewJob } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const baseFreshPR: PullRequest = {
  nodeId: 'node-1',
  id: 1,
  title: 'feat: test',
  body: null,
  url: 'https://github.com/owner/repo/pull/1',
  apiUrl: 'https://api.github.com/repos/owner/repo/pulls/1',
  headBranch: 'feature/test',
  headSha: 'sha-abc',
  baseBranch: 'dev',
  state: 'open',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  mergeableState: null,
  draft: false,
};

function makeMockGitHubClient(
  fetchPRResolveWith?: Partial<PullRequest>,
): GitHubClient {
  return {
    markPRReady: vi.fn().mockResolvedValue(undefined),
    fetchPR: vi
      .fn()
      .mockResolvedValue({ ...baseFreshPR, ...fetchPRResolveWith }),
  } as unknown as GitHubClient;
}

function makeMockNotionClient() {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    send: vi.fn(),
    addToRevertLock: vi.fn(),
  });
}

function makeMockReviewService(resolveWith?: object): PRReviewService {
  const defaultResult = {
    prNumber: 1,
    repo: 'owner/repo',
    verdict: 'approved',
    dimensions: [],
    summary: 'All good.',
    reviewedAt: new Date().toISOString(),
  };
  return {
    reviewPR: vi.fn().mockResolvedValue(resolveWith ?? defaultResult),
    sendReReview: vi
      .fn()
      .mockResolvedValue({ ...defaultResult, summary: 'Fixed.' }),
    reReviewPR: vi.fn().mockResolvedValue(resolveWith ?? defaultResult),
  } as unknown as PRReviewService;
}

const baseJob: ReviewJob = {
  prNumber: 1,
  repo: 'owner/repo',
  taskId: 'task-abc',
  taskUrl: 'https://notion.so/task',
  contextUrl: 'https://notion.so/ctx',
};

const basePRRow = {
  id: 1,
  pr_number: 1,
  pr_url: 'https://github.com/owner/repo/pull/1',
  task_id: 'notion:task-abc',
  session_id: 'coding-session-id',
  repo: 'owner/repo',
  title: 'feat: test',
  body: null,
  head_branch: 'feature/test',
  base_branch: 'dev',
  state: 'open',
  draft: 0,
  review_result: null,
  review_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  synced_at: '2024-01-01T00:00:00Z',
  review_session_id: 'review-session-id',
  review_iteration: 0,
  head_sha: 'sha-abc',
  last_reviewed_sha: null,
  node_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Disabled orchestrator ─────────────────────────────────────────────────────

describe('ReviewOrchestrator — disabled', () => {
  it('does not enqueue when enabled === false', async () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, false);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
  });
});

// ── Missing taskId ────────────────────────────────────────────────────────────

describe('ReviewOrchestrator — missing taskId', () => {
  it('does not enqueue when job.taskId is empty', async () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', { ...baseJob, taskId: '' });
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
  });
});

// ── Concurrency ───────────────────────────────────────────────────────────────

describe('ReviewOrchestrator — concurrency', () => {
  it('respects maxConcurrency=1 (second job waits for first to complete)', async () => {
    const sm = makeMockSessionManager();

    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let firstResolve!: () => void;
    const firstComplete = new Promise<void>((resolve) => {
      firstResolve = resolve;
    });

    const callOrder: number[] = [];
    const rs = {
      reviewPR: vi
        .fn()
        .mockImplementationOnce(async () => {
          callOrder.push(1);
          resolveFirst();
          await firstComplete;
          return {
            prNumber: 1,
            repo: 'owner/repo',
            verdict: 'approved',
            dimensions: [],
            summary: 'ok',
            reviewedAt: '',
          };
        })
        .mockImplementationOnce(async () => {
          callOrder.push(2);
          return {
            prNumber: 2,
            repo: 'owner/repo',
            verdict: 'approved',
            dimensions: [],
            summary: 'ok',
            reviewedAt: '',
          };
        }),
      sendReReview: vi.fn(),
      reReviewPR: vi.fn(),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', { ...baseJob, prNumber: 1 });
    sm.emit('pr_opened', { ...baseJob, prNumber: 2 });

    // Wait for first job to start
    await firstStarted;
    // Second job should not have started yet
    exp
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