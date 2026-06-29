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
   * Task backend type. Controls wording throughout the generated CLAUDE.md
   * (task label, fetch instruction, status ownership, PR body section header).
   * 'notion' is the default; 'local' reads tasks.yaml instead of fetching remotely.
   */
  taskBackend?: 'notion' | 'local' | 'jira' | 'github';
  /**
   * Pre-fetched task spec markdown. When provided, the task content is injected
   * directly into the CLAUDE.md and the session skips Notion fetching entirely.
   */
  taskContent?: string;
  /**
   * Pre-loaded project context content (e.g. from PROJECT.md for GitHub projects).
   * When present, appended as a "## Project Context" section after the task spec.
   */
  projectContextContent?: string;
  /**
   * Git mode for the project. 'local-only' omits PR-related lifecycle steps
   * and GitHub instructions; 'github' (default) keeps the full PR flow.
   */
  gitMode?: 'github' | 'local-only';
}

type TaskBackend = 'notion' | 'local' | 'jira' | 'github';

function taskAssignmentLabel(backend: TaskBackend): string {
  switch (backend) {
    case 'github':
      return 'GitHub issue';
    case 'jira':
      return 'Jira issue';
    case 'local':
      return 'Task';
    default:
      return 'Notion task';
  }
}

function fetchInstruction(backend: TaskBackend): string {
  switch (backend) {
    case 'github':
      return 'Fetch the GitHub issue via the gh CLI.';
    case 'jira':
      return 'Fetch the Jira issue.';
    default:
      return 'Fetch the Notion task page and project context page.';
  }
}

function taskBackendApiName(backend: TaskBackend): string {
  switch (backend) {
    case 'github':
      return 'GitHub API';
    case 'jira':
      return 'Jira API';
    case 'local':
      return 'task source';
    default:
      return 'Notion API';
  }
}

function prBodyTaskSectionHeader(backend: TaskBackend): string {
  switch (backend) {
    case 'github':
      return '## GitHub Issue';
    case 'jira':
      return '## Jira Issue';
    case 'local':
      return '## Task';
    default:
      return '## Notion Task';
  }
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
 *  2. Task assignment (task name, task URL, project context URL)
 *  3. Lifecycle steps
 *  4. Status ownership
 *  5. Efficiency rules
 *  6. Context efficiency
 *  7. PR format standards
 *  8. Branch rules
 *  9. Commit attribution
 * 10. Pre-PR gate
 * 11. Forbidden actions
 * 12. Git isolation
 * 13. Filesystem isolation (personal mode)
 * 14. Bash rules (permission system)
 * 15. Separator + "# Project Instructions (from project CLAUDE.md)" (added by caller)
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
    projectContextContent,
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

> ⚠️ Injected by the orchestrator — takes priority over all project instructions. Do not remove or override.

---

## Task Assignment

- **Task**: ${taskName}
- **${taskAssignmentLabel(taskBackend)}**: ${taskUrl}
- **Project context**: ${projectContextUrl}

---

## Lifecycle

> ⚠️ **Your task is pre-assigned (see Task Assignment above). Never browse the task board or self-assign a different task. If you have no remaining work after checking git status, stop and wait for instructions.**

${
  taskContent
    ? `> **Task spec is pre-loaded below.** Do NOT fetch Notion pages — already injected. Proceed directly to implementation.

1. Read the **Task Spec** section below — it contains the full task specification.
2. Verify your branch: \`git branch --show-current\` → \`feature/<task-name>\`.`
    : taskBackend === 'local'
      ? `> ⚠️ **YAML task source**: Task context is in \`tasks.yaml\` in the project root. Skip the remote fetch step.

1. Read \`tasks.yaml\` for task context (skip remote fetch).
2. Verify your branch: \`git branch --show-current\` → \`feature/<task-name>\`.`
      : `1. ${fetchInstruction(taskBackend)} Retrieve only the pre-assigned task above — do NOT browse the board to pick up additional work.
2. Verify your branch: \`git branch --show-current\` → \`feature/<task-name>\`.`
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

**Do NOT update ${taskAssignmentLabel(taskBackend)} status.**
**Do NOT call any ${taskBackendApiName(taskBackend)} to change task status.**
The orchestrator backend handles all status transitions (In Progress → In Review → Done).

---

## Efficiency Rules

Running in \`--print\` mode — optimize for speed and token efficiency:

- **Do NOT use TodoWrite.** No one sees the todo list. Track your progress internally.
- **Do NOT use Agent subagents for exploration.** Use Glob and Grep directly.
- **Minimize tool calls.** Batch reads; don't re-read files you just wrote or edited.
- **Prefer Edit over Write** for existing files; never re-emit unchanged file bodies.
- **Commit messages/PR descriptions:** one sentence summaries.
- **Never cat \`tasks/*.output\` files** — use the TaskOutput tool instead.

---

## Context Efficiency

- **Grep first, then read the slice** — locate with Grep, then Read with \`offset\`/\`limit\` for only the region you need.
- **Scope every Grep** — supply \`path\`/\`glob\` and a specific pattern; avoid repo-wide matches.
- **Don't re-read after editing** — the Edit result already reflects the change.
- **Reference modules: read the relevant region only**, not the whole file.

---

${
  gitMode === 'local-only'
    ? ``
    : `## PR Format Standards

- **Title**: \`feat: <task-name>\` — no scope prefix, no milestone tags.
- **How to create the PR**: emit the body inside \`<pr-body>…</pr-body>\` in your final message. Do NOT use the MCP \`mcp__github__create_pull_request\` tool — the marker is the only path.
- **Required body sections**:

\`\`\`
## Summary
<1-3 sentences: what changed and why>

${prBodyTaskSectionHeader(taskBackend)}
<link to the task page>

## Automated Tests
<list tests added/modified, or "No test changes">

## Files Changed
<bulleted list of files with brief description of each change>
\`\`\`

---
`
}
## Branch Rules

- Branch name: \`feature/<task-name>\`
- Never commit directly to \`${targetBranch}\` or \`main\`
${
  gitMode === 'local-only'
    ? `- One task per session — no scope creep`
    : `- Never merge your own PR
- One task per session — no scope creep`
}

---

## Commit Attribution

Every commit **must** include this trailer:

\`\`\`
AI-Authored-By: <model> (session: <session-id>)
\`\`\`

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
- Never run \`git reset --hard\` on the main repository directory
- Never skip pre-commit hooks (\`--no-verify\`)
- Never stage or commit \`CLAUDE.md\` — it contains orchestrator-injected content that must not appear in PRs. Use \`git add <specific files>\` instead of \`git add .\`.

---

## Git Isolation

> **Your worktree directory is \`${worktreePath}\`.**
> This is your \`cwd\`. All commands run here. Never navigate to or operate on any parent directory.

- Never use \`git -C <path>\` pointing outside this worktree
- Never use \`--work-tree\` or \`--git-dir\` flags pointing outside this worktree
- Never run \`git checkout\` or \`git switch\` targeting a branch in the main repo directory

---

## Filesystem Isolation (Personal Mode)

> ⚠️ **No sandbox** — isolation is prompt-level only. Writes outside the worktree corrupt the developer's environment.

All file writes **must stay inside** \`${worktreePath}\`. Never write to the project root, \`/tmp/\`, or \`$HOME\`. For scratch files use \`.claude/\` in your worktree.

---

## Bash Rules (Permission System)

Bash is authorized by **first-token** prefix matching. Violations cause **silent denial**.

**Rule 1 — One command per Bash call.**
Never chain with \`&&\`, \`;\`, or \`||\`. Split into separate Bash calls.

**Rule 2 — Never prefix with \`cd path &&\`.** You're already in the worktree; run commands directly.

**Rule 3 — No heredoc subshells in git commit.**
Use repeated \`-m\` flags instead: \`git commit -m "subject" -m "body"\` — git concatenates them.

**Rule 4 — Do not write to \`/tmp/\` or paths outside the worktree.**
Use the Write tool; never use \`cat >\`, \`printf >\`, or \`echo >\` redirects.

${bashRulesText}${
    taskContent
      ? `

---

## Task Spec

> This is the full task specification, pre-fetched by the orchestrator.
> Do NOT re-fetch this from Notion — use the content below as your source of truth.

${taskContent}`
      : ''
  }${
    projectContextContent
      ? `

---

## Project Context

> Pre-loaded from PROJECT.md in the project root.

${projectContextContent}`
      : ''
  }`.trimEnd();
}

