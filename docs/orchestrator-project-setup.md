# Orchestrator setup for external projects

The orchestrator can run sessions against any project on disk, not just this
repo. Out of the box it assumes a Node.js / TypeScript / Vite stack — TypeScript
type-checking, Vite build, Bash permissions for `npm`/`npx`/`node`. To point it
at a project that uses a different language or build tool (C#, Rust, Go, Godot,
Python, …), drop a config file at `<projectDir>/.claude/orchestrator.json` and
optionally a bootstrap script.

This guide covers:

1. The per-project config file (`orchestrator.json`).
2. The bootstrap script contract.
3. Updates to the project's own `CLAUDE.md`.
4. Structuring dev state as worktree-relative paths (personal-mode isolation).

---

## 1. Per-project config file

Create `<projectDir>/.claude/orchestrator.json`. The file is read fresh on
every session spawn — no backend restart needed when you edit it. If the file
is missing or unparseable, the orchestrator silently falls back to the Node.js
defaults.

### Schema

```json
{
  "allowedTools": ["Bash(dotnet:*)"],
  "prGate": {
    "typeCheck": "dotnet build /warnaserror",
    "build": "dotnet test"
  },
  "bootstrapScript": "scripts/bootstrap-worktree.sh",
  "bashRules": [
    "Use `dotnet` for builds, never `msbuild` directly.\n`msbuild` is not on PATH in our CI image. Always go through `dotnet build` / `dotnet test`."
  ]
}
```

All four keys are optional. Only override the ones that differ from the defaults.

### Field reference

