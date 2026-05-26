# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Add human approval gate to auto-merge (corporate mode)
- **Notion task**: https://www.notion.so/Add-human-approval-gate-to-auto-merge-corporate-mode-36b22f9152f381e08effd1bbc8ac0198
- **Project context**: https://www.notion.so/33222f9152f38188b65fd912e40890a2

---

## Lifecycle

Follow these steps in order — every session:

> **Task spec is pre-loaded below.** Do NOT fetch Notion pages — the task content has
> already been injected by the orchestrator. Proceed directly to implementation.

1. Read the **Task Spec** section below — it contains the full task specification.
2. Create a feature branch: `feature/<task-name>` from `dev`.
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

- Branch name: `feature/<task-name>` from `dev`
- Never commit directly to `dev` or `main`
- Never merge your own PR
- One task per session — no scope creep

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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\5c89e9e5-9929-4f3e-8896-a2c7f3487e4c`.**
> This is your `cwd`. All commands run here. Never navigate to or operate on any parent directory.

- All git commands must run inside the worktree directory (your `cwd`)
- Never use `git -C <path>` pointing outside this worktree
- Never use `--work-tree` or `--git-dir` flags pointing outside this worktree
- Never run `git checkout` or `git switch` targeting a branch in the main repo directory
- The backend records the main repo branch before each session and will warn if it drifts

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
When corporate mode is on, the auto-merge path must wait for GitHub's PR review state to be APPROVED by a human reviewer before merging — in addition to existing CI / no-pause-reason gates.
## Dependencies
- Introduce milestone-feature-branch + task-branch model
- Implement corporate-mode config layer
## Context
Today, packages/backend/src/github/AutoMerger.ts:run() checks pause_reason (line ~89) and CI status (line ~96-149) before calling GitHub's merge endpoint. There is no approval-state check. In corporate mode, this must become a hard gate.
### What changes
1. Add a GitHub API call to fetch the PR's current review state. The current GitHubClient.ts already has GraphQL access (used for markPullRequestReadyForReview) — extend with a getReviewState(prNumber) method.
1. In AutoMerger.run(), after the CI-status check, branch on getCorporateMode().gates.requireHumanApproval:
1. When approval has not yet been given but everything else is green, the PR stays open with a new pause reason (awaiting_human_approval). The poll loop keeps checking.
1. If the human leaves a CHANGES_REQUESTED review, route the change request through the reviewer-comment-routing task's logic (next task). For this task: at minimum, pause with human_changes_requested and a notification.
### Files likely to change
- packages/backend/src/github/AutoMerger.ts (update — new gate)
- packages/backend/src/github/GitHubClient.ts (update — add getReviewState)
- packages/backend/src/session/types.ts or wherever pause reasons live (update — add new reasons)
## Design specifics inherited from Wave-1
Per the governance design (Task 2):
- Insertion point in AutoMerger.run(): after the existing CI-status check (~line 96-149), before calling GitHubClient.mergePR().
- New GitHubClient.getReviewState(prNumber) method — extends the existing GraphQL access used by markPullRequestReadyForReview.
- Pause-reason additions (declared in T6, used here): awaiting_human_approval, human_changes_requested.
- Observation: poll-based, riding the existing 5s AutoMerger cycle. No webhooks (revisit if M6 expands to shared-instance, currently Future Scope).
- isAIReviewer predicate dependency: T12 (attribution) provides the canonical predicate. Until T12 lands, fall back to checking the reviewer username against a configured ai_reviewer_usernames set in settings.
- Non-corporate mode is unchanged — no approval check is performed; existing CI-green + no-pause-reason gate remains.
## Acceptance criteria
### 🤖 Automated tests
tsc --noEmit passes for both packages
Unit test: in corporate mode with an APPROVED review state, auto-merge proceeds
Unit test: in corporate mode with no review state (REVIEW_REQUIRED), auto-merge does not call the merge endpoint and pauses with awaiting_human_approval
Unit test: in corporate mode with CHANGES_REQUESTED, auto-merge pauses with human_changes_requested
Unit test: in non-corporate mode, existing behaviour is preserved (no approval check)
### 👁️ Manual verification
Covered by the Manual Verification Gate task.
## Files / paths affected
- packages/backend/src/github/AutoMerger.ts (update)
- packages/backend/src/github/GitHubClient.ts (update)
- Pause-reason type definition (update)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/github/AutoMerger.ts`
```
import {
  getProjectByGithubRepo,
  getProjectById,
  runtimeSettings,
} from '../config';
import {
  getPRByNumber,
  setPauseReason,
  updateMergeState,
  getApprovedOpenPRs,
  getApprovedLocalBranches,
  markLocalBranchMerged,
  setLocalBranchPauseReason,
  getSession,
} from '../db/queries';
import type { GitHubClient } from './GitHubClient';
import { GitHubApiError } from './types';
import type { PRMergeWatcher } from './PRMergeWatcher';
import type { PullRequestRow } from '../db/types';
import type { ServerMessage } from '../ws/types';
import { emitTaskUpdated } from '../routes/tasks';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import type { SessionManager } from '../session/SessionManager';
import { getTaskBackend } from '../tasks/TaskBackend';
import { squashMergeLocal } from '../orchestration/localMergeRunner';
import { detectMergeConflict } from '../orchestration/localBranchHelpers';
import { formatMergeConflictFeedback } from './reviewUtils';

const MIN_POLL_INTERVAL_MS = 5_000;

/**
 * Drives the post-approval auto-merge flow. After review reaches an approved
 * verdict and CI turns green, squash-merges the PR to dev and lets
 * PRMergeWatcher complete the lifecycle. On any other outcome the task is
 * paused with a pause_reason so a human picks it up.
 *
 * Per-project — only runs for projects with `autoMergeEnabled === true`.
 * Skips PRs already paused (honors any existing pause_reason).
 */
export class AutoMerger {
  /** In-flight auto-merge loops keyed by `${repo}#${prNumber}` to prevent double-runs. */
  private active = new Set<string>();

  constructor(
    private github: GitHubClient,
    private mergeWatcher: PRMergeWatcher,
    private broadcast: (msg: ServerMessage) => void,
    private sessions?: SessionManager,
  ) {}

  private key(prNumber: number, repo: string): string {
    return `${repo}#${prNumber}`;
  }

  /**
   * Poll both pull_requests and local_branches for merge-ready items and
   * dispatch to the appropriate merge handler. PRs go through the existing
   * attempt() loop; local branches are squash-merged immediately.
   */
  async pollOnce(): Promise<void> {
    const approvedPRs = getApprovedOpenPRs();
    for (const pr of approvedPRs) {
      this.attempt(pr.pr_number, pr.repo);
    }

    const approvedLocalBranches = getApprovedLocalBranches();
    for (const row of approvedLocalBranches) {
      await this.handleLocalBranchMerge(row);
    }
  }

  private async handleLocalBranchMerge(
    row: ReturnType<typeof getApprovedLocalBranches>[number],
  ): Promise<void> {
    const session = row.session_id ? getSession(row.session_id) : undefined;
    if (!session) {
      console.warn(
        `[AutoMerger] local branch #${row.id} (${row.branch_name}): session ${row.session_id} not found — skipping`,
      );
      return;
    }

    const worktreePath = session.worktree_path;
    if (!worktreePath) {
      console.warn(
        `[AutoMerger] local branch #${row.id} (${row.branch_name}): no worktree_path on session — skipping`,
      );
      return;
    }

    const hasConflict = await detectMergeConflict(
      worktreePath,
      row.base_branch,
      row.branch_name,
    ).catch((err: unknown) => {
      console.warn(
        `[AutoMerger] local branch #${row.id}: detectMergeConflict failed: ${(err as Error).message}`,
      );
      return false;
    });

    if (hasConflict) {
      setLocalBranchPauseReason(row.id, 'merge_conflict');
      if (this.sessions && session.session_id) {
        this.sessions
          .sendOrResume(
            session.session_id,
            formatMergeConflictFeedback({
              branchName: row.branch_name,
              baseBranch: row.base_branch,
            }),
          )
          .catch((err: unknown) =>
            console.warn(
              `[AutoMerger] local branch #${row.id}: sendOrResume failed: ${(err as Error).message}`,
            ),
          );
      }
      return;
    }

    const taskName = session.task_name ?? row.branch_name;

    const result = await squashMergeLocal({
      worktreePath,
      baseBranch: row.base_branch,
      featureBranch: row.branch_name,
      taskName,
    }).catch((err: unknown) => {
      console.warn(
        `[AutoMerger] local branch #${row.id}: squashMergeLocal threw: ${(err as Error).message}`,
      );
      return { merged: false as const, conflict: false };
    });

    if (!result.merged) {
      if (result.conflict) {
        setLocalBranchPauseReason(row.id, 'merge_conflict');
        if (this.sessions && session.session_id) {
          this.sessions
            .sendOrResume(
              session.session_id,
              formatMergeConflictFeedback({
                branchName: row.branch_name,
                baseBranch: row.base_branch,
              }),
            )
            .catch((err: unknown) =>
              console.warn(
                `[AutoMerger] local branch #${row.id}: sendOrResume failed: ${(err as Error).message}`,
              ),
            );
        }
      }
      return;
    }

    const commitSha = result.commitSha ?? null;

    markLocalBranchMerged(row.id, commitSha);

    if (this.sessions && session.session_id) {
      this.sessions.endSession(session.session_id);
    }

    if (session.notion_task_id) {
      const project = getProjectById(row.project_id);
      if (project) {
        const backend = getTaskBackend(row.project_id);
        backend
          .updateStatus(session.notion_task_id, '✅ Done')
          .catch((err: unknown) =>
            console.warn(
              `[AutoMerger] local branch #${row.id}: updateStatus failed: ${(err as Error).message}`,
            ),
          );
      }
    }

    this.broadcast({
      type: 'local_branch_merged',
      projectId: row.project_id,
      sessionId: session.session_id,
      branchName: row.branch_name,
      commitSha,
    });

    console.log(
      `[AutoMerger] local branch ${row.branch_name} squash-merged into ${row.base_branch} (${commitSha ?? 'no sha'})`,
    );
  }

  /**
   * Try to auto-merge the given PR. Returns immediately (does not await the
   * polling loop). The loop runs to completion in the background.
   */
  attempt(
    prNumber: number,
    repo: string,
    options?: { bypassToggle?: boolean },
  ): void {
    const k = this.key(prNumber, repo);
    if (this.active.has(k)) return;
    this.active.add(k);
    void this.run(prNumber, repo, options).finally(() => this.active.delete(k));
  }

  private async run(
    prNumber: number,
    repo: string,
    options?: { bypassToggle?: boolean },
  ): Promise<void> {
    const project = getProjectByGithubRepo(repo);
    if (!project) {
      console.log(
        `[AutoMerger] PR #${prNumber}: no project for repo ${repo} — skipping`,
      );
      return;
    }
    if (!options?.bypassToggle && !project.autoMergeEnabled) return;

    const initialRow = getPRByNumber(prNumber, repo);
    if (!initialRow) return;
    if (initialRow.pause_reason !== null) {
      console.log(
        `[AutoMerger] PR #${prNumber}: paused (${initialRow.pause_reason}) — skipping`,
      );
      return;
    }
    if (initialRow.state !== 'open') return;

    const ciCheckNames = loadOrchestratorConfig(
      project.projectDir,
    ).ci_check_name;

    const intervalSec = Math.max(1, runtimeSettings.ci_poll_interval_seconds);
    const intervalMs = Math.max(intervalSec * 1000, MIN_POLL_INTERVAL_MS);
    const deadline =
      Date.now() + Math.max(1, runtimeSettings.ci_poll_max_minutes) * 60_000;

    let etag: string | null = null;

    console.log(
      `[AutoMerger] starting for PR #${prNumber} in ${repo} (interval=${intervalSec}s, max=${runtimeSettings.ci_poll_max_minutes}m)`,
    );

    while (Date.now() < deadline) {
      // Re-read the PR row each iteration so external pause/close updates are honored.
      const row = getPRByNumber(prNumber, repo);
      if (!row) return;
      if (row.pause_reason !== null) {
       
[... truncated]
```

### `packages/backend/src/github/GitHubClient.ts`
```
import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import {
  GitHubApiError,
  PullRequest,
  PRDiff,
  MergeResult,
  FailingCheck,
  MergeabilityCategory,
} from './types';
import { getPRByNumber } from '../db/queries';

/** GitHub check-run conclusions that indicate the check did not pass. */
const FAILING_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'action_required',
  'cancelled',
  'stale',
  'startup_failure',
]);

export class GitHubClient {
  private readonly base = 'https://api.github.com';
  private readonly headers: HeadersInit;

  constructor() {
    this.headers = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async listOpenPRs(repo?: string): Promise<PullRequest[]> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<GitHubRawPR[]>(
      `/repos/${r}/pulls?state=open&per_page=100`,
    );
    return data.map((pr) => mapPR(pr));
  }

  async getPRState(
    prNumber: number,
    repo?: string,
  ): Promise<'open' | 'merged' | 'closed'> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<{ state: string; merged: boolean }>(
      `/repos/${r}/pulls/${prNumber}`,
    );
    if (data.merged) return 'merged';
    if (data.state === 'closed') return 'closed';
    return 'open';
  }

  async fetchPR(repo: string, prNumber: number): Promise<PullRequest> {
    const data = await this.request<GitHubRawPR>(
      `/repos/${repo}/pulls/${prNumber}`,
    );
    return mapPR(data);
  }

  async getMergeability(
    prNumber: number,
    repo?: string,
  ): Promise<{ mergeable: boolean | null; mergeableState: string | null }> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<GitHubRawPR>(
      `/repos/${r}/pulls/${prNumber}`,
    );
    return {
      mergeable: data.mergeable ?? null,
      mergeableState: data.mergeable_state ?? null,
    };
  }

  // Retry getMergeability with exponential backoff (2s, 4s, 8s, 16s, 32s) when
  // GitHub returns mergeable: null. After all 5 retries, returns the last (still-null) result.
  async getMergeabilityWithRetry(
    prNumber: number,
    repo?: string,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ): Promise<{ mergeable: boolean | null; mergeableState: string | null }> {
    const delays = [2000, 4000, 8000, 16000, 32000];
    let result = await this.getMergeability(prNumber, repo);
    for (const delay of delays) {
      if (result.mergeable !== null) return result;
      await sleep(delay);
      result = await this.getMergeability(prNumber, repo);
    }
    if (result.mergeable === null) {
      console.warn(
        `[GitHubClient] getMergeability still null after retries for PR #${prNumber} in ${repo ?? GITHUB_REPO} — skipping`,
      );
    }
    return result;
  }

  async fetchDiff(
    prId: number,
    repo?: string,
    branches?: { base: string; head: string },
  ): Promise<PRDiff> {
    const r = repo ?? GITHUB_REPO;
    let diff: string;
    if (branches) {
      // Explicit three-dot compare endpoint — guarantees merge-base semantics
      diff = await this.request<string>(
        `/repos/${r}/compare/${branches.base}...${branches.head}`,
        { headers: { ...this.headers, Accept: 'application/vnd.github.diff' } },
      );
    } else {
      diff = await this.request<string>(`/repos/${r}/pulls/${prId}`, {
        headers: { ...this.headers, Accept: 'application/vnd.github.diff' },
      });
    }
    const filesChanged = parseDiffFiles(diff);
    return { prId, diff, filesChanged };
  }

  async markPRReady(repo: string, prNumber: number): Promise<void> {
    const prRow = getPRByNumber(prNumber, repo);
    if (!prRow?.node_id) {
      const pr = await this.fetchPR(repo, prNumber);
      await this.markPRReadyByNodeId(pr.nodeId);
      return;
    }
    await this.markPRReadyByNodeId(prRow.node_id);
  }

  private async markPRReadyByNodeId(nodeId: string): Promise<void> {
    const query = `mutation($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest { isDraft }
      }
    }`;
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { pullRequestId: nodeId } }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GitHubApiError(res.status, text);
    }
    const body = (await res.json()) as { errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new GitHubApiError(
        422,
        body.errors.map((e) => e.message).join('; '),
      );
    }
  }

  /**
   * Fetch failing check-runs for a given commit SHA. Used to distinguish
   * "blocked by failing CI" from "blocked by branch protection" when a merge
   * attempt fails with 409/405 or when mergeable_state is `unstable`/`blocked`.
   */
  async getFailingChecks(sha: string, repo?: string): Promise<FailingCheck[]> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<{
      check_runs: Array<{
        name: string;
        status: string;
        conclusion: string | null;
      }>;
    }>(`/repos/${r}/commits/${sha}/check-runs?per_page=100`);
    return data.check_runs
      .filter(
        (c) =>
          c.status === 'completed' &&
          c.conclusion !== null &&
          FAILING_CHECK_CONCLUSIONS.has(c.conclusion),
      )
      .map((c) => ({ name: c.name, conclusion: c.conclusion as string }));
  }

  /**
   * Map GitHub's mergeable_state (plus check-runs when relevant) onto a single
   * category so the dashboard can tell merge conflicts apart from CI failures
   * and branch-protection blocks. Returns `clean` when mergeable, otherwise one
   * of `conflict` / `ci_failed` / `blocked` / `unknown`.
   *
   * Called after a 409/405 merge failure to pick the right remediation, and by
   * PRMergeWatcher polling so the state is reflected before the user clicks Merge.
   *
   * @param ciCheckNames When non-empty, only checks in this list are considered
   *   when categorizing CI failures. Checks not in the list are ignored. A named
   *   check absent from the PR's check-runs is treated as pending (unknown).
   *   When empty (default), all checks count — existing behaviour.
   */
  async categorizeMergeability(
    prNumber: number,
    repo?: string,
    ciCheckNames: string[] = [],
  ): Promise<MergeabilityCategory> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<GitHubRawPR>(
      `/repos/${r}/pulls/${prNumber}`,
    );
    return this.categorizeFromRawPR(data, r, ciCheckNames);
  }

  /**
   * Conditional PR status fetch with ETag/If-None-Match support. Returns the
   * categorized mergeability when GitHub returns 200 (with the new ETag), or
   * `{ status: 'not_modified' }` when GitHub returns 304 (no body, ETag stays
   * the same). Used by AutoMerger to avoid burning GitHub quota while polling
   * a slow-to-change PR.
   */
  async fetchPRStatusConditional(
    prNumber: number,
    repo: string,
    etag?: string | null,
    ciCheckNames: string[] = [],
  ): Promise<
    | { status: 'not_modified'; etag: string | null }
    | {
        status: 'ok';
        etag: string | null;
        state: 'open' | 'closed' | 'merged';
        mergeability: MergeabilityCategory;
        headSha: string | null;
      }
  > {
    const url = `${this.base}/repos/${repo}/pulls/${prNumber}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(url, { headers });
    if (res.status === 304) {
      return { status: 'not_modified',
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