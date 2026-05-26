# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Implement AI vs human commit/PR attribution + server-side PR body validation
- **Notion task**: https://www.notion.so/Implement-AI-vs-human-commit-PR-attribution-server-side-PR-body-validation-36b22f9152f381efb07de43b904a7172
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\f98ff4ec-5537-45c5-b3b7-d7b8c3886f60`.**
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
Tag every commit and PR opened by a coding session with structured AI attribution (trailer lines, PR labels), and validate PR bodies server-side against the required template. Outputs feed the audit log.
## Dependencies
- Introduce milestone-feature-branch + task-branch model
- Add audit-log scaffolding (append-only event stream with AI/human attribution)
## Context
Today, sessions are told (via merged CLAUDE.md) to include Co-Authored-By: trailers in commits, and the PR body template is enforced only by prompt — sessions can deviate and the orchestrator doesn't notice. For compliance, both attribution and body validation must be structural.
### What changes
1. Commit attribution. Every commit made by a session must carry a trailer like:
1. PR body validation. When a PR-created event is detected (AgentSession.handlePRCreatedFromContent at packages/backend/src/session/AgentSession.ts:624-729), parse the body against the required template:
1. PR label. Apply a GitHub label like ai-authored to every PR opened by a session, server-side after the PR is created. This makes the "AI vs human" distinction visible at the PR-list level without parsing the body.
### Files likely to change
- packages/backend/src/github/CommitAttributionWatcher.ts (new — verifies trailers on push)
- packages/backend/src/github/PRBodyValidator.ts (new — parses + validates body)
- packages/backend/src/github/GitHubClient.ts (update — add label, comment APIs)
- packages/backend/src/session/orchestrator-claudemd.ts (update — instruct session to include the trailer)
- packages/backend/src/session/AgentSession.ts (update — hook validator into PR-created handler)
## Design specifics inherited from Wave-1
Per the governance design (Task 2):
- PR body validation policy: block in corporate mode (post PR comment listing missing sections, set pause_reason = pr_body_invalid, audit-log pr_body_invalid); warn-only in non-corporate mode (audit-log pr_body_invalid_warning, auto-merge proceeds).
- Hook site for body validation: AgentSession.handlePRCreatedFromContent() at packages/backend/src/session/AgentSession.ts:624-729. Insert validation immediately after the pull_requests upsert (~line 700), before broadcasting pr_created over WS.
- Validator module: packages/backend/src/github/PRBodyValidator.ts (new). Parses body into sections; reports missing sections.
- Required template: ## Summary, ## Notion Task (or ## Task Source once T13 ships), ## Automated Tests, ## Files Changed.
- ai-authored PR label: apply server-side after the PR is created. This exposes the isAIReviewer / isAIAuthored predicate that T10 and T11 depend on — export it as a small utility for those tasks to consume.
- Commit attribution trailer: AI-Authored-By: <model> (session: <session-id>). Session is instructed via CLAUDE.md to include it; backend verifies on push. Missing trailers in corporate mode → audit-log attribution_missing + pause; non-corporate mode → audit-log only.
- Pause reason pr_body_invalid declared in T6, set here when corporate mode is on + body fails validation.
## Acceptance criteria
### 🤖 Automated tests
tsc --noEmit passes for both packages
Unit test: validator accepts a body with all four required sections
Unit test: validator rejects a body missing any required section
Unit test: commit-attribution-watcher records attribution_missing to the audit log when a trailer is absent
Unit test: PRs opened by a session get the ai-authored label
Unit test: in corporate mode, non-conforming PR body produces a pr_body_invalid pause and a PR comment
### 👁️ Manual verification
Covered by the Manual Verification Gate task.
## Files / paths affected
- packages/backend/src/github/CommitAttributionWatcher.ts (new)
- packages/backend/src/github/PRBodyValidator.ts (new)
- packages/backend/src/github/GitHubClient.ts (update)
- packages/backend/src/session/orchestrator-claudemd.ts (update)
- packages/backend/src/session/AgentSession.ts (update)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

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

### `packages/backend/src/session/orchestrator-claudemd.ts`
```
export interface OrchestratorClaudeMdParams {
  taskName: string;
  taskUrl: string;
  projectContextUrl: string;
  targetBranch: string;
  /** Absolute path to the worktree directory. Injected into Git Isolation rules. */
  worktreePath: string;
  /**
   * Verify commands the session runs before opening the PR (typecheck, build, tests).
   * Format and lint are handled by orchestrator autofix — not included here.
   * Rendered from the project's `.claude-orchestrator.yml` verify list.
   * When empty or omitted, the gate shows a "no local verify" fallback.
   */
  verify?: string[];
  /**
   * Bash rules (Rule 5+). Each item is the full rule text — the first line
   * becomes the bold heading, subsequent lines become the body paragraph.
   * Defaults to the `npx` convention when omitted.
   */
  bashRules?: string[];
  /**
   * Task backend type. When 'local', the lifecycle instructions are adjusted
   * to skip Notion fetch steps and read tasks.yaml instead.
   */
  taskBackend?: 'notion' | 'local';
  /**
   * Pre-fetched task spec markdown. When provided, the task content is injected
   * directly into the CLAUDE.md and the session skips Notion fetching entirely.
   */
  taskContent?: string;
  /**
   * Optional contents of `.claude/local-context.md` from the project root.
   * Appended to the merged CLAUDE.md so orchestrator-launched sessions see the
   * same host-local context (Notion URLs, etc.) as direct Claude Code sessions.
   * Omitted when the file is absent (e.g. fresh clone).
   */
  localContext?: string;
  /**
   * Git mode for the project. 'local-only' omits PR-related lifecycle steps
   * and GitHub instructions; 'github' (default) keeps the full PR flow.
   */
  gitMode?: 'github' | 'local-only';
}

