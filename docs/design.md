# Product Design

## Overview

Claude Code Orchestrator is an **opinionated** tool for running a parallelized, Claude Code-driven development workflow. It owns the full task lifecycle from dispatch through PR merge — not just monitoring, but actively enforcing lifecycle compliance, automating PR reviews, and routing feedback to sessions.

The unit of work is: **task → session → PR → review → merge**. The orchestrator dispatches, monitors, reviews, and closes N of those simultaneously. The dashboard is one surface of the orchestrator — the observability and intervention layer; the orchestrator does the work whether the dashboard is open or not.

> **Evolution note (M2a):** The project scope expanded from a passive session browser (M1) to an active orchestrator that owns task status transitions, injects lifecycle instructions into sessions, and automates the PR review loop. Sessions no longer manage their own lifecycle — the backend does.

---

## User goals

### Primary jobs to be done

1. **Dispatch** — select N tasks from a Notion task board, click one button, launch N Claude Code sessions in parallel, each pre-loaded with its task context.
2. **Monitor** — see all active sessions at a glance; surface the ones that need attention (blocked on permission, errored, done).
3. **Respond** — handle permission requests, send follow-up messages, kill sessions, view transcripts — without leaving the dashboard or switching windows.

### Non-goals

- No cloud hosting or auth — LAN only, personal use
- No multi-user support
- No remote session bridging (sessions always run local to the backend host)
- No GitHub PR creation (sessions handle that themselves via Agent SDK)

---

## Network & deployment model

- The orchestrator (backend + dashboard) runs as a single process on the **host machine** — the machine where Claude Code sessions execute.
- Served on a LAN port (e.g. `http://host:3000`).
- Accessible from **any browser on the same LAN** — laptop, desktop, tablet — so you can monitor and intervene from a different device than the one running sessions.
- No reverse proxy, no TLS required for LAN use.
- Single process: backend + static UI served together.

---

## Workflows

### Workflow 1 — Dispatch batch

1. User opens dashboard → navigates to **Dispatch** view
2. Dashboard fetches Notion task board (via Notion MCP / API), shows tasks filtered to `Status = 🗂️ Ready` and `Type = 💻 Code`
3. User selects N tasks via checkboxes
4. User clicks **Launch selected** — the orchestrator spawns one Agent SDK session per task, each seeded with the task's Notion page content as context
5. Modal closes immediately — new session cards appear in the grid with status `Starting`
6. Notion task statuses are updated to `🔄 In Progress` automatically **by the backend** (server-side, not by the session)

> **Decision:** No in-modal progress state. Dispatch fires and closes. Grid is the feedback surface.
>
> **Decision:** The backend owns all task status transitions (In Progress, In Review, Done). Sessions are explicitly told NOT to update status themselves — this ensures lifecycle compliance regardless of the project's `CLAUDE.md`.

### Workflow 2 — Monitor active sessions

1. User opens dashboard → lands on **Session grid** (default view)
2. Grid shows all active sessions as cards: task name, status, last output line, elapsed time
3. Sessions needing attention (permission request, error, done) are **visually promoted** — surfaced at top or highlighted
4. User can see overall state without clicking into any session

### Workflow 3 — Respond to attention events

1. Session card shows amber badge: **Needs permission**
2. User clicks card → **Session detail** panel slides in
3. Panel shows: full transcript, the pending permission request, approve/deny buttons
4. User approves → the orchestrator sends the decision back to the Agent SDK session
5. Session resumes; card returns to normal state
6. Same panel allows: send a follow-up message, kill/cancel session

### Workflow 4 — PR review and merge cycle

1. Session publishes a PR → card shows amber badge: **Awaiting review**
2. The orchestrator automatically triggers an AI review (via `ReviewOrchestrator`) — a 🔍 Review session appears in the grid
3. Review completes → PR card in the PRPanel shows verdict badge (✅ Approved / ⚠️ Needs changes / ❌ Incomplete)
4. Review session stays alive (paired with the PR) — accumulates context across review passes
5. If review finds issues → findings are routed to the originating coding session as a follow-up message → session addresses them and pushes
6. Push detected from coding session events (event-driven, no polling) → re-review follow-up sent to the paired review session → loop back to step 3
7. Review iteration cap (default 3, configurable in Settings): if exceeded, both sessions stay alive, escalated to attention queue for human intervention
8. User can also trigger manual review via **Run Review** button (resets iteration counter)
9. User merges approved PRs via **Merge ↓** button (with confirmation) or directly on GitHub
10. On merge → both coding and review sessions closed → task ✅ Done

> **Key principle:** Sessions stay alive after publishing a PR. Review sessions are persistent and paired with their PR. The entire review-feedback-re-review loop is event-driven (push detection from session output, verdict parsing from review session events). Only PR merge closes both sessions.

### Workflow 5 — Monitor PR pipeline

