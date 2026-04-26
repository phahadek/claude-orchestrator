# Claude Code Dashboard

A local web dashboard for browsing, managing, and interacting with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Built for solo developers who want visibility and control over automated coding workflows.

## Features

- **Session browser** -- browse, search, and filter Claude Code sessions with full message timelines
- **Multi-project support** -- switch between multiple repos, each with its own task board and session history
- **Live streaming** -- watch sessions in real-time with token usage tracking
- **Task orchestration** -- launch coding sessions from a Notion task board, with automated PR review and lifecycle management
- **PR tracking** -- monitor pull requests, review verdicts, merge state, and conflict detection
- **Follow-up messaging** -- send follow-up prompts to running sessions from the dashboard

## Architecture

| Layer | Tech | Path |
|---|---|---|
| Frontend | React 19 + Vite (TypeScript) | `packages/frontend/` |
| Backend | Node.js + Express (TypeScript) | `packages/backend/` |
| Transport | WebSocket (`ws`) | real-time session events |
| Database | SQLite (`better-sqlite3`) | session metadata, PR tracking |
| Task source | Notion REST API or local YAML | configurable via `TASK_BACKEND` |

The dashboard reads Claude Code session data from JSONL files on disk (`~/.claude/projects/`), stores metadata in a local SQLite database, and communicates with the frontend over WebSockets for real-time updates.

---

## Getting Started

### Prerequisites

- **Node.js 20 LTS** and npm
- **Claude CLI** installed and authenticated (`claude login`)
- **Notion API key** (if using Notion task backend) -- [create an integration](https://www.notion.so/my-integrations)
- **GitHub personal access token** (for PR tracking) -- needs `repo` scope

### Setup

```bash
# Clone and install
git clone <your-repo-url>
cd claude-dashboard
npm install

# Configure backend environment
cp packages/backend/.env.example packages/backend/.env
# Edit packages/backend/.env with your values

# (Optional) Configure frontend environment
cp packages/frontend/.env.example packages/frontend/.env
# Edit packages/frontend/.env with your Notion context page URL and board ID

# Start in development mode (hot reload)
npm run dev
```

The dashboard is available at http://localhost:3000 (backend API + frontend in dev mode at http://localhost:5173).

### Stop and restart

```bash
# Stop both servers
npm run restart          # kill port 3000 and restart both

# Restart backend only (cross-platform)
npm run restart:backend

# Windows PowerShell scripts
.\restart.ps1            # restart both (background, streams output)
.\restart.ps1 -backend  # restart backend only
.\restart.ps1 -frontend # restart frontend only
.\stop.ps1               # stop both
```

### Production build

```bash
npm run build
npm start
```

---

## Docker

### Option A -- Production

```bash
cp packages/backend/.env.example packages/backend/.env
# Edit .env with your values

# Configure docker-compose.yml:
# 1. Set CLAUDE_BIN to your claude CLI path (run `which claude`)
# 2. Add volume mounts for each project directory in PROJECTS

mkdir -p data
docker compose up -d
```

### Option B -- Development (hot reload)

```bash
docker compose -f docker-compose.dev.yml up
```

### Claude CLI auth in Docker

The container mounts two things from the host:

1. **The `claude` binary** -- mounted read-only at `/usr/local/bin/claude`
2. **`~/.claude/`** -- your Claude credentials directory at `/root/.claude/`

> **Security note:** The `~/.claude` mount grants the container full access to your
> Claude credentials, API keys, and session history. Only run containers you trust.

---

## Configuration

All configuration is via `packages/backend/.env`. See `packages/backend/.env.example` for the full list.

| Variable | Required | Description | Example |
|---|---|---|---|
| `TASK_BACKEND` | No | Task source: `notion` (default) or `local` (YAML) | `notion` |
| `NOTION_API_KEY` | If Notion | Notion integration token | `ntn_...` |
| `GITHUB_TOKEN` | Yes | GitHub PAT with `repo` scope | `ghp_...` |
| `GITHUB_REPO` | Yes | Default GitHub repo | `owner/repo` |
| `PROJECTS` | Yes | JSON array of project configs (see below) | |
| `PORT` | No | Server port (default: `3000`) | `3000` |
| `DB_PATH` | No | SQLite database path (default: `./dashboard.db`) | `./dashboard.db` |
| `SESSIONS_DIR` | No | Claude sessions directory | `~/.claude/projects` |
| `AUTO_REVIEW` | No | Enable automated PR review (default: `true`) | `true` |
| `AUTO_REVIEW_CONCURRENCY` | No | Parallel review sessions (default: `1`) | `1` |

### Projects configuration

The `PROJECTS` env var is a JSON array. Each entry requires:

```json
[
  {
    "id": "my-project",
    "name": "My Project",
    "projectDir": "/path/to/repo",
    "contextUrl": "https://www.notion.so/<context-page-id>",
    "boardId": "<notion-database-id>"
  }
]
```

For the local YAML task backend (`TASK_BACKEND=local`), `contextUrl` and `boardId` are optional.

---

## Setting up Notion (optional)

If you want to use Notion as your task backend, see [`docs/notion-template.md`](docs/notion-template.md) for step-by-step instructions on creating the required Notion workspace structure.

---

## Development

```bash
# Run all tests
npm run test -w packages/backend
npm run test -w packages/frontend

# Type-check
npx tsc --noEmit -p packages/backend
npx tsc --noEmit -p packages/frontend

# Build
npm run build
```

---

## License

[MIT](LICENSE)