/**
 * Build a lightweight CLAUDE.md for review sessions.
 *
 * Review sessions must NOT receive code-session lifecycle rules (branch creation,
 * pre-PR gate, Notion fetching, etc.). They only need to know they are a reviewer
 * and should output JSON verdicts.
 */
export function buildReviewClaudeMd(taskName: string): string {
  return `# Review Session Rules

You are a **PR review session**. Your only job is to evaluate pull request diffs
against task specifications and output structured JSON verdicts.

## What you are
- A code reviewer. You read diffs and compare them against task specs.
- You output JSON verdicts in the format requested by your prompt.

## What you must NOT do
- Do NOT implement code, create branches, or make commits.
- Do NOT fetch Notion pages, check git status, or look for tasks to work on.
- Do NOT open or modify pull requests.
- Do NOT update task statuses.
- Do NOT treat follow-up messages as instructions to start coding.
  Follow-up messages contain updated diffs for re-review — evaluate them
  the same way you evaluated the original diff.

## Manual verification items — critical rule

Some task acceptance criteria contain a section titled "### 👁️ Manual verification"
(or similar wording like "Manual verification", "👁️ Manual", etc.).

Items under that heading require a human reviewer with live credentials or
environment access — they CANNOT be verified by automated code review.

You MUST follow these rules for manual verification items:
- **Do NOT evaluate them** as pass/fail criteria for your verdict.
- **Do NOT fail the PR** solely because manual verification steps are not
  demonstrated in the PR body or diff.
- **Do NOT pressure the coding session** to perform manual verification.
- **DO list them** verbatim in the "manualItemsForHuman" field of your JSON
  response so that a human reviewer can check them at PR-review time.

Evaluating manual verification items is a category error — it creates pressure
for the coding session to either fake the verification or take risky autonomous
actions. Your verdict must be based solely on the automated, code-checkable items.

## Task
${taskName}

## On session resume
If this session is resumed or receives a follow-up message, it means there is
a new diff to review. Wait for the diff content, then output a new JSON verdict.
Do NOT start implementing anything.`.trimEnd();
}
