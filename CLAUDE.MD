# Claude Code Orchestrator — session bootstrap

> ⚠️ **Your first action in this session must be to read `.claude/local-context.md` to load project context. Do this before responding to the user.**
>
> `.claude/local-context.md` is **gitignored** and contains environment-specific
> configuration (Notion URLs, board IDs, links to design docs, etc.). It is
> populated per-host, per-developer from `.claude/local-context.md.example`.
>
> If `.claude/local-context.md` does not exist:
>
> - The repo was likely just cloned. Tell the human and stop — do not proceed.
> - Setup: `cp .claude/local-context.md.example .claude/local-context.md`, then
>   edit it with the project's real Notion URLs.

---

## Step 1 — Fetch project context — always

After loading `.claude/local-context.md`, fetch the **Project Context** page
whose URL is recorded there. It contains the master context, session
instructions, active task board link, and the full file index.

**If the fetch fails: stop and tell the human. Do not proceed.**

## Step 2 — Fetch the active task board

The Project Context page contains a link to the active task board under
"Active Task Board". Fetch it and filter to tasks with Status = 🔄 In Progress
or 🗂️ Ready. Work only on the task you have been assigned.

## Step 3 — Fetch child pages only when your task needs them

URLs for the Product Design Doc, Technical Architecture, and Dev Setup / Coding
Guidelines are recorded in `.claude/local-context.md`. Fetch them only when
the task at hand requires that context.

---

## Rules

|                                         |                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Source of truth**                     | Notion — never infer rules from code or git history                                                          |
| **Scope**                               | One task per session. No scope creep.                                                                        |
| **Branch naming**                       | `feature/<task-name>` from `dev`                                                                             |
| **Commit to `dev` or `main` directly?** | Never                                                                                                        |
| **When done**                           | Open draft PR → mark task 👀 In Review → stop. Human merges and marks ✅ Done.                               |
| **Pre-PR gate (verify only)**           | 1. Rebase `dev` → resolve conflicts. 2. Run `verify` commands from `.claude-orchestrator.yml` (typecheck, build). No format/lint — orchestrator autofix handles those after PR opens. |
| **Formatting / linting**                | Handled by orchestrator autofix after PR opens — not a session gate step.                                    |
| **Blame ignore (once per clone)**       | Run `git config blame.ignoreRevsFile .git-blame-ignore-revs` to hide mass-format commits from blame.         |
| **Session Log / File Index updates**    | Never — the dashboard handles session tracking.                                                              |

## Memory policy

**Never write to memory.** This project does not use the per-Claude-Code memory system. All durable context must live in one of:

- This `CLAUDE.md` (human + main-session rules — always loaded)
- The Notion docs linked from `.claude/local-context.md` (Project Context, Task Writing Guidelines, Coding Guidelines, etc. — source of truth for cross-session rules)
- The review-session `CLAUDE.md` template at `packages/backend/src/session/orchestrator-claudemd.ts` (rules that need to reach orchestrator-launched review sessions specifically)
- The code itself (anything verifiable by reading the current source)

**Why:** memory is per-Claude-Code-instance, but the actual work happens in many separate processes (orchestrator-launched coding sessions, review sessions, etc.) that cannot see this instance's memory. Writing rules to memory creates the false confidence that the rule is "saved" when in fact it's invisible to the agents who need it. Rules that need to apply across sessions belong in CLAUDE.md or Notion. Rules that need to reach review sessions specifically belong in the review-session CLAUDE.md template.

**If asked to remember something:** save it to one of the four places above — never to memory. Ask the human where it should live if it's not obvious.

## PR Format

- Title: `feat: <exact task name>` — no scope prefix, no milestone tag
- Use `gh pr create --draft --base dev --body-file /tmp/pr-body.md`
- Body must include: ## Summary (bullets), ## Test plan (checkboxes), Notion task URL

### Git isolation — critical

**All git commands must run inside the worktree directory (`cwd` = worktree path).**
Never use `git -C`, `--work-tree`, `--git-dir`, or any absolute path flag that
points outside your worktree. Never run `git checkout`, `git switch`, or `git reset`
targeting a branch that lives in the main repository directory. The backend records
the main repo's branch before each session and will warn (and restore) if it drifts —
but preventing drift is your responsibility.

### Task Lifecycle — follow this end-to-end, every session

1. **Move task to `🔄 In Progress`** in Notion as soon as you begin work.
2. **Create a feature branch from `dev`** — named `feature/<task-name>` — **inside the worktree** (`git checkout -b feature/<name> dev` or `git switch -c feature/<name> dev`).
3. **Implement the task** per the acceptance criteria in the Notion task page.
4. **Pass the pre-PR gate** (rebase onto `dev`, `tsc --noEmit`, `vite build`).
5. **Open a draft PR targeting `dev`** — use the required PR body template below.
6. **Move task to `👀 In Review`** in Notion.
7. **Stop.** Never merge your own PR. Never move the task to `✅ Done`. Wait for the human.