/**
 * Build the orchestrator CLAUDE.md header content to inject into each session worktree.
 *
 * Returns a markdown string with all orchestrator rule sections (sections 1-9).
 * Section 10 — the separator and "# Project Instructions" heading — is appended by
 * the caller along with the project's own CLAUDE.md content.
 *
 * Section inventory:
 *  1. Header with override warning
 *  2. Task assignment (task name, Notion URL, project context URL)
 *  3. Lifecycle steps
 *  4. Status ownership
 *  5. PR format standards
 *  6. Branch rules
 *  7. Pre-PR gate
 *  8. Forbidden actions
 *  9. Git isolation
 * 10. Bash rules (permission system)
 * 11. Separator + "# Project Instructions (from project CLAUDE.md)" (added by caller)
 */
export function buildOrchestratorClaudeMd(
  params: OrchestratorClaudeMdParams,
): string {
  const {
    taskName,
    taskUrl,
    projectContextUrl,
    targetBranch,
    worktreePath,
    verify,
    bashRules,
    taskBackend = 'notion',
    taskContent,
    localContext,
    gitMode = 'github',
  } = params;

  const resolvedBashRules = bashRules ?? [
    'Use `npx` instead of bare tool names.\n`tsc` → `npx tsc`. Bare commands may not be on PATH.',
  ];

  const bashRulesText = resolvedBashRules
    .map((rule, i) => {
      const ruleNum = i + 5;
      const lines = rule.split('\n');
      const heading = lines[0];
      const body = lines.slice(1).join('\n');
      return `**Rule ${ruleNum} — ${heading}**${body ? '\n' + body : ''}`;
    })
    .join('\n\n');

  // Sections 1-9 — returned by this function.
  // Section 10 (separator + project instructions heading) is written by the caller.
  return `# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: ${taskName}
- **Notion task**: ${taskUrl}
- **Project context**: ${projectContextUrl}

---

## Lifecycle

Follow these steps in order — every session:

${
  taskContent
    ? `> **Task spec is pre-loaded below.** Do NOT fetch Notion pages — the task content has
> already been injected by the orchestrator. Proceed directly to implementation.

1. Read the **Task Spec** section below — it contains the full task specification.
2. Create a feature branch: \`feature/<task-name>\` from \`${targetBranch}\`.`
    : taskBackend === 'local'
      ? `> ⚠️ **YAML task source**: Task context comes from \`tasks.yaml\` in the project root, not Notion.
> Skip step 1 (Notion fetch) and instead read \`tasks.yaml\` for task context.

1. Read \`tasks.yaml\` in the project root for task context (skip Notion fetch).
2. Create a feature branch: \`feature/<task-name>\` from \`${targetBranch}\`.`
      : `1. Fetch the Notion task page and project context page.
2. Create a feature branch: \`feature/<task-name>\` from \`${targetBranch}\`.`
}
3. Implement the task per the acceptance criteria.
4. Pass the pre-PR gate (see Pre-PR Gate section below).
${
  gitMode === 'local-only'
    ? `5. Commit your changes on the feature branch. **No GitHub PR is required** — this is a local-only project.
6. **Stop and wait.** The dashboard will show a "Mark Merged" button once the review passes.
   Await review feedback as follow-up messages and address findings by pushing additional commits.`
    : `5. Open a draft PR targeting \`${targetBranch}\` using the required body template.
6. **Stop and wait.** The dashboard sends review feedback as follow-up messages.
   Address findings by pushing additional commits, then wait again.`
}

