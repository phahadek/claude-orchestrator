# Orchestrator — Universal Procedures (TEMPLATE)

> **This is a template.** Copy it to your central config tree as `procedures.md`
> (the deploy script seeds it there if absent — see `config-template/README.md`),
> then fill in the **Project index** below. Everything else is project-agnostic and
> can be kept as-is.
>
> **What this file is.** The single, project-agnostic procedure + workflow rulebook
> for every project the orchestrator manages. A **SessionStart hook**
> (`config/hooks/load-procedures.mjs`, registered in `~/.claude/settings.json`) directs
> every projects-root session to `Read` this file at session start — the human-driven
> Remote Control server only, never automated/worktree sessions. (The hook injects a
> short pointer rather than the file body, which is too large for the SessionStart
> context cap.) It contains only what reads **identically for every project** — the
> universal "bucket-1" rules.
>
> Anything project-specific lives in one of two other homes (see below). **Do not**
> put project-specific values here.

---

## Config has three homes

| Home                                            | Holds                                                                                                                     | Loaded                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **`config/procedures.md`** (this file)          | Universal workflow + procedure rules                                                                                      | SessionStart hook (projects-root sessions)                           |
| **`<repo>/.claude-orchestrator.yml`** (in-repo) | Per-project toolchain: verify/build/test commands, packages                                                               | Orchestrator reads it per session                                    |
| **`config/projects/<dir>/context.md`**          | Per-project context: task-source URLs, active milestone, board IDs, stack, deploy + debug-restart specifics, PR mechanism | **On demand** — you `Read` it when you start working on that project |

There is intentionally **no in-repo `CLAUDE.md`** and **no `.claude/local-context.md`**.
Project context is delivered centrally (this tree), never from inside the repo. A repo
having no `CLAUDE.md` is expected and safe — the orchestrator's `ContextBuilder` reads
a project `CLAUDE.md` only if one exists.

---

## Project index

> **Fill this in per deployment.** One row per managed repo; `Config dir` is the repo
> basename (and the directory under `config/projects/`). To work on a project, **first
> `Read config/projects/<dir>/context.md`** — it carries that project's task-source
> entry point and per-project specifics. Then follow the session flow below.

| Project          | Config dir   | One-liner                                |
| ---------------- | ------------ | ---------------------------------------- |
| _<Project name>_ | `<repo-dir>` | _<one-line description: stack, purpose>_ |

> To work on `<X>`: `Read config/projects/<X>/context.md` first, then proceed.

---

## Session flow — every session, in order

1. **Identify the project and load its context.** `Read config/projects/<dir>/context.md`.
2. **Fetch the project's master context page** named in that `context.md`. It holds the
   master context, session instructions, active task board link, and file index.
   **If the fetch fails: stop and tell the human. Do not proceed.**
3. **Fetch the active task board** (linked from the master context page). Filter to
   `In Progress` or `Ready`. Work only on the task you have been assigned.
4. **Fetch child pages only when the task needs them** (Product/Game Design, Technical
   Architecture, Coding Guidelines, Dev Setup) — URLs are in the project's `context.md`
   or the master context page. Don't pre-fetch.

> If the session is **orchestrator-launched** (automated), bootstrap is handled by the
> backend — these steps are injected for you; follow the task you were dispatched.

---

## Rules

