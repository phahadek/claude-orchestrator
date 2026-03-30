# Claude Code Dashboard

## Session bootstrap (follow in order)

**1. Fetch project context first — always.**
https://www.notion.so/REDACTED

**2. Fetch the active task board.**
Link is under "Active Task Board" on the context page. Filter to `🔄 In Progress` or `🗂️ Ready`. Work only on the assigned task.

**3. Fetch child pages only when your task needs them.**
- Product Design Doc: https://www.notion.so/REDACTED
- Technical Architecture: https://www.notion.so/REDACTED
- Dev Setup & Git / Coding Guidelines: see Master File Index on the context page.

## Rules

- Notion is the sole source of truth. Never infer rules from code or git history.
- One task at a time. No scope creep.
- Branch: `feature/<task-name>` from `dev`. Never commit directly to `dev` or `main`.
- When done: mark task ✅ Done, append to Session Log, update Master File Index if pages changed.

## Stack

| Layer | Tech | Path |
|---|---|---|
| Frontend | React + Vite (TS) | `packages/frontend/` |
| Backend | Node.js + Express (TS) | `packages/backend/` |
| Transport | WebSocket (`ws`) | `packages/backend/src/ws/types.ts` |
| Database | SQLite (`better-sqlite3`) | `packages/backend/src/db/schema.ts` |