| Key                | Default               | Purpose                                                                                                                                                                                                                                  |
| ------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedTools`     | `[]`                  | Extra `Bash(prefix:*)` patterns merged on top of the orchestrator's base allowlist (`git`, `npm`, `npx`, `node`, `tsc`, `gh`, `ls`, `cat`, …). Every other `Bash` prefix is silently denied.                                             |
| `prGate.typeCheck` | `npx tsc --noEmit`    | First command in the pre-PR gate, rendered into the session's injected `CLAUDE.md`.                                                                                                                                                      |
| `prGate.build`     | `npx vite build`      | Second command in the pre-PR gate.                                                                                                                                                                                                       |
| `bootstrapScript`  | _(none)_              | Path to a script run after worktree creation, before the session spawns. See section 2.                                                                                                                                                  |
| `bashRules`        | `npx` convention rule | List of strings that replace **Rule 5** onward in the orchestrator's Bash Rules section. Rules 1–4 (one command per call, no `cd path &&`, no heredoc subshells, no writes outside the worktree) are hardcoded and cannot be overridden. |

### `allowedTools` examples

| Stack       | Add to `allowedTools`                 |
| ----------- | ------------------------------------- |
| C# / .NET   | `["Bash(dotnet:*)"]`                  |
| Rust        | `["Bash(cargo:*)", "Bash(rustup:*)"]` |
| Go          | `["Bash(go:*)"]`                      |
| Python (uv) | `["Bash(uv:*)", "Bash(python:*)"]`    |
| Godot (C#)  | `["Bash(dotnet:*)", "Bash(godot:*)"]` |

These are **additive**. The base set already covers `git`, `gh`, `npm`, `npx`,
`node`, `tsc`, `cd`, `ls`, `cat`, `echo`, `mkdir`, `cp`, `mv`, `head`, `tail`,
`wc`, `find`, `grep`, `sort`, `pwd`, `which`, `where`, plus the Notion, GitHub,
Asana, and Calendar MCP tools — don't re-list them.

> **Note on Rules 1–4 vs `bashRules`.** The first four Bash rules in the
> orchestrator's injected `CLAUDE.md` are fixed: they describe how the
> permission system itself works (prefix matching on the first token, no
> chaining, no `cd && cmd`, no heredoc subshells, no writes outside the
> worktree). `bashRules` only replaces Rule 5+, which is project-specific
> guidance about which commands the session should prefer. The first line of
> each entry becomes the rule's bold heading; subsequent lines become the body
> paragraph.

### `prGate` example (.NET project)

```json
{
  "prGate": {
    "typeCheck": "dotnet build --configuration Release /warnaserror",
    "build": "dotnet test --configuration Release --no-build"
  }
}
```

The session is instructed to run these two commands, in order, before opening
the PR — same role `npx tsc --noEmit` and `npx vite build` play in this repo.

### `bashRules` example

```json
{
  "bashRules": [
    "Use `dotnet` for builds, never `msbuild` directly.\nThe build agent does not have `msbuild.exe` on PATH. Always go through `dotnet build` / `dotnet test`.",
    "Run integration tests with `dotnet test --filter Category=Integration`.\nUnit tests run by default; integration tests are gated behind the category filter."
  ]
}
```

Each string becomes one Bash rule numbered starting at 5. The orchestrator
splits on the first newline: line 1 is the rule heading (rendered bold), the
rest is the body paragraph.

---

## 2. Bootstrap script

Worktrees are created by `git worktree add`, which only checks out tracked
files. Anything gitignored (build outputs, restored packages, IDE caches,
generated assets) won't be present. The bootstrap script is your hook to
restore that state before the session starts.

### Contract

- **Path**: relative to the project root (the value of `bootstrapScript` is
  passed unchanged to `bash`).
- **Argument**: receives the **absolute worktree path as `$1`**.
- **`cwd`**: the **project root** (main repo), **not** the worktree. This means
  `git rev-parse --show-toplevel` resolves to the main repo, and you can
  read source files (e.g. gitignored `.env`, `.godot/`) directly from the main
  checkout.
- **Timeout**: 120 seconds. Anything slower will be killed.
- **Failure mode**: a non-zero exit is logged with `[SessionManager] bootstrap
script failed` but the session **still launches**. Treat the script as
  best-effort — make it idempotent and don't rely on it for correctness.

### What it should do

1. **Copy gitignored-but-required files** from the main repo into the worktree.
2. **Restore dependencies** inside the worktree (the worktree has its own
   working tree, so a dependency restore at the project root won't help it).
3. **Pre-build any generated assets** the build expects to find.

### Walkthrough — Godot / C# project

A Godot C# project has three categories of files the worktree won't have:
the `.godot/` cache (gitignored), restored NuGet packages, and the editor's
`.csproj`/`.sln` if those are gitignored in your setup.

`scripts/bootstrap-worktree.sh` in your project root:

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKTREE="$1"
PROJECT_ROOT="$(pwd)"

echo "[bootstrap] worktree=$WORKTREE root=$PROJECT_ROOT"

# 1. Copy the Godot import cache so the editor doesn't re-import every asset.
if [ -d "$PROJECT_ROOT/.godot" ]; then
  cp -R "$PROJECT_ROOT/.godot" "$WORKTREE/.godot"
fi

# 2. Copy any *.csproj / *.sln that are gitignored. Skip if they're tracked.
shopt -s nullglob
for f in "$PROJECT_ROOT"/*.csproj "$PROJECT_ROOT"/*.sln; do
  cp -n "$f" "$WORKTREE/" 2>/dev/null || true
done

# 3. Restore NuGet packages inside the worktree.
( cd "$WORKTREE" && dotnet restore )

echo "[bootstrap] done"
```

Make sure the script is executable (`chmod +x scripts/bootstrap-worktree.sh`)
and reference it from `orchestrator.json`:

```json
{
  "allowedTools": ["Bash(dotnet:*)", "Bash(godot:*)"],
  "prGate": {
    "typeCheck": "dotnet build /warnaserror",
    "build": "dotnet test"
  },
  "bootstrapScript": "scripts/bootstrap-worktree.sh"
}
```

### Tips

- **Be idempotent.** The script may run on a freshly-created worktree, but a
  failed-and-retried session can hand it the same path twice. Use `cp -n`,
  guard `mkdir`s, and don't assume a clean target.
- **Don't write to the project root.** The script's `cwd` is the main repo.
  Anything you write there will end up in the developer's checkout. Always
  scope writes to `$WORKTREE`.
