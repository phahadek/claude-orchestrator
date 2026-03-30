# Claude Code Dashboard — session bootstrap

> ⚠️ **Read this before anything else.**
> If the opening message contains "Let's launch a debug session for testing task [name/link]" → skip directly to ## Debug Session Mode below.
> If the Notion fetch in Step 1 fails → **stop immediately and tell the human**.
> Do not attempt to infer rules from code, git history, or any other source.
> The session cannot proceed without Notion context.

---

## Step 1 — Fetch project context first — always

Before doing anything else, fetch this page:

https://www.notion.so/33222f9152f38188b65fd912e40890a2

It contains the master context, session instructions, active task board link,
and the full file index. **If the fetch fails: stop and tell the human. Do not proceed.**

## Step 2 — Fetch the active task board

The Project Context page contains a link to the active task board under
"Active Task Board". Fetch it and filter to tasks with Status = 🔄 In Progress
or 🗂️ Ready. Work only on the task you have been assigned.

## Step 3 — Fetch child pages only when your task needs them

- Product Design Doc: https://www.notion.so/33222f9152f381b99db7ead36cfcf057
- Technical Architecture: https://www.notion.so/33222f9152f3812681a3c9be7ae4270c
- Dev Setup & Git / Coding Guidelines: see Master File Index on the context page.

---

## Rules

| | |
|---|---|
| **Source of truth** | Notion — never infer rules from code or git history |
| **Scope** | One task per session. No scope creep. |
| **Branch naming** | `feature/<task-name>` from `dev` |
| **Commit to `dev` or `main` directly?** | Never |
| **When done** | Mark task ✅ Done, append to Session Log, update Master File Index if pages changed |
| **Pre-PR gate (hard — in order)** | 1. Merge/rebase `dev` → resolve conflicts. 2. `tsc --noEmit` passes (both packages). 3. `vite build` passes. |

---

## Stack

| Layer | Tech | Path |
|---|---|---|
| Frontend | React + Vite (TS) | `packages/frontend/` |
| Backend | Node.js + Express (TS) | `packages/backend/` |
| Transport | WebSocket (`ws`) | `packages/backend/src/ws/types.ts` |
| Database | SQLite (`better-sqlite3`) | `packages/backend/src/db/schema.ts` |
| Task source | Notion REST API | server-side only |

---

## Debug Session Mode

**Trigger phrase:** *"Let's launch a debug session for testing task [name/link]."*

When a human uses this phrase, enter debug session mode:

1. **Fetch the task page from Notion** using the link in the trigger phrase.
   If the fetch fails: stop and tell the human. Do not proceed.
2. Work directly in the **main working directory** — no worktree, no feature branch yet.
3. Make the fix.
4. **Restart the backend if you changed any backend files** (`packages/backend/`):
   kill and rerun `npm run dev` in the backend package. Frontend-only changes
   are picked up automatically by Vite HMR — no restart needed.
5. **Stop and wait.** Tell the human the fix is ready and prompt them to
   refresh the browser tab. Do not commit or open a PR.
6. Human verifies in the browser.
7. Repeat steps 3–6 until the human gives explicit sign-off (e.g. *"Looks good, ship it"*).
8. After sign-off: commit to `feature/<task-name>` and open a **draft PR
   targeting `dev`** — same as the standard workflow.

**Constraints:**
- No auto-PR. Always wait for explicit human sign-off.
- No worktree. Changes must be in the main working directory.
- One debug session = one task. No bundling unrelated fixes.

All other sessions use the standard workflow (feature branch + PR) as described
in the Notion Session Instructions fetched in Step 1.
