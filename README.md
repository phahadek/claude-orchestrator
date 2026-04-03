# Claude Code Dashboard

A local web dashboard for browsing, managing, and interacting with Claude Code sessions.

---

## Running the dashboard

### Option A — Native (Windows / macOS / Linux)

Recommended for Windows users and anyone with cross-platform projects (e.g. Windows-native Godot/C# projects).

**Prerequisites:** Node.js 20 LTS, npm.

```bash
# Install dependencies
npm install

# Copy backend env and fill in your values
cp packages/backend/.env.example packages/backend/.env

# Start in development mode (hot reload)
npm run dev

# Or build and start in production mode
npm run build
npm start
```

The dashboard is available at http://localhost:3000.

---

### Option B — Docker (Linux)

Recommended for Linux users who want a reproducible, isolated deployment. Sessions run inside the container and operate on your mounted project directories.

**Prerequisites:** Docker, Docker Compose.

#### 1. Configure environment

```bash
cp packages/backend/.env.example packages/backend/.env
# Edit packages/backend/.env with your Notion API key, GitHub token, etc.
```

#### 2. Configure docker-compose.yml

Open `docker-compose.yml` and configure:

- **`CLAUDE_BIN`** — path to your `claude` CLI binary on the host.
  Run `which claude` to find it (e.g. `/usr/local/bin/claude`, `~/.local/bin/claude`).
  Either export it or edit the compose file directly:
  ```bash
  export CLAUDE_BIN=$(which claude)
  ```

- **Project volume mounts** — uncomment and add a mount for each project directory
  referenced in your `PROJECTS` env var. The container path must match the path
  used in the `PROJECTS` JSON array:
  ```yaml
  volumes:
    - "/home/user/my-project:/home/user/my-project"
  ```

#### 3. Create the data directory

```bash
mkdir -p data
```

#### 4. Start the dashboard

```bash
docker compose up -d
```

The dashboard is available at http://localhost:3000.

#### Stopping and restarting

```bash
docker compose down        # stop
docker compose up -d       # start (uses cached image)
docker compose up -d --build  # rebuild image and start
```

---

### Docker — Claude CLI auth

The container does **not** install the `claude` CLI. Instead it relies on two mounts:

1. **The `claude` binary** — mounted read-only from the host at `/usr/local/bin/claude`.
2. **`~/.claude/`** — the host's Claude credentials directory, mounted at `/root/.claude/`.
   This gives the CLI inside the container access to your stored credentials without
   requiring a separate `claude login` step inside the container.

> **Security note:** The `~/.claude` mount grants the container full access to your
> Claude credentials, API keys, and session history. Only run containers you trust
> in this configuration.

---

### Docker — development mode (hot reload)

Use `docker-compose.dev.yml` for an inner-loop workflow with live source reloading:

```bash
docker compose -f docker-compose.dev.yml up
```

This mounts the `packages/` source tree into the container and runs `npm run dev`,
giving you Vite HMR for the frontend and ts-node for the backend.

---

## Configuration

All configuration is via `packages/backend/.env`. See `packages/backend/.env.example`
for the full list of supported variables.

Key variables:

| Variable | Description |
|---|---|
| `NOTION_API_KEY` | Notion integration token |
| `GITHUB_TOKEN` | GitHub personal access token (for PR tracking) |
| `GITHUB_REPO` | Default GitHub repo (`owner/repo`) |
| `PROJECTS` | JSON array of project configs |
| `PORT` | Server port (default: 3000) |
| `DB_PATH` | SQLite database path (default: `./dashboard.db`) |
| `SESSIONS_DIR` | Claude sessions JSONL directory (default: `~/.claude/projects`) |
| `AUTO_REVIEW` | Enable automated PR review (default: `true`) |
