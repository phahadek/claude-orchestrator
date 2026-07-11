---
name: wrap
description: >-
  Wrap up a session: scan it for durable information that was produced or decided
  but never persisted to its proper home, surface each item with a proposed home,
  and — on your confirmation — write it there. Use when the user says "wrap",
  "wrap up", "wrap the session", "let's close out", or before ending a long
  working session. Nothing important should die with the session.
---

# Wrap

Long sessions accumulate durable facts — decisions, gotchas, root causes, config locations,
task/status changes, edits discussed-but-not-made — that are easy to leave un-written. Per the
**memory policy** (`procedures.md`), durable context must live in `procedures.md`, a project
`context.md`, Notion, or the code — **never** in per-Claude-Code memory. `/wrap` is the
end-of-session checklist that catches what didn't make it home.

---

## Step 1 — Scan the session

Review this session's transcript for durable items produced or discovered. Look for:

- **Decisions locked** (design / architecture / process) not yet written to Notion or the
  rulebook.
- **Rules / conventions** the human asked to "remember."
- **Gotchas, root causes, non-obvious facts** discovered (a bug's mechanism, where a config
  lives, a fragile invariant).
- **Notion / task changes** made or agreed but not applied (status flips, `Depends On` edits,
  tasks to file).
- **`procedures.md` / `context.md` edits** discussed but never made.
- **Code fixes** identified but neither applied nor filed as a task.

## Step 2 — Classify each item by its correct home

Per the memory policy, propose exactly one home per item:

- **`procedures.md`** — a universal, cross-project rule.
- **project `context.md`** — a per-project fact or specific.
- **Notion** — decisions, task definitions, source-of-truth docs (task page / architecture
  page / project context).
- **the code** — if it's verifiable-in-source and belongs as a change → **file a 🔲 Backlog
  task** (never hand-edit a managed repo from here).
- **drop** — ephemeral; no need to persist. Say so explicitly so it's a choice, not an oversight.

## Step 3 — Present for sign-off

Show a compact table grouped by home: **item → proposed home → the exact text/change** you'd
write. Recommend; don't dump. Keep it skimmable.

## Step 4 — Persist confirmed items

On the human's confirmation, write each item to its home:

- `procedures.md` / `context.md` → `Edit`.
- Notion → the appropriate MCP update/create (new tasks start at **🔲 Backlog** per
  `config/task-writing.md`).
- code → file the 🔲 Backlog task.

**Never silently persist. Never write to per-Claude-Code memory.** If an item's home is
ambiguous, ask rather than guess.

## Step 5 — Report

Summarize what was persisted and where, plus anything the human declined — so every durable
item ends the session either written down or deliberately dropped.
