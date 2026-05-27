# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Surface CI failure badges on task cards (parity with PR cards)
- **Notion task**: https://www.notion.so/Surface-CI-failure-badges-on-task-cards-parity-with-PR-cards-36d22f9152f3818b80b5ef04282a82c0
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\a7190731-86a9-4d8b-b895-02c96be3e7e0`.**
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

All file writes **must stay inside the worktree directory** (`C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\a7190731-86a9-4d8b-b895-02c96be3e7e0`).

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
When a task's linked PR has CI failures, the PR card surfaces ❌ CI failing / ⚠ CI unstable badges but the task card does not. The orchestrator has all the data needed on the task aggregate — just render the same badges using the same predicates the PR card already uses.
## Dependencies
None. Frontend-only change; backend already returns the relevant fields.
## Context
### Observed parity gap
PR view for #404 (feat: autofix-on-ci-failure) renders three pill badges:
- ✅ Approved
- ❌ CI failing
- ⚠ CI unstable
The corresponding task card (Run orchestrator autofix on CI failure before forwarding to the session) renders only:
- running (session status)
- ✅ Approved
The CI failure state is invisible from the task-board view, so a viewer scanning the task board can't tell that the PR is blocked on CI without opening the PR side panel.
### Where the badges already exist
packages/frontend/src/components/WorkItemCard.tsx (the PR card) renders the badges from these PR fields:
- pr.mergeState === 'ci_failed' → ❌ CI failing (line 354)
- pr.mergeState === 'unstable' → ⚠ CI unstable (line 371)
- pr.pauseReason === 'ci_failing' → same ❌ CI failing badge (line 239)
The getActiveTaskAggregates query (packages/backend/src/db/queries.ts:1294) already returns pr_merge_state and pr_pause_reason on TaskAggregateRow, and the WS serialization carries them through to the frontend (see packages/frontend/src/types/taskView.ts).
### What changes
1. Extract the CI badge logic from WorkItemCard.tsx into a small shared component (e.g. packages/frontend/src/components/CIBadges.tsx) that takes { mergeState, pauseReason } and renders the relevant pills. Single source of truth.
1. Render <CIBadges /> on TaskCard.tsx next to the existing status/verdict badges, using the same fields surfaced via the task aggregate.
1. Keep visual styling identical to the PR card (reuse WorkItemCard.module.css rules or factor them into the shared component's own stylesheet).
### Coverage of states (matches PR card)

If the PR is merged or closed, suppress the badges (state is no longer actionable).
### Out of scope
- Adding new CI states beyond what the PR card surfaces today.
- Surfacing CI failure badges on the milestone-level board summary.
- Tooltip / click-to-expand on the badges — keep them informational, same as the PR card.
## Acceptance criteria
### 🤖 Automated tests
- tsc --noEmit passes for both packages
- Component test: <CIBadges> with mergeState='ci_failed' renders the ❌ CI failing pill
- Component test: <CIBadges> with mergeState='unstable' renders the ⚠ CI unstable pill
- Component test: <CIBadges> with pauseReason='ci_failing' renders the ❌ CI failing pill (independent of mergeState)
- Component test: <CIBadges> with mergeState='clean' and pauseReason=null renders nothing
- Component test: <CIBadges> with the PR merged renders nothing (suppressed)
- TaskCard test: a task aggregate with prMergeState='ci_failed' renders ❌ CI failing on the task card
- TaskCard test: a task aggregate with prMergeState='unstable' renders ⚠ CI unstable on the task card
- TaskCard test: a task aggregate with no PR renders no CI badges
- WorkItemCard continues to render identical badges via the shared component (regression coverage)
## Files / paths affected
- packages/frontend/src/components/CIBadges.tsx (new — shared component)
- packages/frontend/src/components/CIBadges.module.css (new — styling, or reused from WorkItemCard.module.css)
- packages/frontend/src/components/WorkItemCard.tsx (update — replace inline badge JSX with <CIBadges>)
- packages/frontend/src/components/TaskCard.tsx (update — render <CIBadges>)
- packages/frontend/src/components/__tests__/CIBadges.test.tsx (new)
- packages/frontend/src/components/__tests__/TaskCard.test.tsx (update — add cases)
- packages/frontend/src/components/__tests__/PRCard.test.tsx (update if needed for the regression case)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/frontend/src/components/WorkItemCard.tsx`
```
import { useState } from 'react';
import styles from './WorkItemCard.module.css';

export interface PRReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

export interface PRReviewResult {
  verdict: 'approved' | 'needs_changes' | 'incomplete' | 'error';
  dimensions?: PRReviewDimension[];
  summary: string;
}

// ── PR work item (GitHub pull request) ────────────────────────────

export interface PRWorkItem {
  type: 'pr';
  prNumber: number;
  prUrl: string;
  title: string;
  headBranch: string;
  branchName: string;
  baseBranch: string;
  state: string;
  notionTaskId: string | null;
  notionTaskTitle: string | null;
  sessionId: string | null;
  reviewSessionId: string | null;
  repo: string;
  reviewResult: PRReviewResult | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  reviewIteration?: number;
  mergeState: string | null;
  failingChecks?: string[] | null;
  pauseReason?: string | null;
  autoMergeEnabled: boolean;
}

// ── Local branch work item (local-only project session) ────────────

export interface LocalBranchWorkItem {
  type: 'local_branch';
  sessionId: string;
  branchName: string;
  baseBranch: string;
  status: string;
  reviewResult: PRReviewResult | null;
  createdAt: string;
  autoMergeEnabled: boolean;
  notionTaskId: string | null;
  notionTaskTitle: string | null;
}

export type WorkItemListItem = PRWorkItem | LocalBranchWorkItem;

// ── Backward-compat alias used by existing tests and PRPanel ──────

/** @deprecated Use PRWorkItem or WorkItemListItem instead */
export type PRListItem = PRWorkItem;

export interface WorkItemCardProps {
  item: WorkItemListItem;
  onReview: (prNumber: number) => void;
  onMerge: (prNumber: number) => void;
  onRemove: (prNumber: number) => void;
  onViewSession?: (sessionId: string) => void;
  onReReview: (prNumber: number) => void;
  onFixConflicts: (prNumber: number) => void;
  onApprove: (prNumber: number) => void;
  reviewInFlight: boolean;
  mergeInFlight: boolean;
  checkingMergeability?: boolean;
  removeInFlight: boolean;
  reReviewInFlight: boolean;
  fixConflictsInFlight: boolean;
  approveInFlight: boolean;
  reviewElapsed: number;
  error: string | null;
}

const VERDICT_LABELS: Record<string, string> = {
  approved: '✅ Approved',
  needs_changes: '⚠️ Needs Changes',
  incomplete: '❌ Incomplete',
  error: '⚠️ Review Error',
};

// ── Local branch card ──────────────────────────────────────────────

function LocalBranchCard({
  item,
  onViewSession,
}: {
  item: LocalBranchWorkItem;
  onViewSession?: (sessionId: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const verdict = item.reviewResult?.verdict ?? null;

  const verdictClass = verdict
    ? styles[`verdict-${verdict.replace('_', '-')}`]
    : styles['verdict-none'];
  const verdictLabel = verdict ? VERDICT_LABELS[verdict] : '— Not reviewed';

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.titleRow}>
          <span className={styles.localBadge}>Local</span>
          <span className={styles.title}>{item.branchName}</span>
        </div>
        <span className={styles.branch}>
          {item.branchName} → {item.baseBranch}
        </span>
        {(item.notionTaskTitle || item.sessionId) && (
          <div className={styles.metaRow}>
            {item.notionTaskTitle && (
              <div className={styles.notionRow}>
                <span className={styles.notionLabel}>Task:</span>
                {item.notionTaskId ? (
                  <a
                    href={`https://notion.so/${item.notionTaskId.replace(/-/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.notionLink}
                  >
                    {item.notionTaskTitle} ↗
                  </a>
                ) : (
                  <span className={styles.notionTitle}>
                    {item.notionTaskTitle}
                  </span>
                )}
              </div>
            )}
            {item.sessionId && onViewSession && (
              <button
                type="button"
                className={styles.sessionLink}
                onClick={() => onViewSession(item.sessionId)}
              >
                Session ⇗
              </button>
            )}
          </div>
        )}
      </div>

      <div className={styles.cardActions}>
        <span className={`${styles.verdictBadge} ${verdictClass}`}>
          {verdictLabel}
        </span>
      </div>

      {item.reviewResult && (
        <div className={styles.reviewDetails}>
          <button
            type="button"
            className={styles.detailsToggle}
            onClick={() => setDetailsOpen((o) => !o)}
          >
            {detailsOpen ? '▼' : '▶'} Review details
          </button>
          {detailsOpen && (
            <div className={styles.detailsBody}>
              {item.reviewResult.verdict === 'error' ? (
                <div className={styles.reviewError}>
                  Review failed: {item.reviewResult.summary}
                </div>
              ) : (
                <>
                  {(item.reviewResult.dimensions ?? []).map((dim) => (
                    <div key={dim.name} className={styles.dimension}>
                      <span className={styles.dimIcon}>
                        {dim.passed ? '✅' : '⚠️'}
                      </span>
                      <span className={styles.dimName}>{dim.name}</span>
                      <span className={styles.dimNotes}>{dim.notes}</span>
                    </div>
                  ))}
                  <div className={styles.reviewSummary}>
                    {item.reviewResult.summary}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── PR card (GitHub pull request) ─────────────────────────────────

function PRWorkItemCard({
  item: pr,
  onReview,
  onMerge,
  onRemove,
  onViewSession,
  onReReview,
  onFixConflicts,
  onApprove,
  reviewInFlight,
  mergeInFlight,
  checkingMergeability = false,
  removeInFlight,
  reReviewInFlight,
  fixConflictsInFlight,
  approveInFlight,
  reviewElapsed,
  error,
}: Omit<WorkItemCardProps, 'item'> & { item: PRWorkItem }) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const isFinished = pr.state === 'merged' || pr.state === 'closed';
  const verdict = pr.reviewResult?.verdict ?? null;
  const hasConflicts = !isFinished && pr.mergeState === 'dirty';
  const hasCiFailures = !isFinished && pr.mergeState === 'ci_failed';
  const isBlocked = !isFinished && pr.mergeState === 'blocked';
  const isUnstable = !isFinished && pr.mergeState === 'unstable';
  const isUnknownMergeState = !isFinished && pr.mergeState === 'unknown';
  const mergeBlocked =
    hasConflicts ||
    hasCiFailures ||
    isBlocked ||
    isUnstable ||
    isUnknownMergeState;
  const canMerge =
    pr.state === 'open' && verdict === 'approved' && !mergeBlocked;
  const failingChecks = pr.failingChecks ?? [];
  const showCiBadge =
    !isFinished &&
    (pr.mergeState === 'ci_failed' || pr.pauseReason === 'ci_failing');
  const ciChecksUrl = `https://github.com/${pr.repo}/pull/${pr.prNumber}/checks`;
  const sessionAlive = pr.sessionId !== null;
  const reviewAction: 'run-review' | 're-review' | 'fix-conflicts' | null =
    isFinished
      ? null
      : hasConflicts
        ? 'fix-conflicts'
        : verdict === 'approved'
          ? null
          : (verdict === 'needs_changes' || verdict === 'incomplete') &&
              sessionAlive
            ? 're-review'
            : 'run-review';
  const showApproveButton =
    !isFinished && verdict !== 'approved' && !hasConflicts;

  const verdictClass = isFinished
    ? styles[`state-${pr.state}`]
    : verdict
      ? styles[`verdict-${verdict.replace('_', '-')}`]
      : styles['verdict-none
[... truncated]
```

### `packages/frontend/src/components/TaskCard.tsx`
```
import type { TaskView, DisplayStatus, PauseReason } from '../types/taskView';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { useDispatch } from '../hooks/useDispatch';
import { formatTokenCount } from '@claude-orchestrator/backend/src/utils/usage';
import styles from './TaskCard.module.css';

interface Props {
  task: TaskView;
  selected: boolean;
  onClick: () => void;
  send: (msg: ClientMessage) => void;
  project: ProjectConfig | null;
}

const STATUS_LABELS: Record<DisplayStatus, string> = {
  needs_attention: '⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  in_progress: '🔄 In Progress',
  in_review: '👀 In Review',
  ready: '🗂️ Ready',
  done: '✔️ Done',
  backlog: '🗂️ Backlog',
};

const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  max_reviews: 'Max review iterations reached — re-review or close the PR.',
  stuck_timeout: 'Session stuck — no progress within the timeout window.',
  ci_failing: 'CI is failing — fix the failing checks and push.',
  auto_merge_failed: 'Auto-merge failed — merge manually or investigate.',
  pr_closed: 'PR was closed during auto-merge — reopen or create a new PR.',
  review_failed: 'Re-review failed unexpectedly — check the backend logs.',
  api_overloaded:
    'API overloaded (529) — session paused. Resume when the API recovers.',
  merge_conflict:
    'Merge conflict detected — rebase onto the base branch and resolve conflicts.',
  awaiting_human_approval:
    'Awaiting human approval — approve the PR to proceed with auto-merge.',
  human_changes_requested:
    'Human reviewer requested changes — address the feedback and push.',
  pr_body_invalid:
    'PR body missing required sections — update the PR description and resume.',
  attribution_missing:
    'Commit attribution trailer missing — add AI-Authored-By to commits and push.',
};

function verdictLabel(verdict: string): string {
  if (verdict === 'approved') return '✅ Approved';
  if (verdict === 'needs_changes') return '🔁 Needs changes';
  if (verdict === 'incomplete') return '❌ Incomplete';
  return verdict;
}

function launchTooltip(task: TaskView): string {
  if (task.notionStatus !== '🗂️ Ready') return 'Task is not Ready';
  if (!task.taskType.includes('💻')) return 'Non-code task';
  if (task.blocked) return `Blocked by ${task.blockerNames.join(', ')}`;
  return '';
}

export function TaskCard({ task, selected, onClick, send, project }: Props) {
  const { codeSession, pr, review } = task;
  const statusKey = task.displayStatus.replace(/_/g, '-') as string;
  const dispatchTask = useDispatch(send, project);
  const isNonCode = !task.taskType.includes('💻');

  // Only Ready code tasks that aren't blocked can be launched.
  // In Progress and In Review tasks already have an active session — launching
  // another would create a duplicate.
  const isLaunchable =
    task.notionStatus === '🗂️ Ready' && !isNonCode && !task.blocked;

  const tooltip = isLaunchable ? '' : launchTooltip(task);

  const handleLaunch = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isLaunchable) return;
    dispatchTask([{ taskId: task.taskId, taskType: task.taskType }]);
  };

  return (
    <div
      className={`${styles.card} ${selected ? styles.selected : ''} ${isNonCode ? styles.nonCode : ''}`}
      onClick={onClick}
      data-status={task.displayStatus}
    >
      <div className={styles.header}>
        <span className={styles.taskName}>{task.taskName}</span>
        <span
          className={`${styles.statusBadge} ${styles[`status-${statusKey}`] ?? ''}`}
          title={
            task.pauseReason ? PAUSE_REASON_LABELS[task.pauseReason] : undefined
          }
        >
          {STATUS_LABELS[task.displayStatus]}
        </span>
      </div>

      {task.priority && <div className={styles.priority}>{task.priority}</div>}

      {!isNonCode && (
        <>
          {codeSession && (
            <div className={styles.sessionRow}>
              <span
                className={`${styles.sessionStatus} ${styles[`session-${codeSession.status}`] ?? ''}`}
              >
                {codeSession.status}
              </span>
              {codeSession.lastMessage && (
                <span className={styles.lastMessage}>
                  {codeSession.lastMessage}
                </span>
              )}
            </div>
          )}

          {!codeSession && <span className={styles.placeholder}>—</span>}

          {pr ? (
            <div className={styles.prRow}>
              <a
                href={pr.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.prLink}
                onClick={(e) => e.stopPropagation()}
              >
                #{pr.prNumber}
              </a>
              <span className={styles.prState}>
                {pr.draft ? 'draft' : pr.state}
              </span>
              {pr.mergeState === 'dirty' && (
                <span
                  className={styles.conflictBadge}
                  title="PR has merge conflicts"
                >
                  ⚠ Conflict
                </span>
              )}
              {review?.verdict && (
                <span
                  className={`${styles.verdict} ${styles[`verdict-${review.verdict.replace(/_/g, '-')}`] ?? ''}`}
                >
                  {verdictLabel(review.verdict)}
                </span>
              )}
            </div>
          ) : (
            <span className={styles.placeholder}>—</span>
          )}
        </>
      )}

      <div className={styles.cardFooter}>
        {task.notionUrl && (
          <a
            href={task.notionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.notionLink}
            onClick={(e) => e.stopPropagation()}
          >
            Notion ↗
          </a>
        )}
        {task.totalTokens.input + task.totalTokens.output > 0 && (
          <span className={styles.tokenBadge}>
            {formatTokenCount(task.totalTokens.input + task.totalTokens.output)}{' '}
            tokens
          </span>
        )}
        {isNonCode ? (
          <span className={styles.taskTypeLabel}>{task.taskType}</span>
        ) : (
          <button
            className={styles.launchButton}
            disabled={!isLaunchable}
            onClick={handleLaunch}
            title={tooltip || 'Launch session'}
            aria-label={
              isLaunchable ? `Launch session for ${task.taskName}` : tooltip
            }
          >
            🚀
          </button>
        )}
      </div>
    </div>
  );
}

```

### `packages/frontend/src/components/__tests__/TaskCard.test.tsx`
```
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskCard } from '../TaskCard';
import type { TaskView, DisplayStatus } from '../../types/taskView';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

function makeTask(overrides?: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Implement Feature',
    notionStatus: '🗂️ Ready',
    displayStatus: 'ready',
    pauseReason: null,
    priority: '',
    notionUrl: 'https://notion.so/task-1',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    ...overrides,
  };
}

function makeCodeSession(
  overrides?: Partial<NonNullable<TaskView['codeSession']>>,
): NonNullable<TaskView['codeSession']> {
  return {
    sessionId: 'sess-1',
    status: 'running',
    startedAt: Date.now() - 60_000,
    endedAt: null,
    lastMessage: 'Writing tests...',
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

function makePr(
  overrides?: Partial<NonNullable<TaskView['pr']>>,
): NonNullable<TaskView['pr']> {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    title: 'feat: implement feature',
    headBranch: 'feature/implement-feature',
    baseBranch: 'dev',
    state: 'open',
    draft: false,
    mergeState: null,
    ...overrides,
  };
}

function makeReview(
  overrides?: Partial<NonNullable<TaskView['review']>>,
): NonNullable<TaskView['review']> {
  return {
    sessionId: 'review-1',
    status: 'done',
    verdict: 'approved',
    summary: 'Looks good',
    iterationCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

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

const noop = vi.fn();

describe('TaskCard', () => {
  it('renders task name', () => {
    render(
      <TaskCard
        task={makeTask()}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('Implement Feature')).toBeDefined();
  });

  it('renders priority badge when priority is set', () => {
    render(
      <TaskCard
        task={makeTask({ priority: '🔴 High' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('🔴 High')).toBeDefined();
  });

  it('does not render priority badge when priority is empty', () => {
    render(
      <TaskCard
        task={makeTask({ priority: '' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText(/High|Low|Medium/)).toBeNull();
  });

  it('renders code session status when codeSession is present', () => {
    const session = makeCodeSession({ status: 'running' });
    render(
      <TaskCard
        task={makeTask({ codeSession: session })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('running')).toBeDefined();
  });

  it('renders lastMessage in session line when present', () => {
    const session = makeCodeSession({ lastMessage: 'Writing tests...' });
    render(
      <TaskCard
        task={makeTask({ codeSession: session })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('Writing tests...')).toBeDefined();
  });

  it('renders — placeholder when codeSession is null', () => {
    render(
      <TaskCard
        task={makeTask({ codeSession: null })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const placeholders = screen.getAllByText('—');
    expect(placeholders.length).toBeGreaterThanOrEqual(1);
  });

  it('renders — placeholder in meta line when pr is null', () => {
    render(
      <TaskCard
        task={makeTask({ pr: null })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    const placeholders = screen.getAllByText('—');
    expect(placeholders.length).toBeGreaterThanOrEqual(1);
  });

  it('renders PR number and state when pr is present', () => {
    render(
      <TaskCard
        task={makeTask({
          pr: makePr({ prNumber: 42, state: 'open', draft: false }),
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('#42')).toBeDefined();
    expect(screen.getByText('open')).toBeDefined();
  });

  it('renders "draft" as PR state when pr.draft is true', () => {
    render(
      <TaskCard
        task={makeTask({ pr: makePr({ draft: true, state: 'open' }) })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('draft')).toBeDefined();
  });

  it('renders review verdict badge when review.verdict is present', () => {
    // Verdict badge is rendered alongside the PR section, so a PR must exist
    render(
      <TaskCard
        task={makeTask({
          pr: makePr(),
          review: makeReview({ verdict: 'approved' }),
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('✅ Approved')).toBeDefined();
  });

  it('renders needs_changes verdict label', () => {
    render(
      <TaskCard
        task={makeTask({
          pr: makePr(),
          review: makeReview({ verdict: 'needs_changes' }),
        })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('🔁 Needs changes')).toBeDefined();
  });

  it('does not render verdict badge when review.verdict is null', () => {
    render(
      <TaskCard
        task={makeTask({ review: makeReview({ verdict: null }) })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText(/Approved|Needs changes|Incomplete/)).toBeNull();
  });

  it('renders conflict badge when pr.mergeState is "dirty"', () => {
    render(
      <TaskCard
        task={makeTask({ pr: makePr({ mergeState: 'dirty' }) })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('⚠ Conflict')).toBeDefined();
  });

  it('does not render conflict badge when pr.mergeState is null', () => {
    render(
      <TaskCard
        task={makeTask({ pr: makePr({ mergeState: null }) })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.queryByText('⚠ Conflict')).toBeNull();
  });

  it('renders Notion link when notionUrl is set', () => {
    render(
      <TaskCard
        task={makeTask({ notionUrl: 'https://notion.so/task-1' })}
        selected={false}
        onClick={vi.fn()}
        send={noop}
        project={makeProject()}
      />,
    );
    expect(screen.getByText('Notion ↗')).toBeDefined();
  });

  it('calls onClick when card is clicked', () => {
    const onClick = vi.fn();
    render(
      <TaskCard
        task={makeTask()}
        selected={false}
        onClick={onClick}
        send={noop}
        project={makeProject()}
      />,
    );
    fireEvent.click(screen.getByText('Implement Feature'));
    expect(onClick).
[... truncated]
```

### `packages/frontend/src/components/__tests__/PRCard.test.tsx`
```
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PRCard } from '../PRCard';
import type { PRListItem } from '../PRCard';

function makePR(overrides: Partial<PRListItem> = {}): PRListItem {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    title: 'Test PR',
    headBranch: 'feature/test',
    baseBranch: 'dev',
    state: 'open',
    notionTaskId: null,
    notionTaskTitle: null,
    sessionId: null,
    reviewSessionId: null,
    repo: 'owner/repo',
    reviewResult: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergeState: null,
    ...overrides,
  };
}

const defaultProps = {
  onReview: vi.fn(),
  onMerge: vi.fn(),
  onRemove: vi.fn(),
  onReReview: vi.fn(),
  onFixConflicts: vi.fn(),
  onApprove: vi.fn(),
  reviewInFlight: false,
  mergeInFlight: false,
  removeInFlight: false,
  reReviewInFlight: false,
  fixConflictsInFlight: false,
  approveInFlight: false,
  reviewElapsed: 0,
  error: null,
};

describe('PRCard', () => {
  it('shows "Not reviewed" badge when reviewResult is null', () => {
    render(<PRCard pr={makePR()} {...defaultProps} />);
    expect(screen.getByText('— Not reviewed')).toBeDefined();
  });

  it('shows approved badge when verdict is approved', () => {
    const pr = makePR({
      reviewResult: {
        verdict: 'approved',
        dimensions: [],
        summary: 'Looks good',
      },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText('✅ Approved')).toBeDefined();
  });

  it('disables Merge button when verdict is not approved', () => {
    render(<PRCard pr={makePR()} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
  });

  it('disables Merge button when verdict is needs_changes', () => {
    const pr = makePR({
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
  });

  it('enables Merge button when verdict is approved and state is open', () => {
    const pr = makePR({
      reviewResult: { verdict: 'approved', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(false);
  });

  it('shows "Run Review" button when no prior review exists', () => {
    render(<PRCard pr={makePR()} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /run review/i })).toBeDefined();
  });

  it('shows "Re-review" button when verdict is needs_changes and coding session is alive', () => {
    const pr = makePR({
      sessionId: 'session-123',
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /re-review/i })).toBeDefined();
  });

  it('shows "Re-review" button when verdict is incomplete and coding session is alive', () => {
    const pr = makePR({
      sessionId: 'session-123',
      reviewResult: { verdict: 'incomplete', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /re-review/i })).toBeDefined();
  });

  it('hides the review button when verdict is approved', () => {
    const pr = makePR({
      reviewResult: { verdict: 'approved', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /run review/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /re-review/i })).toBeNull();
  });

  it('shows "Run Review" (not "Re-review") when verdict is needs_changes but coding session is dead', () => {
    const pr = makePR({
      sessionId: null,
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /run review/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /re-review/i })).toBeNull();
  });

  it('calls onReReview when "Re-review" button is clicked', () => {
    const onReReview = vi.fn();
    const pr = makePR({
      prNumber: 7,
      sessionId: 'session-abc',
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} onReReview={onReReview} />);
    fireEvent.click(screen.getByRole('button', { name: /re-review/i }));
    expect(onReReview).toHaveBeenCalledWith(7);
  });

  it('disables "Re-review" button when reReviewInFlight is true', () => {
    const pr = makePR({
      sessionId: 'session-123',
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} reReviewInFlight={true} />);
    const btn = screen.getByRole('button', { name: /reviewing/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('disables Run Review button when reviewInFlight is true', () => {
    render(<PRCard pr={makePR()} {...defaultProps} reviewInFlight={true} />);
    const btn = screen.getByRole('button', { name: /reviewing/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('shows inline error when error prop is set', () => {
    render(
      <PRCard pr={makePR()} {...defaultProps} error="Review failed: timeout" />,
    );
    expect(screen.getByText('Review failed: timeout')).toBeDefined();
  });

  it('shows "Merged" badge when state is merged, regardless of reviewResult', () => {
    const pr = makePR({ state: 'merged' });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText('✓ Merged')).toBeDefined();
  });

  it('shows "Merged" badge when state is merged even if reviewResult is set', () => {
    const pr = makePR({
      state: 'merged',
      reviewResult: { verdict: 'approved', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText('✓ Merged')).toBeDefined();
    expect(screen.queryByText('✅ Approved')).toBeNull();
  });

  it('shows "Closed" badge when state is closed', () => {
    const pr = makePR({ state: 'closed' });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText('✕ Closed')).toBeDefined();
  });

  it('hides Run Review button when state is merged', () => {
    const pr = makePR({ state: 'merged' });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /run review/i })).toBeNull();
  });

  it('disables Merge button when state is merged', () => {
    const pr = makePR({
      state: 'merged',
      reviewResult: { verdict: 'approved', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
  });

  it('renders without crash when reviewResult has no dimensions property', () => {
    const pr = makePR({
      reviewResult: { verdict: 'needs_changes', summary: 'Review timed out' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    fireEvent.click(screen.getByText(/review details/i));
    expect(screen.getByText('Review timed out')).toBeDefined();
  });

  it('renders without crash when reviewResult.dimensions is an empty array', () => {
    const pr = makePR({
      reviewResult: {
        verdict: 'needs_changes',
        dimensions: [],
        summary: 'All good',
      },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    fireEvent.click(screen.getByText(/review details/i));
    
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