---

## Status Ownership

**Do NOT update Notion task status.**
**Do NOT call any Notion API to change task status.**
The orchestrator backend handles all status transitions (In Progress → In Review → Done).

---

## Efficiency Rules

This session runs in \`--print\` mode with no human watching the output.
Optimize for speed and token efficiency:

- **Do NOT use TodoWrite.** No one sees the todo list. Track your progress internally.
- **Do NOT use Agent subagents for exploration.** Use Glob and Grep directly.
- **Minimize tool calls.** Batch independent reads. Don't re-read files you already read.
- **Keep commit messages and PR descriptions concise.** One sentence summaries, not essays.

---

${
  gitMode === 'local-only'
    ? ``
    : `## PR Format Standards

- **Title**: \`feat: <task-name>\` — no scope prefix like \`(backend)\`, no milestone tags.
- **How to create the PR**: Use the \`mcp__github__create_pull_request\` MCP tool.
  Do NOT use \`gh pr create\` — the \`gh\` CLI is not on PATH.
  Pass \`draft: true\`, \`base: "${targetBranch}"\`, and the full body as the \`body\` parameter.
- **Required body sections** (no omissions, no reordering):

\`\`\`
## Summary
<1-3 sentences: what changed and why>

## Notion Task
<link to the Notion task page>

## Automated Tests
<list tests added/modified, or "No test changes">

## Files Changed
<bulleted list of files with brief description of each change>
\`\`\`

---
`
}
## Branch Rules

- Branch name: \`feature/<task-name>\` from \`${targetBranch}\`
- Never commit directly to \`${targetBranch}\` or \`main\`
${
  gitMode === 'local-only'
    ? `- One task per session — no scope creep`
    : `- Never merge your own PR
- One task per session — no scope creep`
}

---

${(() => {
  const verifyItems = verify && verify.length > 0 ? verify : null;
  const verifySteps = verifyItems
    ? verifyItems
        .map((cmd, i) => `${i + 4}. \`${cmd}\` — must pass.`)
        .join('\n')
    : `4. No local verify step configured — CI is the gate.`;
  const stageNum = verifyItems ? verifyItems.length + 4 : 5;
  return `## Pre-PR Gate

Run in order — all must pass before opening the PR:

1. Stash CLAUDE.md before rebasing: \`git stash push CLAUDE.md\`
2. Rebase onto \`${targetBranch}\` and resolve any conflicts.
3. Restore CLAUDE.md: \`git stash pop\`
${verifySteps}
${stageNum}. Stage only your implementation files for commit — never stage \`CLAUDE.md\`.`;
})()}

---

## Forbidden Actions

