# Technical Architecture

## Stack

| Layer                 | Choice                             | Notes                                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend              | React + Vite (TypeScript)          | Component model suits live session cards; Vite for fast dev reloads                                                                                                                                                                                                                                  |
| Backend               | Node.js + Express (TypeScript)     | Same language as frontend. Spawns and manages `claude` CLI subprocesses.                                                                                                                                                                                                                             |
| Realtime transport    | WebSocket — `ws` npm package       | Bidirectional: UI→server for approve/deny/kill/send, server→UI for session output                                                                                                                                                                                                                    |
| Database              | SQLite — `better-sqlite3`          | Synchronous API, zero-config, file-based. Stores runtime state only.                                                                                                                                                                                                                                 |
| Claude Code execution | `claude` CLI subprocess            | Spawned via `child_process.spawn()` in the target project directory. Streams JSONL events on stdout. In CLI mode (the default), no Anthropic API key is required — auth is handled by the CLI's own credentials. API mode (`SESSION_MODE=api`) uses the Agent SDK and requires a configured API key. |
| Task source           | Notion REST API (server-side only) | Direct HTTP to `api.notion.com`; API key never exposed to browser                                                                                                                                                                                                                                    |
| Package structure     | npm workspaces monorepo            | Shared WS message types between backend and frontend without duplication                                                                                                                                                                                                                             |

---

## Project structure

```
claude-orchestrator/
  package.json               ← workspace root (npm workspaces)
  packages/
    backend/
      package.json
      tsconfig.json
      src/
        server.ts            ← entry point: Express setup, WS server, static file serving
        config.ts            ← env var loading, runtime settings, ALLOWED_TOOLS allowlist
        session/
          SessionManager.ts        ← owns Map<sessionId, AgentSession>, start/kill/send/resume
          AgentSession.ts          ← wraps a single CLI/SDK session, streams events to WS
          SessionRunner.ts         ← I/O adapter interface for AgentSession
          CliSessionRunner.ts      ← stdin/stdout JSONL adapter for `claude` subprocess
          ApiSessionRunner.ts      ← Agent SDK adapter (SESSION_MODE=api)
          SessionAuditor.ts        ← post-session compliance checks
          ContextBuilder.ts        ← builds session context from Notion + project state
          JsonlReader.ts           ← reads historical sessions from ~/.claude/projects/*.jsonl
          orchestrator-claudemd.ts ← merges orchestrator rules + project CLAUDE.md
          orchestrator-config.ts   ← orchestrator runtime configuration
        permissions/
          PermissionEngine.ts      ← deny list → allow list → pattern rules → escalate
          types.ts                 ← PermissionRule, RuleMatch, Decision types
        notion/
          NotionClient.ts          ← REST API wrapper: fetch tasks, update status
          DependencyResolver.ts    ← depth-first traversal of Depends On relations
          types.ts                 ← Task, ResolvedTask types
        github/
          GitHubClient.ts          ← REST wrapper: list/fetch/diff/merge PRs
          PRReviewService.ts       ← spawns/manages persistent review sessions per PR
          ReviewOrchestrator.ts    ← serial queue + review-feedback-re-review loop
          PRMergeWatcher.ts        ← lightweight 5-min poll for direct-on-GitHub merges
          reviewUtils.ts           ← shouldAutoReview, formatReviewFeedback helpers
          types.ts                 ← PullRequest, ReviewJob types
        tasks/
          TaskTrackerBackend.ts    ← interface for task source backends
          NotionTaskBackend.ts     ← Notion-backed implementation
          LocalTaskBackend.ts      ← YAML-backed implementation (selected via project.task_source = 'yaml')
          TaskStatusEngine.ts      ← derives display status from PR + session state
        routes/
          sessions.ts              ← /api/sessions REST endpoints
          tasks.ts                 ← /api/tasks endpoints + WS task_updated bridge
          prs.ts                   ← /api/prs endpoints (review, merge, sync)
          rules.ts                 ← permission events / denials / rules CRUD
          settings.ts              ← runtime settings get/set
          analytics.ts             ← per-project token & cost aggregations
          config.ts                ← /api/config (project list for the frontend)
        db/
          schema.ts                ← table definitions, migrations
          queries.ts               ← typed query helpers (sessions, events, rules, cache, PRs)
          db.ts                    ← better-sqlite3 instance + late ALTER migrations
          types.ts                 ← Session, SessionEvent, PullRequestRow, etc.
        utils/
          eventFilters.ts          ← isSystemOnlyUserEvent — filters orchestrator-injected events
          usage.ts                 ← per-model token/cost calculation
        ws/
          router.ts                ← routes incoming WS messages to handlers
          types.ts                 ← ClientMessage / ServerMessage discriminated unions (source of truth)
    frontend/
      package.json
      vite.config.ts
      tsconfig.json
      src/
        App.tsx
        components/
          SessionGrid.tsx          ← card list, attention sorting
          SessionCard.tsx          ← individual card with status badge
          SessionDetail.tsx        ← transcript + permission responder + composer
          DispatchModal.tsx        ← Notion task picker, dependency grouping, launch
          PermissionRules.tsx      ← settings screen for rule management
        hooks/
          useWebSocket.ts          ← single persistent WS connection, reconnect logic
          useSessionStore.ts       ← React state driven by WS events
        types/
          ws.ts                    ← re-exports from backend/src/ws/types.ts (path alias)
```

