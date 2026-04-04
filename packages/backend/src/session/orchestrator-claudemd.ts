export interface OrchestratorClaudeMdParams {
  taskName: string;
  taskUrl: string;
  projectContextUrl: string;
  targetBranch: string;
  /** Absolute path to the worktree directory. Injected into Git Isolation rules. */
  worktreePath: string;
  /** Pre-PR gate commands. Defaults to Node.js/Vite commands when omitted. */
  prGate?: {
    typeCheck: string;
    build: string;
  };
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
export function buildOrchestratorClaudeMd(params: OrchestratorClaudeMdParams): string {
  const { taskName, taskUrl, projectContextUrl, targetBranch, worktreePath, prGate, bashRules, taskBackend = 'notion' } = params;

  const resolvedPrGate = prGate ?? { typeCheck: 'npx tsc --noEmit', build: 'npx vite build' };
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

${taskBackend === 'local'
  ? `> ⚠️ **TASK_BACKEND=local**: Task context comes from \`tasks.yaml\` in the project root, not Notion.
> Skip steps 1 (Notion fetch) and instead read \`tasks.yaml\` for task context.

1. Read \`tasks.yaml\` in the project root for task context (skip Notion fetch).
2. Create a feature branch: \`feature/<task-name>\` from \`${targetBranch}\`.`
  : `1. Fetch the Notion task page and project context page.
2. Create a feature branch: \`feature/<task-name>\` from \`${targetBranch}\`.`}
3. Implement the task per the acceptance criteria on the task page.
4. Pass the pre-PR gate (see Pre-PR Gate section below).
5. Open a draft PR targeting \`${targetBranch}\` using the required body template.
6. **Stop and wait.** The dashboard sends review feedback as follow-up messages.
   Address findings by pushing additional commits, then wait again.

---

## Status Ownership

**Do NOT update Notion task status.**
**Do NOT call any Notion API to change task status.**
The orchestrator backend handles all status transitions (In Progress → In Review → Done).

---

## PR Format Standards

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

## Branch Rules

- Branch name: \`feature/<task-name>\` from \`${targetBranch}\`
- Never commit directly to \`${targetBranch}\` or \`main\`
- Never merge your own PR
- One task per session — no scope creep

---

## Pre-PR Gate

Run in order — all must pass before opening the PR:

1. Rebase onto \`${targetBranch}\` and resolve any conflicts.
2. \`${resolvedPrGate.typeCheck}\` — must pass.
3. \`${resolvedPrGate.build}\` — must pass without errors.

---

## Forbidden Actions

- Never push directly to \`main\`
- Never force push (\`--force\`)
- Never delete branches that live outside this worktree
- Never run \`git reset --hard\` on the main repository directory
- Never skip pre-commit hooks (\`--no-verify\`)

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

## Bash Rules (Permission System)

Your Bash commands are authorized by prefix matching on the **first token**.
Violating these rules causes **silent denial** — the command fails with no error message.

**Rule 1 — One command per Bash call.**
Never chain with \`&&\`, \`;\`, or \`||\`. Split into separate Bash calls.

**Rule 2 — Never prefix with \`cd path &&\`.**
You are already in the worktree directory. Just run the command directly.

**Rule 3 — No heredoc subshells in git commit.**
\`git commit -m "$(cat <<'EOF'...)"\` is denied. Use a simple \`-m "message"\` instead.
For multiline commit messages, use \`git commit -F <file>\` and write the file with the Write tool first.

**Rule 4 — Do not write to \`/tmp/\` or paths outside the worktree.**
Use the Write tool for any file creation. Never use \`cat >\`, \`printf >\`, or \`echo >\` redirects.

${bashRulesText}`.trimEnd();
}
