# Orchestrator Rules (DO NOT OVERRIDE)

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: Introduce milestone-feature-branch + task-branch model
- **Notion task**: https://www.notion.so/Introduce-milestone-feature-branch-task-branch-model-36b22f9152f3818e9b5bf64f289295a5
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

> **Your worktree directory is `C:\Users\phadek\IdeaProjects\claude-orchestrator\.claude\worktrees\7e919f05-cc41-417c-90a7-adaee2ef3159`.**
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
Replace the current session/<UUID> backend-managed branch model with the per-project switchable model designed in Wave-1. Each project chooses between two_tier (task-branch → feature/<milestone-slug> → dev) and flat (task-branch → dev). Backend's branching responsibility is reduced to setting the worktree starting point; the session names and creates its own task branch.
## Dependencies
- Design governance & PR flow (human review gate + branching + non-milestone workflow) — see that page for the full design rationale and resolved OQs
## Context
The Wave-1 governance design (Task 2) specifies a per-project branching switch with the model and behaviours below. This task implements it.
### Per-project switch
New SQLite column on projects:
```sql
ALTER TABLE projects ADD COLUMN milestone_branching TEXT NULL;
-- NULL       → fall back to corporate-mode default
-- 'two_tier' → explicit two-tier
-- 'flat'     → explicit flat
```
Resolution order at session start:
1. If project.milestone_branching is non-NULL, use it.
1. Else, if getCorporateMode().enabled === true, use two_tier.
1. Else, use flat.
### What the backend does
Backend's branching responsibility is reduced to setting the starting point of the worktree's checkout. It does not create task branches.

Worktree creation uses git worktree add --detach <path> <starting-point> — no placeholder branch the session has to rename. The session creates its own task branch as its first git op.
### Removed code
SessionManager.ts:268, :671, :1022 (the three hardcoded session/<UUID> sites) are deleted, replaced by starting-point resolution + detached worktree.
### Milestone branch — lazy creation
```typescript
async function ensureMilestoneBranch(milestoneSlug: string): Promise<void> {
  const ref = `feature/${milestoneSlug}`;
  if (await git.refExists(ref)) return;
  await git.fetch('origin', 'dev');
  await git.branchCreate(ref, 'origin/dev');
  await git.push('origin', ref);
}
```
Triggered first time a session launches in that milestone, in two_tier mode. No-op on subsequent task launches. No "milestone setup" step required.
### CLAUDE.md prompt update
orchestrator-claudemd.ts — remove the "create feature branch from dev" instruction text. The session is told what branch it's on (the starting point); it creates its own task branch from there with its own naming.
### Files likely to change
- packages/backend/src/db/schema.ts (update — add milestone_branching column)
- packages/backend/src/session/SessionManager.ts:262-312 (update — replace worktree-add + branch-create with starting-point resolution + worktreeAddDetached)
- packages/backend/src/session/SessionManager.ts:268, :671, :1022 (delete — the three hardcoded session/<sessionId> sites)
- packages/backend/src/session/SessionManager.ts:895-905 (update — cleanup unchanged for task branch; ensure milestone branch is left intact)
- packages/backend/src/session/branchModel.ts (new — resolveStartingPoint, ensureMilestoneBranch, slug derivation helpers)
- packages/backend/src/session/orchestrator-claudemd.ts (update — branching instructions)
> ⚠️ Pause-reason additions and approval-gate / body-validator wiring live in T10 / T11 / T12, not this task.
## Acceptance criteria
### 🤖 Automated tests
tsc --noEmit passes for both packages
Migration adds projects.milestone_branching column with NULL default
Unit test: resolveStartingPoint returns feature/<milestone-slug> for milestone task + two_tier mode
Unit test: resolveStartingPoint returns dev for milestone task + flat mode
Unit test: resolveStartingPoint returns dev for non-milestone task regardless of mode
Unit test: resolution order — explicit project setting wins over corporate-mode default
Unit test: ensureMilestoneBranch creates feature/<slug> from origin/dev when missing; no-ops when present
Unit test: starting a session in two_tier mode for the first task in a milestone creates the milestone branch then the worktree (mock git ops or use a temp repo)
Unit test: cleanup leaves the task branch in place when a PR is open; milestone branch is never touched on cleanup
Existing session-start tests pass with the new branch model
### 👁️ Manual verification
Covered by the Manual Verification Gate task.
## Files / paths affected
- packages/backend/src/db/schema.ts (update)
- packages/backend/src/session/SessionManager.ts (update — starting-point resolution, cleanup, resume; delete three hardcoded branch sites)
- packages/backend/src/session/orchestrator-claudemd.ts (update — branching instructions)
- packages/backend/src/session/branchModel.ts (new)
## Implementation notes
> To be filled in during/after implementation.

## Referenced Files

> These are the current contents of files listed in the task spec.
> They were pre-read by the orchestrator so you can skip exploration.

### `packages/backend/src/db/schema.ts`
```
import { db } from './db';

export function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      notion_task_id      TEXT,
      notion_task_url     TEXT,
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
      notion_task_id TEXT    PRIMARY KEY,
      fetched_at     INTEGER NOT NULL,
      raw_json       TEXT    NOT NULL
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
    db.exec(`ALTER TABLE pull_requests ADD COLUMN failing_checks TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      `ALTER TABLE projects ADD COLUMN auto_merge_enabled INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN metadata TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      `ALTER TABLE projects ADD COLUMN git_mode TEXT NOT NULL DEFAULT 'github'`,
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN review_result TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE local_branches ADD COLUMN pause_reason TEXT`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(`ALTER TABLE local_branches ADD COLUMN merge_commit_sha TEXT`);
  } catch {
    /* already exists */
  }
}

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