---

## Key systems

### SessionManager

The central backend class. Owns all active sessions and is the single point of contact for the WS router.

- `start(taskUrl, projectContextUrl, options?)` — creates git worktree, spawns `AgentSession`, calls `updateStatus('🔄 In Progress')` server-side, returns `sessionId`
- `kill(sessionId)` — cross-platform tree kill, waits up to 15s
- `send(sessionId, message)` — injects a follow-up message into a running session
- `endSession(sessionId)` — closes stdin so CLI exits cleanly
- `approve(sessionId)` / `deny(sessionId, reason)` — resolves a pending permission request
- On SIGTERM: iterates all active sessions, calls `kill()` on each, waits for all to settle
- **Lifecycle ownership:** SessionManager calls `updateStatus('🔄 In Progress')` on start. AgentSession calls `updateStatus('👀 In Review')` on clean exit with PR. Sessions themselves never touch task status.

### AgentSession

Wraps a single `claude` CLI subprocess. Streams all events to registered WebSocket clients via an event emitter.

- Spawned with `child_process.spawn('claude', ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowed-tools', ...], { cwd: worktreePath })`
- Reads stdout line-by-line; each line is a JSONL event object — parsed and forwarded over WebSocket
- **Structured lifecycle prompt:** The initial prompt includes a full 6-step lifecycle (read CLAUDE.md → branch from dev → implement → pre-PR gate → draft PR → wait for review). Sessions are explicitly told not to update task status or write session logs — the backend handles those.
- **Permission model:** Uses `--permission-mode acceptEdits` + granular `--allowed-tools Bash(<prefix>:*)` patterns. No mid-session permission approval (CLI limitation).
- Writes every event to `session_events` table in SQLite
- **Push detection:** Watches for `Bash` tool calls matching `git push` — emits `push_detected` event consumed by ReviewOrchestrator to trigger re-reviews
- On completion (exit code 0): `handleCleanExit()` scans events for PR URL, calls `attachPR()`, calls `updateStatus('👀 In Review')` only if PR found, emits `pr_created` event for ReviewOrchestrator
- On `kill()`: cross-platform tree kill (`taskkill /T /F` on Windows, `kill -PID` on Unix). `isKilling` flag prevents double status updates.
- **Git worktree isolation:** Each session runs in its own worktree (`<projectDir>/.claude/worktrees/<sessionId>`). Worktree cleaned up on session end; branch kept if PR was opened.
- **Orchestrator `CLAUDE.md` injection:** After worktree creation, writes a merged `CLAUDE.md`: orchestrator process rules first (lifecycle, status ownership, PR format, forbidden actions, git isolation), then the project's original `CLAUDE.md` appended below. Template built by `orchestrator-claudemd.ts`. Original project file never modified.

### PermissionEngine

Stateless evaluator. Called per tool invocation with `(toolName, toolArgs)`. Returns `allow | deny | escalate`.

Evaluation order:

1. Always-deny list — hard-coded dangerous patterns (e.g. `rm -rf /`, `git push --force main`)
2. Always-allow list — safe patterns auto-approved without logging (e.g. all `Read` calls, `git status/log/diff`, `npx tsc`, `npx vitest`)
3. Pattern rules — ordered list from SQLite `permission_rules` table; glob/regex on `toolName + " " + toolArgs`; first match wins
4. Escalate — no rule matched; suspend session, surface to attention queue

All decisions (except always-allow) written to `permission_events` table.

### NotionClient

Server-side only. Wraps the Notion REST API.

- `fetchReadyTasks(boardId)` — fetches tasks with all statuses except Deferred (includes Done tasks so DependencyResolver works correctly), expands `Depends On` relation, returns `ResolvedTask[]`
- `updateStatus(taskId, status)` — patches task status. Called by the **backend** (SessionManager on start, AgentSession on PR), never by sessions themselves.
- `attachPR(taskId, prUrl)` — appends PR link to task Notes on session completion
- Results cached in `task_cache` table with 5-minute TTL

