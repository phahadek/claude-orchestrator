# Install & Configure

Detailed setup, Docker, and configuration reference for Claude Code Orchestrator. For a 4-line happy-path quickstart, see the project [README](../README.md).

## Prerequisites

- Node.js 20 LTS and npm
- [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated (`claude login`)
- Notion integration token, if using Notion as a task source — [create an integration](https://www.notion.so/my-integrations)
- GitHub personal access token with `repo` scope, for PR tracking

## Local development

```bash
git clone https://github.com/phahadek/claude-orchestrator.git
cd claude-orchestrator
npm install

cp packages/backend/.env.example packages/backend/.env
# Edit packages/backend/.env — see the env var reference below

cp .claude/local-context.md.example .claude/local-context.md
# Edit .claude/local-context.md with your project's Notion URLs

# Optional: Notion context page URL and board ID for the frontend
cp packages/frontend/.env.example packages/frontend/.env

npm run dev
```

In dev mode, open `http://localhost:5173` in your browser — that's Vite's frontend with hot reload. The backend runs on `:3000`; Vite proxies API + WebSocket traffic to it automatically. In production (`npm start`), both are served from `:3000` as a single process.

### Local context (`.claude/local-context.md`)

`.claude/local-context.md` is **gitignored** and holds host-local references — Notion Project Context URL, board IDs, design-doc links — that should never be committed. Claude Code sessions opened directly in the repo read it as their first action; orchestrator-launched sessions get the same content auto-appended to their injected `CLAUDE.md` at session start.

As an optional defense-in-depth, you can install a local pre-commit hook that rejects any commit containing a Notion workspace ID:

```bash
cat > .git/hooks/pre-commit <<'EOF'
#!/usr/bin/env bash
if git diff --cached -p | grep -qE "33[2-6]22f9152f38[0-9a-f]{19}"; then
  echo "ERROR: commit contains Notion workspace IDs." >&2
  echo "Move them to .claude/local-context.md (gitignored), or use --no-verify if intentional." >&2
  exit 1
fi
EOF
chmod 755 .git/hooks/pre-commit
```

The hook lives in `.git/hooks/` and is **not** tracked in the repo — install per-clone if you want it.

### Restart helpers

`npm run dev` is the normal happy-path command. Use the restart helpers when port `3000` is held by an orphaned dev process (common after a crashed terminal, Docker exit, or `Ctrl+C` that didn't fully clean up):

```bash
npm run restart           # kill whatever is bound to port 3000, then npm run dev
npm run restart:backend   # same, but only for the backend (frontend Vite reload is normally enough)

# Windows PowerShell — same intent, plus per-process control
.\restart.ps1             # restart both (background, streams output)
.\restart.ps1 -backend    # backend only
.\restart.ps1 -frontend   # frontend only
.\stop.ps1                # stop both without restarting
.\restart-backend.ps1     # foreground backend restart (logs in current terminal)
```

### Production build

```bash
npm run build   # compiles backend, builds frontend bundle into packages/backend/dist/public/
npm start       # node packages/backend/dist/server.js
```

## Docker

### Production

```bash
cp packages/backend/.env.example packages/backend/.env   # edit values
# In docker-compose.yml:
#   1. Set CLAUDE_BIN to your claude CLI path (run: which claude)
#   2. Add a volume mount for each project directory referenced in PROJECTS
mkdir -p data
docker compose up -d
```

### Development (hot reload)

```bash
docker compose -f docker-compose.dev.yml up
```

### Claude CLI auth in Docker

The container mounts two host paths:

1. **The `claude` binary** — read-only at `/usr/local/bin/claude`
2. **`~/.claude/`** — your Claude credentials directory at `/root/.claude/`

> **Security note:** the `~/.claude` mount grants the container full access to your Claude credentials, API keys, and session history. Only run containers you trust.

## Configuration reference

All configuration lives in `packages/backend/.env`. See `packages/backend/.env.example` for a complete template.

| Variable | Required | Description | Example |
|---|---|---|---|
| `NOTION_API_KEY` | If any project's `task_source` is `notion` | Notion integration token | `ntn_...` |
| `GITHUB_TOKEN` | Yes | GitHub PAT with `repo` scope | `ghp_...` |
| `GITHUB_REPO` | No | Fallback `owner/repo` used only when `GitHubClient` is called without a project context (e.g. CLI scripts). Per-project `githubRepo` (in `PROJECTS`) takes precedence and is required for the dashboard's PR features. | `owner/repo` |
| `PROJECTS` | Yes | JSON array of project configs (see below) | |
| `PORT` | No | Backend HTTP port | `3000` |
| `DB_PATH` | No | SQLite database file | `./dashboard.db` |
| `SESSIONS_DIR` | No | Claude CLI sessions directory | `~/.claude/projects` |
| `AUTO_REVIEW` | No | Enable automated PR review | `true` |
| `AUTO_REVIEW_CONCURRENCY` | No | Parallel review sessions | `1` |

### `PROJECTS` JSON format

The `PROJECTS` env var is a JSON array. Each entry:

```json
[
  {
    "id": "my-project",
    "name": "My Project",
    "projectDir": "/path/to/repo",
    "contextUrl": "https://www.notion.so/<context-page-id>",
    "boardId": "<notion-database-id>",
    "githubRepo": "owner/repo"
  }
]
```

For multiple Notion boards (one per milestone) on the same project, add a `boards` array:

```json
{
  "id": "my-project",
  "boards": [
    { "id": "<m1-database-id>", "name": "M1" },
    { "id": "<m2-database-id>", "name": "M2" }
  ]
}
```

Task source (`notion` or `yaml`) is configured per-project in the dashboard at **Settings → Projects → Add project**. For YAML projects, `contextUrl` and `boardId` are optional; the backend reads tasks from `<projectDir>/tasks.yaml`, and the Settings UI offers a "Create empty tasks.yaml" affordance when no file exists.

## Notion workspace setup

If you want to use Notion as your task backend, the dashboard expects a specific page + database structure. See [`notion-template.md`](notion-template.md) for step-by-step setup.

## Development

```bash
# Tests
npm run test -w packages/backend
npm run test -w packages/frontend

# Type-check
npx tsc --noEmit -p packages/backend
npx tsc --noEmit -p packages/frontend

# Build
npm run build
```