- Never push directly to \`main\`
- Never force push (\`--force\`)
- Never delete branches that live outside this worktree
- Never run \`git reset --hard\` on the main 
[... truncated]
```

### `packages/backend/src/session/AgentSession.ts`
```
import { EventEmitter } from 'events';
import { ALLOWED_TOOLS, runtimeSettings } from '../config';
import {
  upsertSessionEvent,
  updateSessionStatus,
  markSessionDone,
  getEventsBySession,
  insertPermissionDenial,
  upsertPullRequest,
  incrementTokens,
  insertSessionAudit,
  setSessionModel,
  setSessionMetadata,
  getPRBySessionId,
  getPRByNumber,
  setHeadSha,
  setPauseReason,
  getProjectRowById,
  insertLocalBranch,
} from '../db/queries';
import {
  getCurrentBranch,
  hasNonEmptyDiff,
} from '../orchestration/localBranchHelpers';
import type { ServerMessage, PermissionDenial } from '../ws/types';
import { emitTaskUpdated } from '../routes/tasks';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { GitHubClient } from '../github/GitHubClient';
import { isSystemOnlyUserEvent } from '../utils/eventFilters';
import { SessionAuditor } from './SessionAuditor';
import type { ISessionManager } from './SessionAuditor';
import type { ISessionRunner } from './SessionRunner';
import { CliSessionRunner } from './CliSessionRunner';
import {
  VALID_EVENT_TYPES,
  SILENT_SKIP_TYPES,
  toEventType,
} from './eventTypes';

const PR_URL_REGEX = /https:\/\/github\.com\/[^"\\]+\/pull\/\d+/;

/**
 * Returns true if the tool call represents a git push operation.
 * Exported for unit testing.
 */
export function isPushCommand(toolName: string, toolInput: string): boolean {
  if (toolName === 'mcp__github__push_files') return true;
  if (
    toolName === 'Bash' &&
    /git\s+push/.test(toolInput) &&
    !toolInput.includes('--dry-run')
  )
    return true;
  return false;
}

function sessionLog(sessionId: string, ...args: unknown[]) {
  console.log(`[Session ${sessionId.slice(0, 8)}]`, ...args);
}

/** Parse the Notion page ID out of a notion.so URL or return the raw value. */
export function parseNotionPageId(url: string): string {
  const match = url.match(/([a-f0-9]{32})$/i);
  if (match) return match[1];
  const uuidMatch = url.match(/([0-9a-f-]{36})$/i);
  if (uuidMatch) return uuidMatch[1].replace(/-/g, '');
  return url;
}

/**
 * Merge assistant message content blocks so that text blocks emitted in earlier
 * streaming events are not lost when later streaming events contain only tool_use
 * blocks. The Claude CLI can stream multiple `assistant` events for the same message
 * turn (sharing the same `message.id`) — first text, then tool_use — so we must
 * accumulate rather than replace.
 */
function mergeAssistantContent(
  existing: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const existingText = existing.filter((b) => b.type === 'text');
  const incomingText = incoming.filter((b) => b.type === 'text');

  // Prefer incoming text blocks (they contain the most up-to-date streamed content).
  // If the incoming event has no text blocks, preserve the existing ones.
  const textBlocks = incomingText.length > 0 ? incomingText : existingText;

  // Merge tool_use blocks by id so we don't duplicate them across streaming events.
  const toolUseById = new Map<string, Record<string, unknown>>();
  for (const b of existing) {
    if (b.type === 'tool_use' && typeof b.id === 'string')
      toolUseById.set(b.id, b);
  }
  for (const b of incoming) {
    if (b.type === 'tool_use' && typeof b.id === 'string')
      toolUseById.set(b.id, b);
  }

  return [...textBlocks, ...toolUseById.values()];
}

export class AgentSession extends EventEmitter {
  private isKilling = false;
  public prUrl: string | undefined;
  /** True once a session_ended message has been broadcast. */
  public hasEnded = false;
  /** Maps message_id → DB row id for deduplicating streaming assistant events. */
  private messageIdMap = new Map<string, number>();
  /** Maps message_id → accumulated content blocks, so text is not lost when
   *  tool_use arrives in a later streaming event for the same message. */
  private messageContentMap = new Map<string, Array<Record<string, unknown>>>();
  /** Maps tool_use_id → tool_name for PR creation tools, for real-time detection. */
  private pendingGHToolUseIds = new Map<string, string>();
  /** Maps tool_use_id → Bash command string, for push detection. */
  private pendingBashCommands = new Map<string, string>();
  /** Tracks mcp__github__push_files tool_use IDs awaiting a successful tool_result. */
  private pendingPushFileToolUseIds = new Set<string>();
  /** True once a PR was detected and inserted during the live session. */
  private prDetectedLive = false;
  /** Accumulated token counts for this session (in-memory, synced to SQLite). */
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  /** Model name extracted from the first assistant event (e.g. 'claude-sonnet-4-6'). */
  public model: string | null = null;
  /** Count of consecutive transient-error retries for this session instance. Resets on clean exit. */
  private retryCount = 0;
  /** Guard: fires at most once per session to avoid duplicate pause broadcasts. */
  private inSessionApiErrorFired = false;

  /** The underlying I/O adapter (CLI subprocess or Agent SDK). */
  private runner: ISessionRunner;

  constructor(
    public readonly sessionId: string,
    public readonly taskUrl: string,
    public readonly projectContextUrl: string,
    /**
     * Optional fixed task backend used by tests. In production this is undefined
     * and the backend is resolved per-call via `getTaskBackend(projectId)`.
     */
    private readonly taskBackendOverride: TaskBackend | undefined,
    private readonly worktreePath: string,
    public readonly taskId: string,
    private readonly resumeSessionId?: string,
    private readonly customPrompt?: string,
    public readonly sessionType: string = 'standard',
    private readonly sessionManager?: ISessionManager,
    private readonly githubClient?: GitHubClient,
    private readonly extraAllowedTools: string[] = [],
    /**
     * System prompt content for API mode.
     * In CLI mode this is written to CLAUDE.md in the worktree before spawn.
     * In API mode this is passed directly to the Agent SDK as systemPrompt.
     */
    private readonly systemPromptContent?: string,
    /**
     * The session runner to use. Defaults to CliSessionRunner.
     * Pass an ApiSessionRunner instance when SESSION_MODE=api.
     */
    runner?: ISessionRunner,
    /**
     * Project id used to resolve the task backend at call time when
     * `taskBackendOverride` is undefined. Appended at the end so legacy
     * positional callers (tests) need not be touched.
     */
    public readonly projectId: string = '',
  ) {
    super();
    this.runner = runner ?? new CliSessionRunner(sessionId);
  }

  /** Resolve the per-project task backend, preferring the test override when present. */
  private taskBackend(): TaskBackend {
    return this.taskBackendOverride ?? getTaskBackend(this.projectId);
  }

  async run(): Promise<void> {
    this.broadcast({
      type: 'session_status',
      sessionId: this.sessionId,
      status: 'running',
    });
    updateSessionStatus(this.sessionId, 'running');

    const initialPrompt =
      this.customPrompt ??
      `
You are a Claude Code session managed by Claude Code Orchestrator.

## Task
Task page: ${this.taskUrl}

Read CLAUDE.md in the repo root — it contains the full task spec and all rules.
Begin implementing the task immediately. Do NOT fetch Notion pages.

## Lifecycle
1. Read CLAUDE.md for the task spec, orchestrator rules, and project conventions.
2. Create a feature branch from the project's base branch.
3. Implement the task per the acceptance criteria in the Task Spec section of CLAUDE.md.
4. Pass the pre-PR gate as specified in CLAUDE.md.
5. Open a draft PR as specified in CLAUDE.md.
6. After the PR is open, WAIT. Do not merge.
   The dashboard will send review feedback as follow-up messages.
   Address findings by pushing additional commits, then wait ag
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