> ⚠️ Steps 6 and 7 are hard stops. The human merges the PR and marks the task Done.
> Appending to the Session Log and updating the Master File Index are also the human's responsibility after merge.

### Required PR Body Template

Every draft PR **must** use this exact structure — no omissions, no reordering:

```markdown
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

## Tool Permissions (dashboard-launched sessions)

When sessions are launched via the dashboard, the backend spawns `claude --print`
with `--permission-mode acceptEdits`. This controls what tools are auto-accepted
or auto-denied by the CLI. **There is no mid-session approval mechanism** — the
CLI does not support interactive permission prompts in `--print` mode.

### How Bash permissions work

`acceptEdits` auto-approves **read-only** Bash commands (e.g. `git status`, `ls`).
**Write** Bash commands (e.g. `git commit`, `npm install`) require explicit
`--allowed-tools` entries. The CLI supports granular patterns: `Bash(git:*)`
allows only commands starting with `git`. Unmatched Bash commands are silently
denied in `--print` mode (no prompt, no error event — just a permission denial
in the `result` event's `permission_denials` array).

### Bash command formatting rules (MUST follow)

These rules exist because `Bash(prefix:*)` matching evaluates only the **first token**
of the command string. Compound commands are silently denied even when every prefix
is individually allowed.

**Rule 1 — One command per Bash call. Never chain with `&&` or `;`.**

```bash
# DENIED — prefix is "cd", chained git commit cannot be authorized
cd /path && git add . && git commit -m "msg"

# CORRECT — Split into separate Bash calls:
#   Call 1: git -C /path add .
#   Call 2: git -C /path commit -m "msg"
```

**Rule 2 — Never prefix a command with `cd path &&`. Use alternatives:**

- **git:** Use `git -C <path>` instead of `cd path && git ...`
- **npm:** Use `npm --prefix <path>` or the `-w` workspace flag with an absolute path
- **Other:** Use separate Bash calls

```bash
# DENIED — starts with "cd"
cd /path/to/repo && git checkout -b feature/my-task dev

# CORRECT — Use git -C
git -C /path/to/repo checkout -b feature/my-task dev

# DENIED — starts with "cd"
cd /path && npm run -w packages/frontend tsc

# CORRECT — Use npm --prefix (or run from correct cwd)
npm --prefix /path run -w packages/frontend tsc
```

**Rule 3 — Use `npx tsc` instead of bare `tsc`.**

`tsc` is not guaranteed to be on PATH. Always invoke via `npx`.

```bash
# AVOID
tsc --noEmit
./node_modules/.bin/tsc --noEmit

