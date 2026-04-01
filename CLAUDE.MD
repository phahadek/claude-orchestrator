# Claude Code Dashboard — session bootstrap

> ⚠️ **Read this before anything else.**
> - If the opening message contains "Let's launch a debug session for testing task [name/link]" → skip directly to ## Debug Session Mode below.
> - If the Notion fetch in Step 1 fails → **stop immediately and tell the human**.
> - Do not attempt to infer rules from code, git history, or any other source.
> - The session cannot proceed without Notion context.

---

## Step 1 — Fetch project context first — always

Before doing anything else, fetch this page:

https://www.notion.so/REDACTED

It contains the master context, session instructions, active task board link,
and the full file index. **If the fetch fails: stop and tell the human. Do not proceed.**

## Step 2 — Fetch the active task board

The Project Context page contains a link to the active task board under
"Active Task Board". Fetch it and filter to tasks with Status = 🔄 In Progress
or 🗂️ Ready. Work only on the task you have been assigned.

## Step 3 — Fetch child pages only when your task needs them

- Product Design Doc: https://www.notion.so/REDACTED
- Technical Architecture: https://www.notion.so/REDACTED
- Dev Setup & Git / Coding Guidelines: see Master File Index on the context page.

---

## Rules

| | |
|---|---|
| **Source of truth** | Notion — never infer rules from code or git history |
| **Scope** | One task per session. No scope creep. |
| **Branch naming** | `feature/<task-name>` from `dev` |
| **Commit to `dev` or `main` directly?** | Never |
| **When done** | Open draft PR → mark task 👀 In Review → stop. Human merges and marks ✅ Done. |
| **Pre-PR gate (hard — in order)** | 1. Merge/rebase `dev` → resolve conflicts. 2. `tsc --noEmit` passes (both packages). 3. `vite build` passes. |

### Task Lifecycle — follow this end-to-end, every session

1. **Move task to `🔄 In Progress`** in Notion as soon as you begin work.
2. **Create a feature branch from `dev`** — named `feature/<task-name>`.
3. **Implement the task** per the acceptance criteria in the Notion task page.
4. **Pass the pre-PR gate** (rebase onto `dev`, `tsc --noEmit`, `vite build`).
5. **Open a draft PR targeting `dev`** — include the Notion task URL in the PR body.
6. **Move task to `👀 In Review`** in Notion.
7. **Stop.** Never merge your own PR. Never move the task to `✅ Done`. Wait for the human.

> ⚠️ Steps 6 and 7 are hard stops. The human merges the PR and marks the task Done.
> Appending to the Session Log and updating the Master File Index are also the human's responsibility after merge.

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

### Auto-accepted (will execute without prompting)

| Tool | Why |
|---|---|
| `Read`, `Glob`, `Grep`, `ToolSearch` | Read-only, always safe |
| `Edit`, `Write` | `acceptEdits` mode auto-approves in-project file operations |
| `Bash` (read-only: `ls`, `cat`, `head`, etc.) | `acceptEdits` auto-approves read-only Bash |
| `Bash(git:*)` | Explicitly in `--allowed-tools` — all git operations |
| `Bash(npm:*)`, `Bash(npx:*)`, `Bash(node:*)` | Explicitly in `--allowed-tools` — Node.js tooling |
| `Bash(gh:*)` | Explicitly in `--allowed-tools` — GitHub CLI |
| `Bash(ls:*)`, `Bash(cat:*)`, `Bash(mkdir:*)`, etc. | Explicitly in `--allowed-tools` — common file ops |
| `TodoWrite`, `Skill`, `EnterPlanMode`, `ExitPlanMode` | Session management tools |
| `mcp__claude_ai_Notion__*` | Explicitly in `--allowed-tools` |
| `mcp__github__*` | Explicitly in `--allowed-tools` |
| `mcp__claude_ai_Asana__*`, `mcp__claude_ai_Google_Calendar__*` | Explicitly in `--allowed-tools` |

### Auto-denied (will fail silently — session sees "permission denied" in tool result)

| Tool | Example |
|---|---|
| `Bash` with non-allowlisted prefix | `curl`, `wget`, `rm`, `sudo`, `docker`, `ssh` |
| Any tool not listed above | Custom MCP tools, `Agent`, etc. |
| `Write`/`Edit` to paths **outside** the project directory | `/tmp/`, other repos |

### Adding new Bash command prefixes

To allow a new command prefix, add `Bash(<command>:*)` to the `--allowed-tools`
array in `AgentSession.ts`. Only add commands that are safe for automated use.
**Never add**: `rm`, `sudo`, `curl`, `wget`, `docker`, `ssh`, `kill`.

---

## Stack

| Layer | Tech | Path |
|---|---|---|
| Frontend | React + Vite (TS) | `packages/frontend/` |
| Backend | Node.js + Express (TS) | `packages/backend/` |
| Transport | WebSocket (`ws`) | `packages/backend/src/ws/types.ts` |
| Database | SQLite (`better-sqlite3`) | `packages/backend/src/db/schema.ts` |
| Task source | Notion REST API | server-side only |

---

## Debug Session Mode

**Trigger phrase:** *"Let's launch a debug session for testing task [name/link]."*

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
7. Repeat steps 3–6 until the human gives explicit sign-off (e.g. *"Looks good, ship it"*).
8. After sign-off: commit to `feature/<task-name>` and open a **draft PR
   targeting `dev`** — same as the standard workflow.

**Constraints:**
- No auto-PR. Always wait for explicit human sign-off.
- No worktree. Changes must be in the main working directory.
- One debug session = one task. No bundling unrelated fixes.

All other sessions use the standard workflow (feature branch + PR) as described
in the Notion Session Instructions fetched in Step 1.