> **Ownership model:** The backend is the sole owner of task status transitions. Sessions are explicitly instructed not to call Notion status APIs.

### GitHubClient

Server-side REST wrapper for the GitHub API. Uses a PAT (`GITHUB_TOKEN` env var).

- `listOpenPRs(repo)` — lists open PRs, excludes drafts
- `fetchDiff(repo, prNumber)` — fetches unified diff, parses changed files
- `mergePR(repo, prNumber, commitTitle)` — squash merge
- Used by PRSyncJob (startup sync), PRReviewService, and REST endpoints

### PRReviewService

Manages persistent review sessions paired with PRs. Uses `sessionType: 'review'` so review sessions appear in the grid.

- `review(prNumber, repo, prompt, taskUrl, contextUrl)` — starts a persistent review session, parses verdict from event stream (not from process exit)
- Review compares: PR title vs task name, diff vs implementation spec, diff vs acceptance criteria, changed files vs files/paths list
- Review session stays alive for the PR's lifetime — receives re-review follow-ups instead of being killed and respawned
- Verdict parsed from `session_event` stream (JSON block in assistant output), same pattern as PR URL detection
- Result stored in `pull_requests.review_result` (JSON)

### ReviewOrchestrator

Event-driven auto-trigger for PR reviews. Owns the full review-feedback-re-review loop.

- Serial queue with configurable concurrency (default 1, `AUTO_REVIEW_CONCURRENCY` env)
- On `pr_created` event: spawn persistent review session via PRReviewService → parse verdict from events
- On `needs_changes` verdict: format findings → `SessionManager.send()` to originating coding session
- On `push_detected` from coding session: send re-review follow-up to paired review session (iteration++)
- Review iteration cap: `max_review_iterations` setting (default 3). When exceeded → broadcast `review_escalated` → attention queue. Both sessions stay alive for human intervention.
- Manual **Re-review** resets `review_iteration` to 0
- Disabled with `AUTO_REVIEW=false` env

### PRMergeWatcher

Lightweight fallback polling for PR merges done directly on GitHub.

- Polls only PRs in `approved` review state (minimises GitHub API calls)
- Default interval: 5 minutes, configurable via settings
- On merge detected: kill both coding + review sessions → `updateStatus(taskId, '✅ Done')` → broadcast `pr_merged`
- Primary merge path is the **Merge ↓** button in PRPanel, which triggers the same close flow immediately

### SessionAuditor

Post-session compliance checker. Runs after every code session ends.

- Checks: PR opened on clean exit? PR targets dev? PR title format? PR body readable? Changed files match task spec?
- Routes violations back to the originating session if still alive
- Stores results in `session_audits` table, broadcasts to frontend

### DependencyResolver

Depth-first traversal of the `Depends On` relation graph.

- Input: flat list of tasks with their `dependsOn` arrays
- Output: each task annotated with `blocked: boolean` and `blockers: Task[]` (immediate + transitive)
- A task is unblocked only if all ancestors recursively have `status = Done`
- Non-Code tasks (Planning, Testing) are included in resolution but flagged as `nonCode: true` — shown in dependency tags in the UI, never selectable for dispatch

### WebSocket message protocol

All realtime communication uses a typed discriminated union defined once in `backend/src/ws/types.ts` and shared with the frontend.

**Server → Client:**

- `session_started` — new session card appears in grid
- `session_event` — transcript line (text, tool_use, tool_result, system, user_message)
- `session_status` — status change (running → done / error / killed)
- `permission_request` — tool name + proposed action, session awaiting decision
- `permission_denials` — list of tools denied during session (from CLI `result` event)
- `session_ended` — final status, pr_url if applicable
- `tasks_ready` — resolved task list with dependency state
- `pr_review_complete` — review verdict + summary for a PR
- `pr_merged` — PR merged, both sessions closed, task Done
- `pr_closed` — PR closed without merge, attention-worthy
- `review_escalated` — review iteration cap hit, human intervention needed
- `push_detected` — coding session pushed commits, triggers re-review
- `session_audit` — compliance violations for a session

**Client → Server:**

- `dispatch` — array of `{ taskUrl, projectContextUrl, taskType? }` to launch
- `approve` — `{ sessionId }`
- `deny` — `{ sessionId, reason? }`
- `send_message` — `{ sessionId, message }`
- `kill` — `{ sessionId }`
- `end_session` — `{ sessionId }` — close stdin cleanly
- `fetch_tasks` — `{ boardId }`

---

## Data flow

