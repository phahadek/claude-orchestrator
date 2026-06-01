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
   * Optional contents of `.claude/local-context.md` from the project root.
   * Appended to the merged CLAUDE.md so orchestrator-launched sessions see the
   * same host-local context (Notion URLs, etc.) as direct Claude Code sessions.
   * Omitted when the file is absent (e.g. fresh clone).
   */
  localContext?: string;
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
 *  5. PR format standards
 *  6. Branch rules
 *  7. Pre-PR gate
 *  8. Forbidden actions
 *  9. Git isolation
 * 10. Filesystem isolation (personal mode)
 * 11. Bash rules (permission system)
 * 12. Separator + "# Project Instructions (from project CLAUDE.md)" (added by caller)
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

> ⚠️ These rules are injected by the dashboard orchestrator and take priority over any
> project-level instructions below. Do not remove, reorder, or override them.

---

## Task Assignment

- **Task**: ${taskName}
- **${taskAssignmentLabel(taskBackend)}**: ${taskUrl}
- **Project context**: ${projectContextUrl}

---

## Lifecycle

Follow these steps in order — every session:

${
  taskContent
    ? `> **Task spec is pre-loaded below.** Do NOT fetch Notion pages — the task content has
> already been injected by the orchestrator. Proceed directly to implementation.

1. Read the **Task Spec** section below — it contains the full task specification.
2. Create your task branch from the current HEAD: \`git checkout -b feature/<task-name>\`.`
    : taskBackend === 'local'
      ? `> ⚠️ **YAML task source**: Task context comes from \`tasks.yaml\` in the project root.
> Skip the remote fetch step and instead read \`tasks.yaml\` for task context.

1. Read \`tasks.yaml\` in the project root for task context (skip remote fetch).
2. Create your task branch from the current HEAD: \`git checkout -b feature/<task-name>\`.`
      : `1. ${fetchInstruction(taskBackend)}
2. Create your task branch from the current HEAD: \`git checkout -b feature/<task-name>\`.`
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

This session runs in \`--print\` mode with no human watching the output.
Optimize for speed and token efficiency:

- **Do NOT use TodoWrite.** No one sees the todo list. Track your progress internally.
- **Do NOT use Agent subagents for exploration.** Use Glob and Grep directly.
- **Minimize tool calls.** Batch independent reads. Don't re-read files you already read.
- **Keep commit messages and PR descriptions concise.** One sentence summaries, not essays.
- **Prefer Edit over Write for files that already exist.** Only use Write to create a new file or when replacing the majority of a file. Never re-emit an unchanged file body.
- **Never Read a file you just wrote or edited** — you already know its contents and line layout.
- **Never Read/cat raw \`tasks/*.output\` background-task files** — they bypass the Bash output cap. Use the TaskOutput tool if you must inspect a backgrounded command's output.

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

- Branch name: \`feature/<task-name>\` — created from the worktree's current HEAD
- Never commit directly to \`${targetBranch}\` or \`main\`
${
  gitMode === 'local-only'
    ? `- One task per session — no scope creep`
    : `- Never merge your own PR
- One task per session — no scope creep`
}

---

## Commit Attribution

Every commit **must** include the following trailer (replace \`<model>\` and \`<session-id>\` with your actual model ID and session ID):

\`\`\`
AI-Authored-By: <model> (session: <session-id>)
\`\`\`

Example: \`AI-Authored-By: claude-sonnet-4-6 (session: f98ff4ec)\`

The backend verifies this trailer server-side. In corporate mode, missing trailers pause the task.

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

- All git commands must run inside the worktree directory (your \`cwd\`)
- Never use \`git -C <path>\` pointing outside this worktree
- Never use \`--work-tree\` or \`--git-dir\` flags pointing outside this worktree
- Never run \`git checkout\` or \`git switch\` targeting a branch in the main repo directory
- The backend records the main repo branch before each session and will warn if it drifts

---

## Filesystem Isolation (Personal Mode)

> ⚠️ **Personal mode has no structural sandbox** — there is no docker, chroot, or
> namespace to prevent writes outside the worktree. All isolation is prompt-level.
> Violating these rules can corrupt the developer's live environment.

All file writes **must stay inside the worktree directory** (\`${worktreePath}\`).

- **Never write to the project root or any path above the worktree.**
  Scripts, tools, and generated outputs must target paths under the worktree, not the parent repo.
- **Dev state (SQLite databases, log files, generated artifacts) must use worktree-relative paths.**
  Do not reference absolute paths to project-root databases or output files.
  Use paths like \`<worktree>/.dev-state/<file>\` or resolve paths relative to \`cwd\`.
- **Before running any script that writes files or opens a database, verify the target path is inside the worktree.**
  If a script hardcodes an absolute project-root path, patch it to accept an env var or relative path before executing.

---

## Bash Rules (Permission System)

Your Bash commands are authorized by prefix matching on the **first token**.
Violating these rules causes **silent denial** — the command fails with no error message.

**Rule 1 — One command per Bash call.**
Never chain with \`&&\`, \`;\`, or \`||\`. Split into separate Bash calls.

**Rule 2 — Never prefix with \`cd path &&\`.**
You are already in the worktree directory. Just run the command directly.

**Rule 3 — No heredoc subshells in git commit.**
\`git commit -m "$(cat <<'EOF'...)"\` is denied. Use a simple \`-m "message"\` instead.
For multiline commit messages, write the message to \`.claude/.commit-msg\` with the Write tool, then run \`git commit -F .claude/.commit-msg\`. **Use that exact path** — the \`.claude/\` directory is gitignored, so the scratch file is never accidentally staged. Do not invent other filenames (\`commit-msg.txt\`, \`.git-commit-msg.txt\`, etc.) — they will leak into the PR diff.

**Rule 4 — Do not write to \`/tmp/\` or paths outside the worktree.**
Use the Write tool for any file creation. Never use \`cat >\`, \`printf >\`, or \`echo >\` redirects.

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
  }${
    localContext
      ? `

---

## Local Context

> Host-local context loaded from \`.claude/local-context.md\`.

${localContext}`
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