|                                         |                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source of truth**                     | The task source (Notion / GitHub / Jira / YAML) for architectural rules, design decisions, and task definitions — never infer these from code or git history. (Per-project carve-outs for code-authoritative detail, where they exist, are noted in that project's `context.md`.) |
| **Scope**                               | One task per session. No scope creep.                                                                                                                                                                                                                                             |
| **Branch naming**                       | `feature/<task-name>` from `dev`                                                                                                                                                                                                                                                  |
| **Commit to `dev` or `main` directly?** | Never                                                                                                                                                                                                                                                                             |
| **When done**                           | Open draft PR → mark task `In Review` → stop. Human merges and marks `Done`.                                                                                                                                                                                                      |
| **Pre-PR gate**                         | 1. Rebase/merge `dev` → resolve conflicts. 2. Run the project's verify command (from its `.claude-orchestrator.yml` / `context.md`). Formatting/linting that the orchestrator autofixes after PR open is not a session gate step.                                                 |
| **Session Log / File Index updates**    | Never (orchestrator-managed) unless a project's `context.md` says otherwise.                                                                                                                                                                                                      |

---

## Git isolation — critical

**All git commands must run inside the worktree directory (`cwd` = worktree path).**
Never use `--work-tree`, `--git-dir`, or any absolute-path flag that points **outside**
your worktree. Never run `git checkout`, `git switch`, or `git reset` targeting a branch
that lives in the **main** repository directory. The backend records the main repo's
branch before each session and will warn (and restore) if it drifts — but preventing
drift is your responsibility.

> `git -C <path>` is acceptable **only** when `<path>` is your own worktree. Never point
> `git -C` at the main checkout or another repo. In a normal session you are already in
> the worktree, so just run `git ...` directly.

---

## Hard rule — a managed session's git / PR / worktree is out of bounds

> Applies to **every investigation / remote-control / operator session** working *on or
> against* the Orchestrator (or any project it manages). This is separate from the worktree
> git-isolation rule above: there you are a coding session inside your own worktree; here you
> are observing **other** sessions' territory from the outside.

The branches, commits, worktrees, and pull requests of the Orchestrator's managed
coding/review sessions are **never yours to change** — they belong exclusively to the session
that owns them. Investigation is **read-only** over that state: observe, diagnose, report.

**Never — under any circumstances, not to "help", not to finish obviously-complete work, not
to unstick a session, not even after a read-only check seems to make it safe:**

- `git push`, `gh pr create` / `gh pr merge`, or create / update / merge / close any managed PR;
- commit, amend, reset, rebase, `checkout` / `switch`, stash, or edit files inside a session
  worktree (`…/.claude/worktrees/…`);
- hand-edit or "repair" a managed repo's git metadata (`.git/config`, refs, index, `HEAD`);
- hand-mutate Orchestrator state (DB rows, pause flags, branches) to force a PR or session to
  a different outcome.

These actions can be **catastrophic and irreversible** — corrupting branches, silently losing
committed work, or breaking every future resume of a worktree — in ways you cannot foresee from
the outside. Deliver fixes **only** as code changes to the Orchestrator's own source through the
normal task → PR flow, or surface them to the human. Orchestrator-native, explicitly
human-authorized API actions (e.g. triggering a review via its own endpoint) are the human's
call to make, never yours to initiate. **Do not even propose** doing any of the above.

---

## Task lifecycle — end-to-end, every session

1. **Move task to `In Progress`** in the task source as soon as you begin work.
2. **Create a feature branch from `dev`** — `feature/<task-name>` — inside the worktree
   (`git switch -c feature/<name> dev`).
3. **Implement the task** per the acceptance criteria on the task page.
4. **Pass the pre-PR gate** (rebase onto `dev`, run the project's verify command).
5. **Open a draft PR targeting `dev`** — use the required body template below.
6. **Move task to `In Review`** in the task source.
7. **Stop.** Never merge your own PR. Never move the task to `Done`. Wait for the human.

> ⚠️ Steps 6 and 7 are hard stops. The human merges the PR and marks the task Done.
> Appending to the Session Log and updating the Master File Index are the human's job.

### Status values

| Status | Meaning |
| --- | --- |
| `🔲 Backlog` | Defined, not yet validated. Default for every new task. |
| `🗂️ Ready` | Scoped, reviewed, ready to pick up. For 💻 Code this is what auto-dispatches it. |
| `🔄 In Progress` | Actively being worked. |
| `👀 In Review` | PR open (Code) / changes proposed (Design), awaiting the human. |
| `✅ Done` | Merged + verified (Code) / pages locked (Design). |
| `⏭️ Deferred` | Scope superseded by another task. Treated like Done by `/groom` + `/design`. |
| `🚫 Blocked` | Rare. Set by the **orchestrator** when a task can't be implemented as-is; the blocker is documented in Notes. Not a grooming target — which is why the machine `status_vocab` in `grooming.json` omits it (grooming and auto-dispatch never set it). |

---

## PR format

- **Title:** `feat: <exact task name>` — no scope prefix beyond `feat:`, no milestone tag.
- **How to open it:** `gh pr create --draft --base dev --body-file <file>`. **If `gh` is not
  on PATH** for this project (some hosts don't ship it), use the `mcp__github__create_pull_request`
  MCP tool with `draft: true`, `base: "dev"`, and the full body as `body`. The project's
  `context.md` notes which mechanism that repo uses.
- **Body:** must use the exact template below — no omissions, no reordering.

### Required PR body template

```markdown
## Summary

<1-3 sentences: what changed and why>

## Task

<link to the task page>

## Automated Tests

<list tests added/modified, or "No test changes">

## Files Changed

<bulleted list of files with brief description of each change>
```

---

## Tool permissions (orchestrator-launched sessions)

Dashboard-launched sessions spawn `claude --print` with `--permission-mode acceptEdits`.
This governs what the CLI auto-accepts/denies. **There is no mid-session approval
mechanism** — `claude --print` does not support interactive permission prompts.

**The model:** `acceptEdits` auto-approves read-only Bash (`git status`, `ls`, …) and
in-project `Edit`/`Write`. **Write** Bash commands (`git commit`, dependency installs, …)
require explicit `--allowed-tools` entries. `Bash(prefix:*)` matches **only the first
token** of the command, so compound commands are silently denied even when each prefix is
individually allowed. Unmatched Bash is denied silently (no prompt, no error — just a
`permission_denials` entry in the `result` event).

### Bash command formatting rules (MUST follow)

**Rule 1 — One command per Bash call.** Never chain with `&&` or `;`. A chained command's
prefix is the first token (often `cd`), so the rest can't be authorized. Split into
separate Bash calls.

**Rule 2 — Never prefix with `cd <path> &&`.** You are already in the worktree — run the
command directly. If a tool genuinely needs a path, use its own path flag pointing at the
worktree (`git -C <worktree>`, `npm --prefix <worktree>`, `uv --project <worktree>`), never
a `cd`.

**Rule 3 — Invoke project tools through their wrapper, never bare.** Use the project's
documented invocation (e.g. `npx tsc`, `uv run pytest`, `dotnet build`) — see the project's
`context.md` / `.claude-orchestrator.yml`. Bare tool names (`tsc`, `ruff`, `pytest`) are
not guaranteed on PATH.

**Rule 4 — Avoid pipes (`|`) with write commands.** Pipes can interfere with prefix
matching. Keep write commands simple; let the Bash tool handle output truncation.

**Rule 5 — Don't write files via shell redirects.** No `cat >`, `printf >`, `echo >`, or
heredoc subshells (incl. `git commit -m "$(cat <<'EOF' …)"`). Use the `Write` tool for file
creation; for multiline commit messages use `git commit -F <file>` after writing the file.
Never write outside the worktree (`/tmp/`, other repos).

### Adding a new Bash prefix

To allow a new command prefix, add `Bash(<command>:*)` to the `--allowed-tools` array in
the backend (`AgentSession.ts`). Only add commands safe for automated use.
**Never add:** `rm`, `sudo`, `curl`, `wget`, `docker`, `ssh`, `kill`.

---

## Task-source access — scripts first, MCP for the rest

For anything that **reads or enumerates** a task database (task boards, lookup tables,
anything tabular), use the REST scripts in `~/.claude/scripts/`. They paginate fully and
never truncate. An MCP search tool typically caps results and silently drops the rest —
never use it for full board enumeration.

Use the task-source MCP only for what the scripts don't cover:

- fetch one page's full content;
- update a page's properties/content;
- create pages.

The task-source API key (e.g. `NOTION_API_KEY`) lives in the dashboard backend `.env`. The
same key works across this user's projects — pass it via `--env` (path recorded in each
project's `grooming.json` / `context.md`).

```bash
# Enumerate a board / database
node ~/.claude/scripts/notion-query.mjs <database-id> --env <path-to>/.env [--no-done] [--status "Ready"] [--json]

# Move pages between databases (API can't reparent; this copies + archives)
node ~/.claude/scripts/notion-move-tasks.mjs --target <db-id> --tasks <id1,id2> --env <path-to>/.env [--dry-run] [--no-archive] [--status "Backlog"]
```

> **Dependency-field convention.** The `Depends On` property on task boards is a **Rich
> Text** field holding pipe-delimited page IDs (`id1|id2|id3`). To update deps, write the
> full pipe-delimited string. Never use a relation for `Depends On` — the MCP cannot
> write multi-value relations.

---

## Debug session mode

**Trigger phrase:** _"Let's launch a debug session for testing task [name/link]."_

1. **Fetch the task page from the task source.** If the fetch fails: stop and tell the human.
2. Work directly in the **main working directory** — no worktree, no feature branch yet.
3. Make the fix.
4. **Restart whatever long-running process you changed** — the specifics (which dev server,
   whether HMR auto-reloads, etc.) are in the project's `context.md`.
5. **Stop and wait.** Tell the human the fix is ready and what to re-exercise. Do not commit
   or open a PR.
6. Human verifies.
7. Repeat 3–6 until explicit human sign-off (e.g. _"Looks good, ship it"_).
8. After sign-off: commit to `feature/<task-name>` and open a **draft PR targeting `dev`** —
   same as the standard workflow.

**Constraints:** no auto-PR (always wait for sign-off); no worktree (main working dir so the
running process sees changes); one debug session = one task, no bundling.

---

## Memory policy

**Never write to the per-Claude-Code memory system.** Work happens across many separate
processes (orchestrator-launched coding sessions, review sessions, the remote-control) that
cannot see one instance's memory. Durable context must live in one of:

- **This `procedures.md`** (universal rules) or a project's **`context.md`** (per-project).
- The **task-source docs** linked from each project's `context.md` (source of truth for
  cross-session rules).
- The **review-session `CLAUDE.md` template** in the orchestrator repo
  (`packages/backend/src/session/orchestrator-claudemd.ts`) for rules that must reach
  orchestrator-launched review sessions specifically.
- The **code itself** (anything verifiable by reading current source).

If asked to "remember" something, save it to one of the above — never to memory. If it's
not obvious which, ask the human.

---

## Task authoring

When you author or update a task — in a `/groom` or `/design` session, or in any
remote-control / planning / debug session that ends up filing one — the **shape of the
task body** follows one universal standard: **`config/task-writing.md`**. Read it at the
moment you author (it is reference content, not a skim-once summary); it defines the
required sections, the 🤖/👁️ acceptance-criteria split, the readiness gate, and the
Manual Verification Gate pattern. Project-specific authoring slivers live in that
project's `context.md`.

Must-know rules even if you don't open the full standard:

- **New tasks always start at `🔲 Backlog`** — never create one directly at Ready; only
  a human review promotes to Ready. (Enforced by the `check-task-status.mjs` PreToolUse
  hook.)
- **Draft in conversation first; publishing to the task source is a separate,
  human-approved step.** "Write a task" authorizes the intent, not the draft.
- **The page body is the spec; Notes is one human-facing sentence.**

---

## Task types — what 🗂️ Ready triggers, per type

Every task carries a **Type**. The Type decides **what picks the task up once it is
🗂️ Ready** — the single most-confused point across sessions, so it is stated here once,
authoritatively.

| Type                            | Brought to Ready by                    | Who executes it once Ready                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 💻 **Code**                     | `/groom`                               | **The orchestrator auto-dispatches it** — unattended, in a fresh worktree — the moment it is 🗂️ Ready with **no unsatisfied dependency** (every `Depends On` task is ✅ Done / 🗂️ Ready / ⏭️ Deferred). No human kicks it off. |
| 📐 **Design** / 📋 **Planning** | already Ready/In-Progress, or `/groom` | **`/design`, interactively.** The orchestrator does **not** auto-dispatch these — they wait for a human to run a Design Execution session.                                                                                     |
| 🛠️ **Tooling** / 🧪 **Testing** | `/groom`                               | **A session, interactively** (a human runs it). Not auto-dispatched. May or may not end in a PR.                                                                                                                               |
| 🚦 **Gate** | `/groom` (kept at Ready) | The milestone's **Manual Verification Gate** — a human runs it once, at the end of the milestone. Never auto-dispatched. Unlike ordinary tasks it **accretes**: `/groom` appends each code task's stripped manual-verification items to it while it rests at 🗂️ Ready (the Gate type's defined behavior, not a modify-a-Ready-task exception). |
| 📝 **Docs** / 🎨 **Assets**     | `/groom`                               | Interactively. Not auto-dispatched.                                                                                                                                                                                            |

Two consequences every session must internalize:

- **Marking a 💻 Code task Ready is a live action, not a paper approval.** It _launches_
  the work unattended. A wrong `Depends On` or an unresolved open question becomes a
  broken worktree session, not a review comment. This is why `/groom` gates the Ready
  flip so hard (sign-off + classified hard-block deps + size check).
- **A 🛠️ Tooling / 🧪 Testing task must not smuggle dispatchable code.** If part of the
  task is "write module/script X" with **no dependency on data only available at
  implementation time**, that part is a 💻 **Code** task — **excise it into a separate
  Code task** so it flows through the normal auto-dispatch path. Keep the Tooling/Testing
  task scoped to the interactive, judgment-bound remainder (running it, wiring it,
  observing results). The same rule applies when `/design` or `/groom` files a follow-on:
  pure code-generation → Code type; interactive/observational → Tooling/Testing.

---

## Grooming & design sessions

Two structured session types run against a milestone's task board; both are deterministic
skills with a per-repo manifest (`config/projects/<dir>/grooming.json`).

- **Backlog Grooming** — bring `Backlog` tasks to `Ready`. Trigger: _"Let's groom
  milestone X"_ / _"groom"_. Procedure lives in the **`/groom` skill**; the readiness bar
  it enforces lives in **`config/task-writing.md`**. (No task-source procedure page — both
  were retired into local logic.)
- **Design Execution** — work the open questions on `Design` / `Planning` tasks, lock
  decisions, update architecture pages, file follow-on `Backlog` Code tasks. Trigger:
  _"Let's run a design session for milestone X"_ / _"design"_.

Both load full project context via their loaders and require the project's grooming manifest.
Run only on the project whose milestone you were asked to groom/design.
