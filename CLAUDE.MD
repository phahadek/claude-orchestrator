# Claude Code Dashboard

## Session bootstrap (follow in order)

**⛔ Do NOT write, edit, or delete any code until steps 1–4 are complete.**
**⛔ If any Notion fetch fails, STOP immediately and ask the user for instructions. Do not proceed without Notion context.**

**1. Fetch project context first — always.**
https://www.notion.so/REDACTED

**2. Fetch Coding Guidelines.**
https://www.notion.so/33322f9152f3811ca9e7de3be99c2e06

**3. Fetch the active task board.**
Link is under "Active Task Board" on the context page. Filter to `🔄 In Progress` or `🗂️ Ready`. Work only on the assigned task.

**4. Fetch the assigned task's detail page.**
Read full context, acceptance criteria, and code skeletons before writing anything.

**5. Fetch child pages only when your task needs them.**
- Product Design Doc: https://www.notion.so/REDACTED
- Technical Architecture: https://www.notion.so/REDACTED
- Dev Setup & Git: see Master File Index on the context page.

## Rules

- Notion is the sole source of truth. Never infer rules from code or git history.
- One task at a time. No scope creep.
- Never delete or move existing files unless the task explicitly calls for it. Existing stubs are intentional.
- Branch: `feature/<task-name>` from `dev`. Never commit directly to `dev` or `main`.
- PRs: open as **draft**, target `dev`, include Notion task URL in description. Never merge your own PRs.
- Task lifecycle: move to `🔄 In Progress` at start, `👀 In Review` when PR is opened. Never move to `✅ Done` — only the human does that.
- When done: append to Session Log, update Master File Index if pages changed.

## Stack

| Layer | Tech | Path |
|---|---|---|
| Frontend | React + Vite (TS) | `packages/frontend/` |
| Backend | Node.js + Express (TS) | `packages/backend/` |
| Transport | WebSocket (`ws`) | `packages/backend/src/ws/types.ts` |
| Database | SQLite (`better-sqlite3`) | `packages/backend/src/db/schema.ts` |
