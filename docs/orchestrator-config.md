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

# Extra Bash tool permission patterns merged with the base allowed-tools set.
allowed_tools: []

# Bash rules (Rule 5+). Each item is the full rule text.
# The first line becomes the bold heading; subsequent lines become the body.
bash_rules: []

# Path to a script run after worktree creation, relative to the project root.
# The script receives the worktree path as $1.
bootstrap_script: ''
```

## Fields

| Field              | Type       | Default | Description                                                                                                           |
| ------------------ | ---------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `autofix`          | `string[]` | `[]`    | Commands run by the orchestrator before the PR is opened. Failures are logged but do not block.                       |
| `verify`           | `string[]` | `[]`    | Commands injected into the CLAUDE.md Pre-PR Gate section. The session is instructed to run these before opening a PR. |
| `ci_check_name`    | `string[]` | `[]`    | GitHub check-run names the orchestrator treats as authoritative. Empty = all checks count.                            |
| `allowed_tools`    | `string[]` | `[]`    | Extra Bash tool permission patterns (e.g. `Bash(dotnet:*)`) added on top of the base set.                             |
| `bash_rules`       | `string[]` | `[]`    | Replacement Bash rules (Rule 5+) injected into CLAUDE.md. Each string's first line is the heading.                    |
| `bootstrap_script` | `string`   | `""`    | Relative path to a script executed after worktree creation. Receives the worktree path as `$1`.                       |

All fields are optional. Missing fields fall back to their defaults — a partial config is valid.

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