- **Keep it under two minutes.** Anything slow (e.g. full `npm ci` on a large
  monorepo) should be cached or moved to a one-off setup step the developer
  runs manually.

---

## 3. Project `CLAUDE.md` updates

The orchestrator injects its own rules into the session's `CLAUDE.md` (task
assignment, lifecycle, PR format, branch rules, pre-PR gate, forbidden
actions, git isolation, Bash rules) and appends your project's `CLAUDE.md`
content underneath. Your project's `CLAUDE.md` is read by **two audiences**:

1. **Orchestrator-launched sessions** — they already see the injected rules
   above, plus a "Task Spec" section pre-fetched from Notion or `tasks.yaml`.
2. **Direct `claude` CLI sessions** (developer running `claude` from the
   project root) — they don't see any orchestrator injection.

To keep both audiences happy, structure the project `CLAUDE.md` like this
repo's `CLAUDE.md` and **mark Step 1 (bootstrap / context fetch) as skipped
under orchestrator control**. The orchestrator pre-fetches everything Step 1
would do.

### Recommended structure (mirrors this repo)

```markdown
# <Project name> — session bootstrap

> ⚠️ **Step 1 — Fetch project context**
>
> When run **directly** by `claude`, your first action is to read
> `.claude/local-context.md` and fetch the project context page from Notion.
>
> When run **under orchestrator control**, skip Step 1 entirely. The
> orchestrator pre-fetches the task spec and injects it into the `## Task Spec`
> section above. Proceed straight to implementation.

---

## Step 2 — Implement the task

…

## Rules

|                     |                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source of truth** | Notion (or `tasks.yaml` for YAML projects)                                                                                                                 |
| **Scope**           | One task per session. No scope creep.                                                                                                                      |
| **Branch naming**   | `feature/<task-name>` from `dev`                                                                                                                           |
| **When done**       | Open draft PR → stop and wait. The dashboard sends review feedback as follow-up messages; address findings by pushing additional commits, then wait again. |
| **Pre-PR gate**     | <your typeCheck>, <your build>                                                                                                                             |

## PR Format

…

## Git isolation

…

## Task Lifecycle

…

## Tool Permissions

…

## Bash Rules

…

## Stack

…

## Debug Mode

…
```

The exact section names should mirror this repo's `CLAUDE.md` so a developer
moving between projects sees a consistent shape.

### Why Step 1 is skipped under orchestrator control

The orchestrator already:

- Fetches the Notion task page (or reads `tasks.yaml`) and injects the full
  task spec into the worktree's `CLAUDE.md` under `## Task Spec`.
- Appends the contents of `<projectDir>/.claude/local-context.md` under
  `## Local Context` (so host-local URLs and IDs are still available).
- Records the target branch, project context URL, and worktree path in the
  injected rules.

A session that re-fetches all of this just burns tokens for no gain. The
orchestrator's injected rules explicitly tell the session: "Task spec is
pre-loaded below. Do NOT fetch Notion pages."

---

## 4. Worktree-relative dev state (personal-mode isolation)

In personal mode, each session runs in a git worktree under
`.claude/worktrees/<session-id>/`. There is no structural sandbox (no docker,
no chroot), so a session can write to any path it has filesystem access to —
including the project root. The orchestrator's only lever is prompt-level
guidance (the Filesystem Isolation section injected into every session's
`CLAUDE.md`).

To minimise the risk of a session corrupting your live environment, **structure
project dev state as worktree-relative paths rather than project-root paths**.
Each session then gets its own isolated state and cannot accidentally overwrite
the developer's checkout.

### What counts as "dev state"

- SQLite databases used for local development or manual verification
- Log files and debug output
- Generated artifacts (seed data, migration outputs, exported files)
- Any writable runtime state the session needs to satisfy acceptance criteria

### Recommended pattern

Give each piece of dev state a configurable path and default it to a
worktree-relative location. The session already knows its worktree path via the
`cwd` it was spawned in.