```
User clicks Launch
  → WS: dispatch [{taskUrl, projectContextUrl}, ...]
  → SessionManager.start() × N (parallel)
    → AgentSession: spawns `claude` CLI subprocess in projectDir
    → claude CLI: fetches Notion pages, begins task, streams JSONL to stdout
    → Events stream → session_events table + WS → UI cards update live
    → claude emits permission event → PermissionEngine evaluates
      → allow: write {"type":"approve"} to stdin, session continues
      → escalate: WS permission_request → attention badge increments
        → User approves → WS approve → write {"type":"approve"} to stdin
        → Session resumes
    → Session completes → PR URL parsed → Notion status updated
    → WS session_ended → card shows green Done badge + PR link
```

---

## SQLite schema

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  notion_task_id TEXT,
  notion_task_url TEXT,
  project_context_url TEXT,
  status TEXT,  -- starting | running | needs_permission | done | error | killed
  started_at INTEGER,
  ended_at INTEGER,
  pr_url TEXT,
  worktree_path TEXT,
  project_id TEXT,
  session_type TEXT DEFAULT 'standard',  -- 'standard' | 'review'
  archived INTEGER NOT NULL DEFAULT 0,
  favorited INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  tags TEXT,  -- JSON array
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  task_name TEXT
);

CREATE TABLE session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  event_type TEXT,
  payload TEXT,  -- JSON
  timestamp INTEGER
);

CREATE TABLE permission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  tool_name TEXT,
  proposed_action TEXT,
  decision TEXT,  -- allow | deny | escalate
  rule_matched TEXT,
  decided_at INTEGER
);

CREATE TABLE permission_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_index INTEGER,
  pattern TEXT,  -- glob or regex string
  match_type TEXT,  -- glob | regex
  decision TEXT,  -- allow | deny
  label TEXT,
  enabled INTEGER DEFAULT 1
);

CREATE TABLE task_cache (
  notion_task_id TEXT PRIMARY KEY,
  fetched_at INTEGER,
  raw_json TEXT
);

CREATE TABLE pull_requests (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number              INTEGER NOT NULL,
  pr_url                 TEXT NOT NULL UNIQUE,
  notion_task_id         TEXT,
  session_id             TEXT,
  repo                   TEXT NOT NULL,
  title                  TEXT,
  body                   TEXT,
  head_branch            TEXT,
  base_branch            TEXT,
  state                  TEXT DEFAULT 'open',
  draft                  INTEGER NOT NULL DEFAULT 0,
  review_result          TEXT,           -- JSON blob from PRReviewService
  review_at              TEXT,
  created_at             TEXT,
  updated_at             TEXT,
  synced_at              TEXT NOT NULL,
  review_session_id      TEXT,           -- paired persistent review session
  review_iteration       INTEGER NOT NULL DEFAULT 0,
  head_sha               TEXT,
  last_reviewed_sha      TEXT,
  node_id                TEXT,           -- GitHub GraphQL global ID
  mergeable              INTEGER,        -- 0 | 1 | NULL (NULL = unknown)
  merge_state            TEXT,           -- 'clean' | 'dirty' | 'blocked' | 'unknown' | NULL
  merge_state_checked_at TEXT,           -- ISO timestamp
  pending_push           INTEGER NOT NULL DEFAULT 0  -- 1 if a push arrived before initial review completed
);

CREATE TABLE session_audits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  pr_opened     INTEGER NOT NULL DEFAULT 0,
  pr_targets    TEXT,
  task_status   TEXT,
  violations    TEXT NOT NULL DEFAULT '[]',
  spec_mismatch TEXT,
  audited_at    TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

---

## Shared types (monorepo)

The `ws/types.ts` file in the backend is the single source of truth for all WebSocket message shapes. The frontend references it via a TypeScript path alias or workspace package re-export. Both sides compile against identical types — no manual sync, no runtime surprises at the message boundary.

---

## Deployment

- `npm run build` at workspace root: compiles backend TypeScript + builds frontend Vite bundle into `backend/dist/public/`
- `node dist/server.js` starts the single process on the configured port (default `3000`)
- Express serves `dist/public/` as static files for all non-API routes
- WebSocket server runs on the same port, same process
- Accessible from any browser on the LAN at `http://<server-ip>:3000`
- Run under `pm2` or `systemd` for persistence across server reboots

## Related documentation

- [Product Design](./design.md) — user goals, workflows, UI layout, decisions
- [Coding Guidelines](./coding-guidelines.md) — architectural rules, naming, patterns, git etiquette
- [Task Writing Guidelines](./task-writing.md) — how to scope and write Notion tasks
