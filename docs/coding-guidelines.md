# Coding Guidelines

This document captures architectural rules, patterns, and coding conventions for the Claude Code Orchestrator project. It is a living document — update it when new constraints are established or patterns are agreed upon.

These guidelines exist to keep the codebase consistent across sessions and prevent architectural drift. Consult this page before writing new code in any session.

---

## Core architectural rules

### 1. Strict frontend / backend layer separation

Information flows in one direction only: **Backend → Frontend**. The frontend is a pure consumer of WebSocket events and REST responses — it never directly touches SQLite, spawns processes, or calls the Notion API.

| Layer | Contents | Allowed dependencies |
|---|---|---|
| **Backend** | Express server, SessionManager, AgentSession, PermissionEngine, NotionClient, SQLite queries | Node.js, `ws`, `better-sqlite3`, `child_process`. No browser APIs. |
| **Frontend** | React components, hooks, UI state | React, Vite, WebSocket client. No Node.js built-ins, no `better-sqlite3`, no direct Notion calls. |
| **Shared** | WS message types (`backend/src/ws/types.ts`) | Pure TypeScript types only. Zero runtime dependencies. |

**Rules:**

- The frontend must never import anything from `packages/backend/src/` except the shared WS types (via path alias or workspace re-export).
- The Notion API key must never be sent to the browser. All Notion calls are made server-side only.
- SQLite reads/writes are backend-only. The frontend receives all state through WebSocket events — it never queries the database directly.
- If you find yourself writing a `fetch('/api/...')` call that returns raw SQLite rows to the browser, stop and model it as a WS event instead.

### 2. SQLite before broadcast

All session events must be written to SQLite **before** being forwarded over WebSocket to clients. This guarantees that a page refresh can reconstruct state from the database without gaps.

- `AgentSession` writes to `session_events` first, then emits to WebSocket.
- Status transitions write to `sessions` first, then broadcast `session_status`.
- This rule has no exceptions, including for low-latency paths.

### 3. WebSocket types are the single source of truth

`backend/src/ws/types.ts` defines all `ClientMessage` and `ServerMessage` discriminated unions. Both sides of the connection compile against these types.

- Never duplicate or manually re-declare WS message shapes in frontend files.
- Never use `any` or `unknown` for parsed WebSocket payloads — parse and validate against the shared types.
- When adding a new message type, add it to `types.ts` first, then implement the handler and the emitter.

### 4. PermissionEngine is stateless

`PermissionEngine` is a pure function: `(toolName, toolArgs) → allow | deny | escalate`. It must have zero side effects.

- Rules are passed in from SQLite at call time — the engine does not query the database itself.
- Logging of decisions is the caller's responsibility (`AgentSession`), not the engine's.
- Tests for the engine must not require a database or a live process.

### 5. No Notion calls from the frontend

The Notion REST API is server-side only. The frontend receives task data as structured payloads from the backend.

- No `api.notion.com` fetch calls anywhere under `packages/frontend/`.
- No Notion API keys, integration tokens, or page IDs are embedded in Vite bundles or environment variables exposed to the browser.
- If the frontend needs Notion data, add a WS message or REST endpoint to the backend that returns only the fields the UI needs.

### 6. Child process lifecycle is owned by AgentSession

Only `AgentSession` spawns and manages the `claude` CLI subprocess. Nothing else calls `child_process.spawn` for Claude.

- `SessionManager` orchestrates sessions but does not touch the child process directly.
- Shutdown is always attempted gracefully: `SIGTERM` → 15s wait → `SIGKILL`.
- Stdout is read line-by-line. Each line is a complete JSONL event — never buffer partial lines across multiple reads.

---

## Naming conventions

| Thing | Convention | Example |
|---|---|---|
| React components | PascalCase, noun or noun phrase | `SessionCard`, `DispatchModal` |
| React hooks | camelCase, `use` prefix | `useWebSocket`, `useSessionStore` |
| Backend classes | PascalCase | `SessionManager`, `PermissionEngine` |
| Backend files | PascalCase for classes, camelCase for modules | `AgentSession.ts`, `queries.ts` |
| WS message types | `snake_case` for the `type` discriminant | `session_started`, `permission_request` |
| SQLite table names | `snake_case`, plural | `sessions`, `session_events` |
| Environment variables | `SCREAMING_SNAKE_CASE` | `NOTION_API_KEY`, `SQLITE_PATH` |
| CSS Modules | camelCase matching component name | `SessionCard.module.css` |

---

## Patterns

### Discriminated union message handling

Use exhaustive switch statements on the `type` discriminant for all WS message routing. TypeScript will catch unhandled cases at compile time if the union is correctly defined.

```typescript
// ws/router.ts
function handleMessage(msg: ClientMessage) {
  switch (msg.type) {
    case 'dispatch': return handleDispatch(msg);
    case 'approve':  return handleApprove(msg);
    case 'deny':     return handleDeny(msg);
    case 'kill':     return handleKill(msg);
    default: {
      const _exhaustive: never = msg;
      throw new Error(`Unhandled message type`);
    }
  }
}
```

### React state driven entirely by WebSocket events