# CORRECT
npx tsc --noEmit
```

**Rule 4 — Avoid pipes (`|`) with write commands.**

Pipes may interfere with prefix matching. Keep write commands simple. If you need
to limit output, let the Bash tool handle truncation.

### Auto-accepted (will execute without prompting)

| Tool                                                           | Why                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `Read`, `Glob`, `Grep`, `ToolSearch`                           | Read-only, always safe                                      |
| `Edit`, `Write`                                                | `acceptEdits` mode auto-approves in-project file operations |
| `Bash` (read-only: `ls`, `cat`, `head`, etc.)                  | `acceptEdits` auto-approves read-only Bash                  |
| `Bash(git:*)`                                                  | Explicitly in `--allowed-tools` — all git operations        |
| `Bash(npm:*)`, `Bash(npx:*)`, `Bash(node:*)`                   | Explicitly in `--allowed-tools` — Node.js tooling           |
| `Bash(gh:*)`                                                   | Explicitly in `--allowed-tools` — GitHub CLI                |
| `Bash(ls:*)`, `Bash(cat:*)`, `Bash(mkdir:*)`, etc.             | Explicitly in `--allowed-tools` — common file ops           |
| `TodoWrite`, `Skill`, `EnterPlanMode`, `ExitPlanMode`          | Session management tools                                    |
| `mcp__claude_ai_Notion__*`                                     | Explicitly in `--allowed-tools`                             |
| `mcp__github__*`                                               | Explicitly in `--allowed-tools`                             |
| `mcp__claude_ai_Asana__*`, `mcp__claude_ai_Google_Calendar__*` | Explicitly in `--allowed-tools`                             |

### Auto-denied (will fail silently — session sees "permission denied" in tool result)

| Tool                                                      | Example                                       |
| --------------------------------------------------------- | --------------------------------------------- |
| `Bash` with non-allowlisted prefix                        | `curl`, `wget`, `rm`, `sudo`, `docker`, `ssh` |
| Any tool not listed above                                 | Custom MCP tools, `Agent`, etc.               |
| `Write`/`Edit` to paths **outside** the project directory | `/tmp/`, other repos                          |

### Adding new Bash command prefixes

To allow a new command prefix, add `Bash(<command>:*)` to the `--allowed-tools`
array in `AgentSession.ts`. Only add commands that are safe for automated use.
**Never add**: `rm`, `sudo`, `curl`, `wget`, `docker`, `ssh`, `kill`.

---

## Querying Notion Databases

> **The Notion MCP search tool caps results at 25.** Use the script below
> instead when you need a complete task list from any Notion database.

```bash
node scripts/notion-query.mjs <database-id> --env packages/backend/.env [options]
```

| Flag                  | Purpose                   |
| --------------------- | ------------------------- |
| `--no-done`           | Exclude ✅ Done tasks     |
| `--status "🗂️ Ready"` | Filter to a single status |
| `--json`              | Raw JSON output           |

**Global location:** `~/.claude/scripts/notion-query.mjs` (symlink).
**Source:** `scripts/notion-query.mjs` in this repo.

## Moving Tasks Between Notion Databases

> **The Notion API does not support changing a page's parent.** Use the
> move script to copy pages to a target database and archive the originals.

```bash
node scripts/notion-move-tasks.mjs --target <database-id> --tasks <id1,id2,...> --env packages/backend/.env [options]
```

| Flag                    | Purpose                        |
| ----------------------- | ------------------------------ |
| `--dry-run`             | Preview without making changes |
| `--no-archive`          | Copy but keep the source page  |
| `--status "🔲 Backlog"` | Override status on moved tasks |

Failure handling: if the content copy step errors out (e.g. a Notion API
validation failure on a specific block type), the source page is **not**
archived. The new (empty) page in the target database is left in place and a
warning is logged so the move can be retried or completed manually. Table
blocks — which were the historical trigger for this failure mode — are now
copied with their `table_row` children intact.

**Global location:** `~/.claude/scripts/notion-move-tasks.mjs` (symlink).
**Source:** `scripts/notion-move-tasks.mjs` in this repo.

## Harness-Level Task-Status Gate (PreToolUse hook)

> Interactive sessions repeatedly violated the Task Writing Guidelines by
> creating Notion tasks directly at `🗂️ Ready`. A Claude Code `PreToolUse`
> hook now enforces the rule at the harness level — the session cannot
> disable or bypass it.

- **Hook config:** `~/.claude/settings.json` → `hooks.PreToolUse`, with
  matchers for `mcp__claude_ai_Notion__notion-create-pages` and
  `mcp__claude_ai_Notion__notion-update-page`.
- **Script:** `~/.claude/scripts/check-task-status.mjs` — **canonical
  location; deliberately NOT in this repo.** The hook is personal harness
  config that applies across all Notion-task projects on this host, not
  project tooling (unlike `notion-query.mjs` / `notion-move-tasks.mjs`).
  Edit it in place at the global path.
- **Behavior (v1 — create-only enforcement):** blocks any `notion-create-pages`
  call where a page's `Status` is set and ≠ `🔲 Backlog` (hook exits 2; stderr
  is fed back to the session so it can self-correct and re-issue at Backlog).
  `notion-update-page` calls are always allowed — promotion to Ready is
  trusted to the grooming process + operator-correction loop. The update-page
  matcher is pre-registered so update-side strictness can be added in the
  script later without touching settings.
- **Fail-open:** malformed/unparseable hook input exits 0, so non-task tool
  calls are never blocked.

---

## Stack

| Layer       | Tech                      | Path                                |
| ----------- | ------------------------- | ----------------------------------- |
| Frontend    | React + Vite (TS)         | `packages/frontend/`                |
| Backend     | Node.js + Express (TS)    | `packages/backend/`                 |
| Transport   | WebSocket (`ws`)          | `packages/backend/src/ws/types.ts`  |
| Database    | SQLite (`better-sqlite3`) | `packages/backend/src/db/schema.ts` |
| Task source | Notion REST API           | server-side only                    |

---

## Debug Session Mode

**Trigger phrase:** _"Let's launch a debug session for testing task [name/link]."_

When a human uses this phrase, enter debug session mode:

1. **Fetch the task page from Notion** using the link in the trigger phrase.
   If the fetch fails: stop and tell the human. Do not proceed.
2. Work directly in the **main working directory** — no worktree, no feature branch yet.
3. Make the fix.
4. **Restart the backend if you changed any backend files** (`packages/backend/`):
   kill and rerun `npm run dev` in the backend package. Frontend-only changes
   are picked up automatically by Vite HMR — no restart needed.
5. **Stop and wait.** Tell the human the fix is ready and prompt them to
   refresh the browser tab. Do not commit or open a PR.
6. Human verifies in the browser.
7. Repeat steps 3–6 until the human gives explicit sign-off (e.g. _"Looks good, ship it"_).
8. After sign-off: commit to `feature/<task-name>` and open a **draft PR
   targeting `dev`** — same as the standard workflow.

**Constraints:**

- No auto-PR. Always wait for explicit human sign-off.
- No worktree. Changes must be in the main working directory.
- One debug session = one task. No bundling unrelated fixes.

All other sessions use the standard workflow (feature branch + PR) as described
in the Notion Session Instructions fetched in Step 1.
