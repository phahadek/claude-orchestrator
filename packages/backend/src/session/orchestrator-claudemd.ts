/**
 * Mirrors PRBodyValidator.ts's own DEFAULT_PR_BODY_SECTIONS literal rather
 * than importing it as a value — this is a function-default-parameter value
 * (see `prBodySections` below), and importing it here would silently break
 * for any test that `vi.mock`s PRBodyValidator with a partial factory:
 * vitest's module mocking replaces the resolved module for every importer in
 * the graph, not just the mocking test file's own import statement, so the
 * missing export would resolve to `undefined` and `[...undefined]` would
 * throw. Keep these two literals in sync by hand; drift only affects this
 * template's own default, not PRBodyValidator's validation behavior.
 */
const DEFAULT_PR_BODY_SECTIONS_FALLBACK = [
  '## Summary',
  '## Notion Task',
  '## Automated Tests',
];

export interface OrchestratorClaudeMdParams {
  taskName: string;
  taskUrl: string;
  projectContextUrl: string;
  targetBranch: string;
  /** Absolute path to the worktree directory. Injected into Git Isolation rules. */
  worktreePath: string;
  /**
   * Verify commands the session runs before opening the PR (typecheck, build).
   * The authoritative test gate (OrchestratorConfig.test) is separate and
   * only reachable via the test.request intent — see the rendered
   * "Pre-PR Gate" and "When a Test Fails" sections.
   * Format and lint are handled by orchestrator autofix — not included here.
   * Rendered from the project's `.claude-orchestrator.yml` verify list.
   * When empty or omitted, the gate shows a "no local verify" fallback.
   */
  verify?: string[];
  /**
   * Analyze commands the project marked `pre_pr: true`. Rendered as extra
   * numbered Pre-PR Gate steps after the verify steps. Omitted/empty → the
   * gate renders exactly as before.
   */
  prePrAnalyze?: string[];
  /**
   * Bash rules (Rule 5+). Each item is the full rule text — the first line
   * becomes the bold heading, subsequent lines become the body paragraph.
   * Defaults to the `npx` convention when omitted.
   */
  bashRules?: string[];
  /**
   * Per-project coding-session guidance from `.claude-orchestrator.yml`'s
   * `session_rules`. Rendered as its own "## Project Rules" section, separate
   * from the Bash Rules section. Omitted or empty → no section rendered.
   */
  sessionRules?: string[];
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
  /**
   * Base browse URL for the project's Jira host (e.g. `https://mycompany.atlassian.net`),
   * derived from existing Jira config (project `taskSourceConfig.host` or the
   * `JIRA_HOST` env var) — not a new per-project field. Used only to render a
   * concrete example in the 'local' backend's PR body task-section instruction.
   * Omitted when no Jira host is configured.
   */
  jiraBrowseBaseUrl?: string;
  /**
   * Required PR body section headers, in order — rendered as the "Required
   * body sections" code block in PR Format Standards. Sourced from the
   * project's `.claude-orchestrator.yml` `pr_body.sections` (see
   * OrchestratorConfig.pr_body in orchestrator-config.ts); PRBodyValidator,
   * AgentSession's re-prompt, and SessionAuditor read the same config so all
   * four sites stay in lockstep. '## Notion Task' is a placeholder,
   * substituted at render time with the backend-specific header (e.g. '##
   * GitHub Issue') via prBodyTaskSectionHeader. Defaults to
   * DEFAULT_PR_BODY_SECTIONS — '## Files Changed' is opt-in, not default.
   */
  prBodySections?: string[];
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
 * Body-line instruction for the PR body's task section. Only the 'local'
 * backend needs bespoke wording — it has no hosted task page to link to, so
 * the session is told to record the originating ticket's key and browse URL
 * instead. `jiraBrowseBaseUrl` comes from existing Jira config (project
 * config or the JIRA_HOST env var) — when absent, fall back to a generic
 * example rather than interpolating a broken/empty URL.
 */
function prBodyTaskSectionContent(
  backend: TaskBackend,
  jiraBrowseBaseUrl?: string,
): string {
  if (backend === 'local') {
    const exampleUrl = jiraBrowseBaseUrl
      ? `${jiraBrowseBaseUrl.replace(/\/+$/, '')}/browse/ENG-8641`
      : 'https://yourcompany.atlassian.net/browse/ENG-8641';
    return `Record the originating ticket: its key (e.g. \`ENG-8641\`) and its browse URL (e.g. ${exampleUrl}).`;
  }
  return '<link to the task page>';
}

/** Body-line hints for the section headers PR bodies commonly declare. Any header not listed here (a project's own custom section) renders with a generic placeholder hint. */
const KNOWN_SECTION_HINTS: Record<string, string> = {
  '## Summary': '<1-3 sentences: what changed and why>',
  '## Automated Tests': '<list tests added/modified, or "No test changes">',
  '## Files Changed':
    '<bulleted list of files with brief description of each change>',
};

/**
 * Render the "Required body sections" code block from a project's
 * configured PR body section list. '## Notion Task' is a placeholder
 * substituted with the backend-specific header + hint; every other known
 * header uses its fixed hint; unrecognized (project-custom) headers get a
 * generic placeholder hint.
 */
function renderPrBodySectionsBlock(
  sections: string[],
  taskBackend: TaskBackend,
  jiraBrowseBaseUrl: string | undefined,
): string {
  const lines = sections.map((section) => {
    if (section === '## Notion Task') {
      return `${prBodyTaskSectionHeader(taskBackend)}\n${prBodyTaskSectionContent(taskBackend, jiraBrowseBaseUrl)}`;
    }
    const hint = KNOWN_SECTION_HINTS[section] ?? '<content for this section>';
    return `${section}\n${hint}`;
  });
  return lines.join('\n\n');
}

/**
 * Rough per-configuration size budget for the rendered CLAUDE.md, used by
 * the size-ceiling test suite instead of three hardcoded literals. The
 * template's non-PR-body content is fixed; only the "Required body
 * sections" block grows with the configured section count, so the budget is
 * a fixed base plus a per-section allowance generous enough to cover any
 * known or custom section's header + hint line.
 */
const SIZE_BUDGET_BASE_CHARS = 13500;
const SIZE_BUDGET_PER_SECTION_CHARS = 100;
const SIZE_BUDGET_BASE_WORDS = 2200;
const SIZE_BUDGET_PER_SECTION_WORDS = 10;

export function computeSizeBudget(sections: readonly string[]): {
  maxChars: number;
  maxWords: number;
} {
  return {
    maxChars:
      SIZE_BUDGET_BASE_CHARS + sections.length * SIZE_BUDGET_PER_SECTION_CHARS,
    maxWords:
      SIZE_BUDGET_BASE_WORDS + sections.length * SIZE_BUDGET_PER_SECTION_WORDS,
  };
}

/**
 * Build the orchestrator CLAUDE.md header content to inject into each session worktree.
 *
 * Returns a markdown string with all orchestrator rule sections (sections 1-9).
 * Section 10 — the separator and "# Project Instructions" heading — is appended by
 * the caller along with the project's own CLAUDE.md content.
 *
 * Code-dispatch sessions only. A planning session (groom/design/ops) never
 * receives this content — its appended-prompt file is instead assembled by
 * `planning/procedureAssembler.ts`'s `assemblePlanningProcedure`, which
 * carries its own session-lifecycle/transport rules suited to the
 * stage-then-human-apply execution mode. See `SessionManager.completeStart`'s
 * `injectedProcedureContent` branch.
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
    prePrAnalyze,
    bashRules,
    sessionRules,
    taskBackend = 'notion',
    taskContent,
    projectContextContent,
    gitMode = 'github',
    jiraBrowseBaseUrl,
    prBodySections = [...DEFAULT_PR_BODY_SECTIONS_FALLBACK],
  } = params;

  const resolvedBashRules = bashRules ?? [
    'Use `npx` instead of bare tool names.\n`tsc` → `npx tsc`. Bare commands may not be on PATH.',
  ];

  const rule3Text =
    gitMode === 'local-only'
      ? '**Rule 3 — No heredoc subshells in git commit.**\nUse repeated `-m` flags instead: `git commit -m "subject" -m "body"` — git concatenates them.'
      : '**Rule 3 — No heredoc subshells in git commit or gh PR bodies.**\nUse repeated `-m` flags for `git commit` instead: `git commit -m "subject" -m "body"` — git concatenates them. For `gh pr create`/`gh pr edit`/`gh pr comment`, don\'t pass `--body "$(cat <<\'EOF\' …)"` — use the `<pr-body>` marker (see PR Format Standards) to set or update the PR body instead.';

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

> ⚠️ **Your task is pre-assigned (see Task Assignment above). Never browse the task board or self-assign a different task. If you have no remaining work because it's already satisfied elsewhere, call \`planning.noOp\` (task id + resolving commit/PR) instead of stopping silently — a silent stop re-dispatches the task forever.**

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

${
  gitMode === 'local-only'
    ? ''
    : `## Nudges

A nudge is an unsolicited orchestrator message about your open PR — a merge-conflict, "base branch moved", or stalled-merge notice. Act on what it names, ahead of the "stop and wait" default above, which covers the gap between review passes, not a flagged change. Compliance isn't checked; act because it's true.

Keep your PR mergeable against \`${targetBranch}\` for its whole life, not just through the Pre-PR Gate — rebase and push once you learn it's needed.

The supervisor's "Pause your work" message isn't a nudge in this sense: stopping is what it asks, so stopping is full compliance.

---

## When a Test Fails

A failing test (from \`test_request\`, CI, or the F2 gate) is presumed caused by your diff until you have evidence otherwise. Test commands are blocked at the permission layer — always run them via \`mcp__orchestrator__test_request\`, never directly (the result lands in your feedback inbox next turn). Do not push an empty commit to force a re-run: it re-drives nothing. Pick exactly one of three paths.

### Path 1 — Investigate and fix (the default)

1. Read the digest. Each unattributed failing test carries an indicator line, \`[breadth N/M, flips F/W]\`: how many other trees show the same failure, and how often it has flipped pass/fail recently. Above the mass-breakage threshold the digest groups failures by module instead of listing each one.
2. Pull the trace with the digest's \`testHealth.getTestTrace(testId)\` pointer and read the assertion text and stack — the digest alone shows names, not why they failed.
3. Fix the cause in your branch.
4. Verify the fix with the **targeted-retest lane**: re-run only the failing test ids on the dedicated targeted queue instead of waiting on the full suite. Run the full \`test_request\` once, as the final check on the finished tree.

### Path 2 — Wait

If the indicator shows attribution may still arrive (other trees have not yet recorded the failure) and no not-reproduced wake has fired, wait. A digest **Wait** instruction means you will be woken at most once — do not re-run the unchanged tree.

### Path 3 — File the operator override and wait

Only once the not-reproduced wake has fired and you cannot fix the failure yourself: stage \`mcp__orchestrator__test_override\` (the \`test.override\` intent) with \`testIds\` and \`evidence\` (\`traceReads\`: the traces you read; \`targetedRunIds\`: your targeted retest runs; \`investigationNote\`), optionally \`linkedFixTaskId\`. Then stop and wait for the operator. An approved override excuses the named tests for this task's runs only, until the task is terminal, the linked fix task is Done, or a run of your own tree passes the test.

Retrying \`test_request\` against an unchanged tree is futile: a settled run replays via dedup, and a broken run (timeout, crash, OOM, failed spawn) stays held for operator approval — re-staging changes neither. Asking the operator about the environment is a last resort, after Path 1.

---

## Responding to Review Comments

When a follow-up message delivers review feedback tied to specific GitHub review comments (each comment has a \`comment_id\`), after you've addressed them — by pushing a commit, or by deciding a comment doesn't need a code change — call the \`mcp__orchestrator__review_disposition\` tool once per \`comment_id\` to report the outcome:

- \`comment_id\` is the numeric GitHub review comment ID from the feedback message — not the PR number.
- \`disposition\` is one of:
  - \`"addressed"\` — you changed code (or confirmed existing behavior already satisfies the comment) and pushed a commit.
  - \`"wont_fix"\` — you deliberately did not change anything; the comment is valid but out of scope for a fix here, or you disagree with it.
  - \`"out_of_scope"\` — the comment asks for something beyond this task's scope (scope creep, unrelated refactor, etc.).
- \`reason\` is required for every call — a one-line explanation a human reviewer can read without opening the diff.
- Call it once per routed review comment you were given, not just the ones you changed code for. The orchestrator replies to and resolves each comment's thread on GitHub based on these calls — a comment with no call stays open and unresolved.

### Disputing a blocking verdict

When a delivered verdict (\`needs_changes\`, \`incomplete\`, \`verify_failed\`, \`autofix_failed\`) asks for something you conclude is wrong, already satisfied, or forbidden by a Project Rule, do not decline in chat and wait. Stage \`mcp__orchestrator__review_dispute\` once with \`taskId\`, \`prNumber\`, \`repo\` and a \`rationale\` naming the evidence (the rule, the file:line, the test result). Then stop: the operator decides, and approval lets the PR proceed without a new commit. Declining in chat leaves nothing for the operator to act on.

---

`
}## Status Ownership

**Do NOT update ${taskAssignmentLabel(taskBackend)} status.**
**Do NOT call any ${taskBackendApiName(taskBackend)} to change task status.**
The orchestrator backend handles all status transitions (In Progress → In Review → Done).

---

## Efficiency Rules

Running in \`--print\` mode — optimize for speed and token efficiency:

- **Do NOT use TodoWrite.** No one sees the todo list. Track your progress internally.
- **Arch units named in the task:** read via \`architecture.queryUnits({ title })\` / \`architecture.getUnit({ id })\`.
- **Do NOT use Agent subagents for exploration.** Use Glob and Grep directly.
- **Minimize tool calls.** Batch reads; don't re-read files you just wrote or edited.
- **Prefer Edit over Write** for existing files; never re-emit unchanged file bodies.
- **Commit messages:** one sentence summaries. **PR body \`## Summary\` section:** 1-3 sentences — see PR Format Standards below for the full required section list.
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
- **How to create the PR**: emit the body inside \`<pr-body>…</pr-body>\` in your final message — this is the sanctioned path. Do NOT use the MCP \`mcp__github__create_pull_request\` tool. If a PR was already opened another way (e.g. you ran \`gh pr create\` directly), that is fine and does not need to be undone — the orchestrator detects and tracks it too; just re-emit the \`<pr-body>\` marker if the body still needs to match the template below.
- **Required body sections**:

\`\`\`
${renderPrBodySectionsBlock(prBodySections, taskBackend, jiraBrowseBaseUrl)}
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
- One task per session — no scope creep
- A session owns exactly one PR, opened from its assigned \`feature/<task-name>\` branch — never create another branch or open another PR, including to "split out" work.
- When review flags changes as unrelated to the task, remove them from your own branch with revert commits and push — do not move them to another branch or PR.`
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
        .map((cmd, i) => `${i + 2}. \`${cmd}\` — must pass.`)
        .join('\n')
    : `2. No local verify step configured — CI is the gate.`;
  const verifyCount = verifyItems ? verifyItems.length : 0;
  const analyzeItems =
    prePrAnalyze && prePrAnalyze.length > 0 ? prePrAnalyze : null;
  const analyzeSteps = analyzeItems
    ? '\n' +
      analyzeItems
        .map((cmd, i) => `${verifyCount + i + 2}. \`${cmd}\` — must pass.`)
        .join('\n')
    : '';
  const analyzeNote = analyzeItems
    ? `\n\nRun the analyze steps above before your final \`test_request\`: the orchestrator's analyze stage rejects the same failures after the PR opens, and fixing one after the test run means a new tree and a new full test run.`
    : '';
  const stageNum =
    (verifyItems ? verifyItems.length + 2 : 3) +
    (analyzeItems ? analyzeItems.length : 0);
  return `## Pre-PR Gate

Run in order — all must pass before opening the PR:

1. Rebase onto \`${targetBranch}\` and resolve any conflicts. If this branch was already pushed, update the remote with \`git push --force-with-lease origin <your feature branch>\` — a bare \`git push\` will be rejected after a rebase.
${verifySteps}${analyzeSteps}
${stageNum}. Stage only your implementation files for commit.${analyzeNote}

Tests are blocked at the permission layer, not part of this gate — run via \`test_request\`. A failed \`test_request\` here: follow the three paths in "When a Test Fails" above rather than retrying.`;
})()}

---

## Forbidden Actions

- Never push directly to \`main\`
- Never bare force push (\`git push --force\`)
- Never force-push \`main\`, \`${targetBranch}\`, or any branch outside this worktree's own feature branch
- \`git push --force-with-lease origin <your feature branch>\` **is allowed** — use it to update your own PR branch after a rebase (see Pre-PR Gate)
- Never delete branches that live outside this worktree
- Never run \`git reset --hard\` on the main repository directory
- Never skip pre-commit hooks (\`--no-verify\`)
- Use \`git add <specific files>\` instead of \`git add .\` — review staged files before committing.
${
  gitMode === 'local-only'
    ? ''
    : `- Never run \`gh pr close\` or \`gh pr reopen\`, and never close or recreate your own PR to "redo" it — the orchestrator tracks whatever PR is currently open. If it was opened the wrong way, leave it open; just re-emit the \`<pr-body>\` marker if the body needs updating.
`
}
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

All file writes **must stay inside** \`${worktreePath}\`. Never write to the project root, \`/tmp/\`, or \`$HOME\`. For scratch files use \`.claude/scratch/\` in your worktree.

---

## Manual Verification Gate

Manual/runtime verification is owned by the milestone's Manual Verification Gate, not
by you. Do NOT run, attempt, or simulate manual/runtime tests to satisfy acceptance
criteria. Your task carries no manual-verification section by default — its absence
does NOT mean "go run something"; it means the gate already owns it. Ship only what
the automated acceptance criteria require.

---

## Bash Rules (Permission System)

Bash is authorized by **first-token** prefix matching. Violations cause **silent denial**.

**Rule 1 — One command per Bash call.**
Never chain with \`&&\`, \`;\`, or \`||\`. Split into separate Bash calls.

**Rule 2 — Never prefix with \`cd path &&\`.** You're already in the worktree; run commands directly.

${rule3Text}

**Rule 4 — Do not write to \`/tmp/\` or paths outside the worktree.**
Use the Write tool; never use \`cat >\`, \`printf >\`, or \`echo >\` redirects.

${bashRulesText}${
    sessionRules && sessionRules.length > 0
      ? `

---

## Project Rules

${sessionRules.map((rule) => `- ${rule}`).join('\n')}`
      : ''
  }${
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
 * and should report their verdict via the review.verdict MCP tool.
 */
export function buildReviewClaudeMd(
  taskName: string,
  reviewRules?: string[],
  sessionRules?: string[],
): string {
  const projectRulesSection =
    sessionRules && sessionRules.length > 0
      ? `
## Project Rules (binding on the implementing session)

> These rules bound the coding session that produced this PR. They take precedence over the task spec:
> where the task spec (Context, Acceptance criteria, Files/paths affected) asks for something a Project Rule forbids,
> a PR that follows the Project Rule is correct. Do not fail any dimension for it, and do not ask the session to break the rule.
> If a spec item is unsatisfiable only because of a Project Rule, note the conflict in your summary for the operator
> instead of returning needs_changes for it.

${sessionRules.map((rule) => `- ${rule}`).join('\n')}
`
      : '';
  return `# Review Session Rules

You are a **PR review session**. Your only job is to evaluate pull request diffs
against task specifications and report your verdict via the \`mcp__orchestrator__review_verdict\`
tool.

## What you are
- A code reviewer. You read diffs and compare them against task specs.
- You report your verdict by calling the \`mcp__orchestrator__review_verdict\` tool with the
  fields your prompt requests (verdict, dimensions, summary, manualItemsForHuman, escalate,
  escalationReason) — never by writing a JSON block in chat text.

## What you must NOT do
- Do NOT implement code, create branches, or make commits.
- Do NOT fetch Notion pages, check git status, or look for tasks to work on.
- Do NOT open or modify pull requests.
- Do NOT update task statuses.
- Do NOT treat follow-up messages as instructions to start coding.
  Follow-up messages contain updated diffs for re-review — evaluate them
  the same way you evaluated the original diff.

## Manual verification items — critical rule

💻 Code tasks do not carry a "### 👁️ Manual verification" section in their spec —
runtime/manual verification for a Code task is owned by the milestone's Manual
Verification Gate, not by this review. Do NOT look for one, and do NOT treat its
absence as a gap to flag — the absence is expected and correct.

Some non-Code task specs (📐 Design, 🔧 Operational, 🔎 Investigation) legitimately
carry a section titled "### 👁️ Manual verification" (or similar wording). Items
under that heading require a human reviewer with live credentials or environment
access — they CANNOT be verified by automated code review.

You MUST follow these rules for manual verification items when a spec carries them:
- **Do NOT evaluate them** as pass/fail criteria for your verdict.
- **Do NOT fail the PR** solely because manual verification steps are not
  demonstrated in the PR body or diff.
- **Do NOT pressure the coding session** to perform manual verification.
- **DO list them** verbatim in the "manualItemsForHuman" argument of your
  \`review.verdict\` tool call so that a human reviewer can check them at PR-review time.

Evaluating manual verification items is a category error — it creates pressure
for the coding session to either fake the verification or take risky autonomous
actions. Your verdict must be based solely on the automated, code-checkable items.

## Task
${taskName}
${projectRulesSection}${
    reviewRules && reviewRules.length > 0
      ? `
## Project Review Criteria

> Per-project enforcement criteria this review must apply, in addition to the
> standard dimensions in your prompt's JSON schema. If any of these indicate
> the PR requires human/operator attention rather than another coding-session
> iteration, set "escalate": true and explain why in "escalationReason".

${reviewRules.map((rule) => `- ${rule}`).join('\n')}
`
      : ''
  }
## On session resume
If this session is resumed or receives a follow-up message, it means there is
a new diff to review. Wait for the diff content, then call \`review.verdict\` again
with your new verdict. Do NOT start implementing anything.`.trimEnd();
}

/**
 * Builds the CLAUDE.md header for a depth-review session (session type
 * 'depth_review') — the second, separate review pass dispatched only after a
 * PR's conformance verdict (session type 'review') reaches approved. Distinct
 * from buildReviewClaudeMd: this pass never evaluates conformance
 * (title/description vs Summary, diff vs Context spec, diff vs Acceptance
 * Criteria, changed files vs Files/paths affected) — only security,
 * concurrency, reliability/crash, data-integrity/parsing correctness, and
 * size-proportionality (relocated here from the conformance pass).
 */
export function buildDepthReviewClaudeMd(taskName: string): string {
  return `# Depth Review Session Rules

You are a **depth review session** — a second, separate review pass that runs
only after a PR's conformance review (title/description vs Summary, diff vs
Context spec, diff vs Acceptance Criteria, changed files vs Files/paths
affected) has already been approved. Your job is NOT to re-check conformance —
it is to judge whether the diff is correct and safe, beyond matching what the
task said it would do.

## What you are
- A defect-hunting reviewer, not a spec-conformance reviewer.
- You evaluate the diff already embedded in your prompt across five
  dimensions: security, concurrency, reliability/crash, data-integrity &
  parsing correctness, and size-proportionality.
- You output a single JSON verdict in the format requested by your prompt.

## What you must NOT do
- Do NOT implement code, create branches, make commits, or open/modify pull
  requests — you have no git-push or GitHub-write tool access.
- Do NOT fetch Notion pages, check git status, or look for tasks to work on.
- Do NOT update task statuses.
- Do NOT re-litigate conformance (Summary/Context spec/Acceptance
  Criteria/Files affected) — the conformance pass already ran and approved
  this diff; re-flagging a conformance-only concern here has no effect.

## Task
${taskName}
`.trimEnd();
}