**Python example — SQLite dev database:**

```python
import os, pathlib

# Resolve DB path from env var, defaulting to worktree-local .dev-state/
_worktree = pathlib.Path(os.environ.get("WORKTREE_DIR", pathlib.Path.cwd()))
DB_PATH = pathlib.Path(os.environ.get("DEV_DB", _worktree / ".dev-state" / "dev.db"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
```

**Node.js / TypeScript example:**

```typescript
import path from 'path';

const worktree = process.env.WORKTREE_DIR ?? process.cwd();
const dbPath = process.env.DEV_DB ?? path.join(worktree, '.dev-state', 'dev.db');
```

**Shell script example (bootstrap or verify script):**

```bash
WORKTREE="${WORKTREE_DIR:-$(pwd)}"
DEV_DB="${DEV_DB:-$WORKTREE/.dev-state/dev.db}"
mkdir -p "$(dirname "$DEV_DB")"
```

### Why not just use `process.cwd()` everywhere?

When a session runs inside the worktree, `cwd` is already the worktree root —
so relative paths like `./dev.db` or `.dev-state/dev.db` are naturally
worktree-scoped. The problem arises when code constructs **absolute** paths
from compile-time constants (`__dirname`, `import.meta.url`, project-root
references baked in at build time) or receives an absolute path from a config
file that points at the main repo. Use an env var override so the path can be
redirected to the worktree at runtime without editing source files.

### `.gitignore` recommendation

Add `.dev-state/` to your project's `.gitignore` so session databases and
generated files are never accidentally committed:

```
# Session-local dev state (worktree-scoped)
.dev-state/
```

### What this does NOT solve

- **Real-time blocking**: the orchestrator cannot intercept a write mid-flight
  in personal mode. The prompt-level rule reduces the likelihood; it does not
  make it impossible.
- **Existing project configurations**: this recommendation applies going
  forward. Backfilling is out of scope (see the post-hoc audit task).
- **Docker / corporate mode**: docker sessions have structural isolation.
  This section only applies when personal mode is in use.

---

## Verifying your setup

After dropping `orchestrator.json` and (optionally) the bootstrap script in
place:

1. **Spawn a session for the project from the dashboard.** The backend reads
   the config fresh each time — no restart needed.
2. **Watch the backend logs.** You should see:
   - `[SessionManager] worktree created: …`
   - `[SessionManager] bootstrap script completed for <session-id>` (if
     configured), or a `bootstrap script failed for <session-id> (continuing)`
     warning if it exited non-zero.
   - `[SessionManager] orchestrator CLAUDE.md written to worktree …`
3. **Open the worktree's `CLAUDE.md`.** Confirm:
   - The `## Pre-PR Gate` section lists your custom `prGate.typeCheck` and
     `prGate.build` commands.
   - Any `bashRules` entries appear as `**Rule 5 — …**`, `**Rule 6 — …**`,
     etc., after the four hardcoded rules.
4. **Inspect the spawned process's `--allowed-tools`.** Your `allowedTools`
   patterns should be appended to the base list. Any Bash command whose first
   token isn't covered will be silently denied (visible in the session's
   `permission_denials` events).

> **Debugging silently-denied Bash commands.** When a session attempts a Bash
> command whose first token isn't in the merged allowlist, the CLI denies it
> silently and emits a `permission_denials` entry on the session's `result`
> event. Surface those in the dashboard's session detail view (the permission
> panel) — they're the fastest path from "why isn't this command running?"
> to the missing `allowedTools` pattern. See [`architecture.md`](architecture.md#permissionengine)
> for the full permission-evaluation order.

If a session fails at the pre-PR gate, the most common culprits are:

- A `Bash(<prefix>:*)` pattern missing from `allowedTools` (silent denial).
- A bootstrap script failure that left the worktree without restored
  dependencies (visible in backend logs).
- A `prGate` command that assumes a tool not on PATH — wrap with `npx` (Node.js)
  or use a stack-specific runner (`dotnet`, `cargo`, `uv run`).