1. User navigates to **PRs** view via header nav
2. All open PRs across all managed projects shown as cards: title, branch, verdict badge, linked task
3. User can trigger review, view review details (4-dimension breakdown), merge, or send findings to the originating session
4. Toast + browser notifications fire when reviews complete

---

## UI layout

### Top-level layout

Single-page app. Three zones:

```
┌─────────────────────────────────────────────────────┐
│ Header bar: project name, active session count,     │
│             attention badge count, Dispatch button  │
├──────────────┬──────────────────────────────────────┤
│              │                                      │
│  Session     │  Session detail panel                │
│  grid        │  (slides in on card click)           │
│              │                                      │
│  Cards for   │  - Task name + Notion link           │
│  each        │  - Full transcript (scrollable)      │
│  active      │  - Permission request widget         │
│  session     │  - Message input                     │
│              │  - Kill button                       │
└──────────────┴──────────────────────────────────────┘
```

### Session card anatomy

Each card in the grid shows:

- **Task name** (from Notion task title)
- **Status badge**: Starting / Running / Needs permission / Done / Error / Killed
- **Last output** — most recent line of session stdout, truncated
- **Elapsed time** — live timer
- **PR link** — shown when session completes and opens a PR

Status badge colors:

- Starting → gray
- Running → blue (pulsing)
- Needs permission → amber (attention)
- Done → green
- Error → red
- Killed → gray, muted

### Dispatch modal

Opens as an overlay when user clicks Dispatch button:

- Notion project selector (dropdown — which project's task board to pull from)
- Task list: fetched from Notion, filtered to Ready + Code type
- Tasks grouped into two sections:
  - **Ready to launch** — tasks with no unmet dependencies (can safely run in parallel immediately)
  - **Has dependencies** — tasks whose prerequisites are not yet done; shown greyed out with blocker names visible
- Dependency state derived from the `Depends On` Rich Text property on each Notion task page (pipe-delimited prerequisite page IDs)
- The backend fetches ALL task statuses (including ✅ Done) so the DependencyResolver can correctly determine which dependencies are satisfied.
- Checkbox per task (disabled for dependency-blocked tasks); Select all / none controls apply only to unblocked tasks
- Priority sub-grouping (High → Medium → Low) within each section
- **Launch N sessions** button — disabled until ≥1 task checked; label updates live with count
- On launch: modal closes immediately, new session cards appear in grid with `Starting` status
- Notion task statuses updated to 🔄 In Progress automatically on launch

---

## Attention queue

The most critical UX surface. A session blocks on a permission request and the user may not be watching.

- A persistent **attention badge** in the header shows count of sessions needing action (e.g. `⚠ 2`)
- Sessions with pending attention are sorted to the **top of the grid** automatically
- Browser tab title updates: `(2) Claude Code Orchestrator` when attention count > 0
- Optional: browser notification (Web Notifications API) when a new attention event fires

---

## Session detail panel

Shown when user clicks a session card. Right-side panel, ~40% width.

### Sections

1. **Header** — task name, status badge, elapsed time, Notion link, kill button
2. **Transcript** — full scrollable log of the session's messages. Auto-scrolls to bottom on new messages. User can scroll up freely.
3. **Permission request** (shown only when session is awaiting permission)
   - Tool name and proposed action displayed clearly
   - **Approve** and **Deny** buttons
   - Deny optionally prompts for a reason to send back to the session
4. **Message composer** — text input + send button to inject a follow-up message into the running session

---

## Permission rule engine

All tool calls from Agent SDK sessions pass through a `canUseTool` hook before execution. The hook evaluates rules in order:

1. **Always-deny list** — matched calls are rejected immediately, session is notified. Example: `rm -rf /`, `git push --force main`.
2. **Always-allow list** — matched calls are approved immediately, no user interaction. Example: all `Read` calls; `Bash` commands that only read from `.claude/**`; `git status/log/diff`; `npm run *`, `npx tsc`, `npx vitest`.
3. **Pattern rules** — glob or regex match on tool name + argument string. Each rule carries an allow/deny decision. Evaluated in order; first match wins.
4. **Escalate** — no rule matched. Session is paused, attention badge increments, permission request surfaces in the dashboard UI.

A **Permission Rules** settings screen in the dashboard lets you manage the rule list: add/remove/reorder rules, toggle allow vs deny, and view a recent log of which rule fired for each tool call.

This is implemented entirely at the SDK layer in the backend. It does not depend on Claude Code's own permission configuration.

## Dependency modelling

### Schema

A `Depends On` Rich Text property on the Notion task database, storing pipe-delimited page IDs of prerequisite tasks within the same board. See [notion-template.md](./notion-template.md#why-rich-text-for-depends-on) for why Rich Text instead of a native Relation.

### Transitive resolution

The backend performs a depth-first traversal of `Depends On` relations when computing the unblocked task set. A task is "ready to launch" only if its entire dependency chain is complete (all ancestors have status ✅ Done). This is a recursive query at fetch time, not a schema change.

### Non-Code tasks in the dependency chain

`📋 Planning` and `🧪 Testing` tasks can legitimately appear in the dependency chain of Code tasks. The Dispatch modal handles this as follows:

- **All task types** are fetched and used for dependency resolution
- Only `💻 Code` tasks are rendered as selectable checkboxes in the Ready to launch section
- Non-Code blockers surface in the dependency tag on blocked Code tasks with their type shown: e.g. `needs: Validate JWT on staging (Testing)`
- This makes it immediately clear whether a blocker requires manual action (Planning/Testing) or is simply waiting on another Code session to complete

---

## Data architecture

### Notion — authoritative source for task data

Notion remains the single source of truth for:

- Task definitions (name, description, priority, status)
- Dependency relationships (`Depends On` Rich Text property — pipe-delimited page IDs)
- Status lifecycle (Ready → In Progress → In Review → Done)

Notion API is called intentionally, not in a hot loop:

- **On dispatch modal open**: fetch Ready + Code tasks with their Depends On relations
- **On launch**: update selected tasks to 🔄 In Progress
- **On session completion**: update task to 👀 In Review, attach PR link to Notes

Required addition to task board schema: a `Depends On` Rich Text property storing pipe-delimited prerequisite page IDs.

### Local SQLite — orchestrator runtime state

A local SQLite database (file-based, zero setup) stores everything Notion doesn't hold:

| Table | Contents |
|---|---|
| `sessions` | session_id, notion_task_id, notion_task_url, project_context_url, status, started_at, ended_at, pr_url |
| `session_events` | session_id, event_type, payload, timestamp — raw event log from Agent SDK |
| `permission_events` | session_id, tool_name, proposed_action, decision, decided_at |
| `permission_rules` | ordered list of glob/regex patterns with allow/deny decisions, managed via the Permission Rules settings UI |
| `pull_requests` | PR metadata, review state, paired review session, merge state |
| `session_audits` | post-session compliance check results |
| `settings` | runtime settings key/value store |
| `task_cache` | notion_task_id, fetched_at, raw_json — short-lived cache (TTL ~5 min) to avoid redundant API calls |

(See [Technical Architecture](./architecture.md) for full column definitions.)

This keeps the orchestrator fast and resilient: if Notion is temporarily unreachable, active sessions and their state remain fully visible.

## Resolved design questions

| Question | Decision |
|---|---|
| Frontend framework | React + Vite (TypeScript) |
| Backend language | Node.js + Express (TypeScript) |
| Session-to-UI transport | WebSocket (`ws` package) |
| Notion integration method | Direct REST API (server-side only) + Notion MCP for sessions |
| Max sessions in parallel | Configurable (default 20 code, 1 review) |
| Session persistence across restart | JSONL import on startup; active sessions are lost on restart |
| Auto-approve permission classes | `--permission-mode acceptEdits` + explicit `--allowed-tools` list. No mid-session approval (CLI limitation). |
| Who owns task status transitions? | Backend only. Sessions are told not to update status. Server sets In Progress on start, In Review on PR, Done on merge. |
| Session lifecycle after PR | Sessions stay alive until PR is merged. Receive review feedback as follow-up messages. |
| PR review trigger | Automatic via ReviewOrchestrator (event-driven, serial queue). Manual **Run Review** as fallback. |
| PR merge detection | Primary: **Merge ↓** button in PRPanel. Fallback: lightweight polling (every 5 min) only for approved PRs. No webhooks (localhost-only design). |
| Review loop max iterations | Cap at N (default 3, configurable in Settings). Both coding and review sessions stay alive at cap, escalated to attention queue. Manual **Re-review** resets counter. |
| Review session lifecycle | Persistent: one review session per PR, stays alive for the PR's lifetime. Receives re-review follow-ups instead of being killed and respawned. Accumulates context across review passes. |
| Review-merge event model | Event-driven, not polling. Push detection from coding session events (`git push` tool calls). Verdict parsing from review session event stream. No GitHub API polling for review state. |
| Orchestrator `CLAUDE.md` | Merged `CLAUDE.md` written to worktree at spawn: orchestrator rules first (authoritative), project `CLAUDE.md` appended (codebase context). Original never modified. |
| Token/cost display model | Per-session token counts plus estimated dollar cost (model-aware, computed from per-million input/output rates in `utils/usage.ts` — Opus $15/$75, Sonnet $3/$15, Haiku $0.80/$4). Plan utilization % shown when `plan_token_cap` is configured in Settings (originally the only display model — extended to dollar costs in M2a). |

## Related documentation

- [Technical Architecture](./architecture.md) — implementation details, project structure, data flow
- [Coding Guidelines](./coding-guidelines.md) — architectural rules, naming, patterns, git etiquette
- [Task Writing Guidelines](./task-writing.md) — how to scope and write Notion tasks
