# `.claude-orchestrator.yml` Configuration Reference

Place this file at the **project root** (not inside `.claude/`) to configure how the orchestrator handles sessions for that project.

The file is read fresh on each session spawn and at PR-open time — no server restart is needed to pick up changes.

## Schema

```yaml
# Commands the orchestrator runs in the worktree before opening the PR.
# Mechanical fixes only (formatters, lint --fix). Failures are logged but do not block.
autofix:
  - npm run format:write
  - npm run lint:fix

# Commands the session is instructed to run before opening the PR.
# Injected into the orchestrator-generated CLAUDE.md Pre-PR Gate section.
# May be empty if the project relies entirely on CI.
verify:
  - npx tsc --noEmit
  - npm run build

# GitHub check-run names treated as authoritative for pass/fail.
# Empty list = all checks count (current behavior).
ci_check_name:
  - build

# Extra claude CLI tool-permission patterns merged with the base allowed-tools
# set and passed straight through to `claude --allowed-tools`. Any pattern the
# CLI itself understands is valid here, not just `Bash(...)` — e.g.
# `WebFetch(domain:example.com)` to scope network fetches to one host.
allowed_tools: []

# Bash rules (Rule 5+). Each item is the full rule text.
# The first line becomes the bold heading; subsequent lines become the body.
bash_rules: []

# Per-project coding-session guidance. Rendered as its own "## Project Rules"
# section in the coding-session CLAUDE.md — separate from bash_rules.
session_rules: []

# Per-project review-session enforcement criteria. Rendered as a
# "## Project Review Criteria" section in the review-session CLAUDE.md.
# The reviewer may set "escalate": true in its verdict when these criteria
# indicate the PR needs operator attention instead of another coding-session
# iteration (routes to review_escalated instead of needs_changes feedback).
review_rules: []

# Path to a script run after worktree creation, relative to the project root.
# The script receives the worktree path as $1.
bootstrap_script: ''

# Lockfile path(s), relative to project root, that key the dependency-cache
# fast-path lookup hash for the governed test lane's per-session worktree
# bootstrap. Opt-in: empty list = dependency-cache pooling off.
dependency_lock_paths: []

# Untracked directories, relative to project root, that bootstrap_script
# populates and that should be cached/restored across sessions. May list
# more than one entry in a workspace layout. Opt-in: empty list = off.
dependency_cache_dirs: []

# Project-authored command that exits zero iff the currently-materialized
# dependency_cache_dirs content satisfies the current lockfile(s), non-zero
# otherwise. Treated as the correctness gate on every cache hit — a failure
# is treated exactly like a cache miss. Opt-in: empty string = off.
dependency_verify_command: ''
```

## Fields

| Field              | Type       | Default | Description                                                                                                                                                                                            |
| ------------------ | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `autofix`          | `string[]` | `[]`    | Commands run by the orchestrator before the PR is opened. Failures are logged but do not block.                                                                                                        |
| `verify`           | `string[]` | `[]`    | Commands injected into the CLAUDE.md Pre-PR Gate section. The session is instructed to run these before opening a PR.                                                                                  |
| `ci_check_name`    | `string[]` | `[]`    | GitHub check-run names the orchestrator treats as authoritative. Empty = all checks count.                                                                                                             |
| `allowed_tools`    | `string[]` | `[]`    | Extra `claude` CLI tool-permission patterns (e.g. `Bash(dotnet:*)`, `WebFetch(domain:example.com)`) added on top of the base set. Accepts any pattern shape the CLI understands, not just `Bash(...)`. |
| `bash_rules`       | `string[]` | `[]`    | Replacement Bash rules (Rule 5+) injected into CLAUDE.md. Each string's first line is the heading.                                                                                                     |
| `session_rules`    | `string[]` | `[]`    | Per-project coding-session guidance, rendered as a "## Project Rules" section (distinct from `bash_rules`).                                                                                            |
| `review_rules`     | `string[]` | `[]`    | Per-project review-session enforcement criteria, rendered into the review-session prompt. Can drive `escalate` verdicts.                                                                               |
| `bootstrap_script` | `string`   | `""`    | Relative path to a script executed after worktree creation. Receives the worktree path as `$1`.                                                                                                        |
| `dependency_lock_paths` | `string[]` | `[]` | Lockfile path(s) that key the dependency-cache fast-path lookup hash. Opt-in: empty = dependency-cache pooling off.                                                                                     |
| `dependency_cache_dirs` | `string[]` | `[]` | Untracked directories `bootstrap_script` populates that should be cached/restored across sessions. Opt-in: empty = off.                                                                                 |
| `dependency_verify_command` | `string` | `""` | Command that exits zero iff the materialized `dependency_cache_dirs` satisfy the current lockfile(s); treated as the correctness gate on every cache hit. Opt-in: empty = off.                          |

All fields are optional. Missing fields fall back to their defaults — a partial config is valid.

## How `allowed_tools` is enforced

Every orchestrator-spawned session runs the `claude` CLI with `--print`, passing
the merged base + `allowed_tools` set via `--allowed-tools`. Print mode has no
mid-session permission-approval protocol: there is no interactive prompt to
approve or deny a tool call as it happens. Instead, the CLI enforces the
`--allowed-tools` patterns internally for the entire run — a call that doesn't
match an allowed pattern (e.g. a `WebFetch` to a domain not covered by a
`WebFetch(domain:...)` entry) is blocked outright by the CLI, not merely
discouraged. This makes `allowed_tools` a real boundary, not an advisory one.

Because there's no round-trip, denials aren't visible as they happen — they
surface only after the fact via `permission_denials` telemetry on the session
record. If a session's task requires fetching from a host, that host must be
allowlisted up front via `allowed_tools`; there's no opportunity to approve it
mid-session.

This is a CLI-level, per-tool-call control and is distinct from the network-level
egress allowlist enforced by the Docker-mode Squid proxy (see
[`docs/docker-mode/operator-setup.md`](./docker-mode/operator-setup.md)). The
Squid proxy allowlists destination hosts for _all_ outbound traffic from the
session container regardless of which tool made the request, and only runs
under `ORCHESTRATOR_MODE=corporate` / `dockerMandatory` — it is off by default
in personal mode, where `allowed_tools` is the only enforced boundary.

## Loader behaviour

- **File absent**: returns all defaults silently.
- **File present but malformed YAML**: logs a warning to stderr and returns all defaults. Does not throw.
- **Partial config**: fields present in the file override defaults; missing fields use defaults.
- All commands run at project root in v1 — no per-command `cwd` field.

## Migration from `.claude/orchestrator.json`

The old `allowedTools`, `prGate`, `bootstrapScript`, and `bashRules` fields from `.claude/orchestrator.json` map to the new schema as follows:

| Old field                           | New field          |
| ----------------------------------- | ------------------ |
| `allowedTools`                      | `allowed_tools`    |
| `prGate.typeCheck` / `prGate.build` | `verify`           |
| `bootstrapScript`                   | `bootstrap_script` |
| `bashRules`                         | `bash_rules`       |
