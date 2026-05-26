# Docker Mode — Operator Setup

Docker mode runs each coding session in its own container with a restricted egress
proxy. It is activated when `ORCHESTRATOR_MODE=corporate` (or the dashboard setting
is set to corporate), which sets `gates.dockerMandatory=true`.

## Prerequisites

- Docker Engine installed and running on the host
- The dashboard backend has access to the Docker socket

## 1. Build the session image

```bash
docker build -t claude-orchestrator-session:latest -f docker/session/Dockerfile .
```

Re-build after any change to `docker/session/Dockerfile`.

## 2. Configure the backend

In `packages/backend/.env`:

```env
# Activate corporate / docker mode
ORCHESTRATOR_MODE=corporate

# Path to the claude CLI binary on the host (mounted into session containers)
CLAUDE_BIN=/usr/local/bin/claude

# (Optional) Additional egress hosts beyond the default allowlist
# Default allowlist: api.anthropic.com, api.github.com, github.com, api.notion.com
DOCKER_EGRESS_EXTRA_HOSTS=jira.your-company.com,registry.npmjs.org

# (Optional) Override the session image name
DOCKER_SESSION_IMAGE=claude-orchestrator-session:latest
```

## 3. Docker socket access

When running the backend via docker-compose, the socket mount is already included:

```yaml
volumes:
  - '/var/run/docker.sock:/var/run/docker.sock'
```

When running the backend directly on the host (`npm run dev`), the host Docker
socket is used automatically — no extra configuration needed.

## 4. Egress allowlist

The proxy (squid) permits outbound HTTPS only to the following destinations by
default:

| Host | Purpose |
|------|---------|
| `api.anthropic.com` | Claude API |
| `api.github.com` | GitHub API |
| `github.com` | Git operations |
| `api.notion.com` | Notion task backend |

Add per-project hosts via `DOCKER_EGRESS_EXTRA_HOSTS` (comma-separated). For
Jira-backed projects, add the Jira instance hostname.

## 5. Per-project bootstrap

Add a `bootstrap` key to `.claude-orchestrator.yml` in the project repo to run
commands inside the session container before claude starts. Commands execute
inside the container and are subject to the egress allowlist:

```yaml
bootstrap:
  - npm ci --prefer-offline
  - npx prisma generate
```

## 6. Resource lifecycle

Each session creates three ephemeral resources (all named with the session ID):

| Resource | Name pattern | Removed |
|----------|-------------|---------|
| Session container | `claude-session-<id>` | On session end |
| Proxy container | `claude-session-proxy-<id>` | On session end |
| Internal network | `claude-session-net-<id>` | On session end |

On backend restart, orphaned resources (containers/networks with no matching
active session in the database) are automatically removed.

## 7. Security notes

- `ANTHROPIC_API_KEY` is **never** set on the session container environment.
  It is not visible via `docker inspect`.
- The session container is on an `--internal` network with no direct internet
  access. All outbound traffic routes through the squid proxy, which enforces
  the allowlist and logs every request.
- The claude credentials (`~/.claude`) are mounted read-only.