The frontend holds no authoritative state of its own — all state is derived from incoming WebSocket messages. `useSessionStore` is the single hook that owns session state; components only read from it.

```typescript
// hooks/useSessionStore.ts
// Correct: state is updated only on incoming WS events
onMessage(event => {
  const msg: ServerMessage = JSON.parse(event.data);
  dispatch(msg); // reducer updates state
});

// Wrong: mutating local state optimistically without a WS event
setSessions(prev => [...prev, newSession]); // do not do this
```

### SQLite queries are typed and centralised

All database access goes through `db/queries.ts`. No raw SQL strings outside this file.

```typescript
// db/queries.ts — correct
export function insertSessionEvent(event: SessionEvent): void {
  stmtInsertEvent.run(event);
}

// AgentSession.ts — correct
import { insertSessionEvent } from '../db/queries';

// AgentSession.ts — wrong: inline SQL
db.prepare('INSERT INTO session_events ...').run(...);
```

### Environment variables

All environment variables are read once at startup in a single `config.ts` module and exported as typed constants. No `process.env` access elsewhere in the codebase.

```typescript
// config.ts
export const config = {
  notionApiKey: requireEnv('NOTION_API_KEY'),
  sqlitePath:   process.env.SQLITE_PATH ?? './data/dashboard.db',
  port:         Number(process.env.PORT ?? 3000),
};
```

---

## Git etiquette

### Branch naming

| Type | Pattern | Example |
|---|---|---|
| Feature | `feature/<task-name>` | `feature/session-manager-core` |
| Bug fix | `fix/<short-description>` | `fix/ws-reconnect-loop` |
| Chore / tooling | `chore/<short-description>` | `chore/update-tsconfig-strict` |

All branches cut from `dev`. Never from `main`.

### Commit message format

Use Conventional Commits: `<type>(<scope>): <short description>`

| Type | When to use |
|---|---|
| `feat` | New functionality |
| `fix` | Bug fix |
| `chore` | Tooling, config, scaffolding |
| `test` | Adding or updating tests |
| `refactor` | Restructuring without behaviour change |
| `docs` | Comments, README, `CLAUDE.md` |

Examples:

```
feat(backend): add PermissionEngine with deny/allow/escalate tiers
fix(frontend): prevent duplicate session cards on WS reconnect
chore(db): add migration runner to schema.ts
```

- Subject line: imperative mood, ≤72 chars, no trailing period
- Body (optional): explain *why*, not *what*
- Reference task: append `Refs: <task page URL>` in the body

### PR expectations

- Title mirrors the primary commit subject
- Description: what was done (1–3 sentences) + link to the task page + decisions made or deferred
- PRs target `dev`, never `main`
- Claude Code opens PRs as **draft** — human reviews and promotes to ready
- Claude Code must never merge its own PRs
- Keep PRs small and focused — one task per PR
- **Human review is mandatory before any merge, without exception.**

### Merge strategy

- `feature/*` → `dev`: squash merge
- `dev` → `main`: merge commit

---

## Claude Code behaviour rules

These rules apply to every Claude Code session without exception.

### Session start (mandatory)

1. Fetch the project's master context page (linked in `CLAUDE.md`).
2. Fetch this Coding Guidelines page.
3. Fetch the active task board. Filter to `🔄 In Progress` or `🗂️ Ready`.
4. Fetch the assigned task's detail page for full context and acceptance criteria.
5. Do not write any code until steps 1–4 are complete.

### Task lifecycle rules

| Action | When |
|---|---|
| Move task to **🔄 In Progress** | When you begin implementation |
| Move task to **👀 In Review** | When you open a draft PR |
| Move task to **🚫 Blocked** | When you cannot proceed — document the blocker on the task page |
| **Never** move task to ✅ Done | Done is set by the human after merging only |

### What Claude Code must never do

- Pick up a task not in `🗂️ Ready` or `🔄 In Progress`
- Push directly to `dev` or `main`
- Merge its own PRs
- Mark a task as ✅ Done
- Call the Notion API from the frontend
- Write `process.env` access outside `config.ts`
- Use `any` for WebSocket message payloads
- Implement work outside the scope of the active task
- Modify `CLAUDE.md` without explicit human instruction

### What Claude Code must always do

- Open PRs as **draft** targeting `dev`
- Include the task page URL in the PR description
- Write to SQLite before broadcasting over WebSocket
- Update task status and append to Session Log after completing work
- Run `npm run build` at workspace root and confirm it succeeds before opening a PR

---

## Resolved decisions

| Decision | Resolution |
|---|---|
| CSS approach | CSS Modules. Vite-native, zero extra tooling, scoped per component. Files named `ComponentName.module.css`. |
| Error boundary strategy | Per-component boundaries. Each major component (`SessionCard`, `SessionDetail`, `DispatchModal`, etc.) wraps its own `ErrorBoundary` so failures are isolated and don't cascade to the full UI. |

## Related documentation

- [Product Design](./design.md) — user goals, workflows, UI layout, decisions
- [Technical Architecture](./architecture.md) — implementation details, project structure, data flow
- [Task Writing Guidelines](./task-writing.md) — how to scope and write Notion tasks
