# Notion Workspace Setup Guide

This guide walks you through creating a Notion workspace that Claude Code Orchestrator can use as a task backend, and then connecting that workspace to a project from the dashboard UI.

The orchestrator reads tasks from Notion databases (one per milestone) and updates their status as sessions progress through the coding lifecycle. Project and milestone configuration lives in the dashboard's SQLite database — there is no `PROJECTS` env var to edit.

> **Prefer YAML?** Notion is one of two task sources. If you'd rather keep tasks in version control, see [`tasks.yaml.example`](../tasks.yaml.example) at the repo root and select **YAML** when adding the project. The rest of this guide assumes Notion.

---

## Prerequisites

- A [Notion](https://www.notion.so) account
- A [Notion integration](https://www.notion.so/my-integrations) with read/write access to your workspace
- The integration's API key (starts with `ntn_`) — set as `NOTION_API_KEY` in `packages/backend/.env`
- The dashboard running locally (see the [Install guide](install.md))

---

## Step 1: Create the Project Context page

Create a top-level page in your workspace. This is the master context page that the dashboard fetches at the start of every session.

**Page title:** `[YOUR_PROJECT_NAME]`

Add the following sections to the page body:

### Project Summary

A brief description of your project, its current status, and what milestone you're working on.

### Active Task Board

A callout or paragraph linking to the currently active milestone's task board database (see Step 2). Sessions read this link to find their tasks.

> **Current phase**: [YOUR_MILESTONE_NAME]
>
> **Active task board**: [link to milestone database]

### Session Instructions

Document your session workflow here. The orchestrator injects these instructions into the `CLAUDE.md` file for each coding session. Include:

- Branch naming conventions (e.g., `feature/<task-name>` from `dev`)
- PR requirements (target branch, draft vs. ready)
- Pre-merge checks (type-checking, build, tests)

### Master File Index (optional)

A table linking to child pages (design docs, architecture docs, coding guidelines) so sessions can fetch additional context when needed.

| Page | Purpose |
|---|---|
| Project Context (this page) | Master context, session instructions |
| Product Design Doc | Goals, UI layout, component breakdown |
| Technical Architecture | Tech stack, project structure |
| Coding Guidelines | Conventions, patterns, rules |

---

## Step 2: Create one Task Board database per milestone

Each milestone is a separate Notion **database** (not a page). Create one as a child of the Project Context page, or anywhere else in the workspace your integration has access to.

> **Important — copy the database ID, not the page ID.** When you connect a milestone to the dashboard later, you must paste the **database ID** of the database itself. Pages have IDs too, but they are not interchangeable. Easiest way to get the right ID: open the database as a full page and copy the URL — `https://www.notion.so/<DATABASE_ID>?v=<view-id>`. The 32-character hex string before `?v=` is the database ID.

**Database title:** `[YOUR_MILESTONE_NAME] Task Board`

### Required properties

| Property | Type | Options |
|---|---|---|
| `Task Name` | Title | _(default title column)_ |
| `Status` | Select | See status options below |
| `Type` | Select | `💻 Code`, `📋 Planning`, `🧪 Testing` |
| `Priority` | Select | `🔴 High`, `🟡 Medium`, `🟢 Low` |
| `Depends On` | Rich Text | Pipe-delimited page IDs (e.g., `id1\|id2`) |
| `Notes` | Rich Text | Short human-facing notes |

### Status options

Configure these exact values for the `Status` select property:

| Value | Meaning |
|---|---|
| `🔲 Backlog` | Defined but not yet validated |
| `🗂️ Ready` | Scoped, reviewed, ready to be picked up |
| `🔄 In Progress` | Actively being worked on |
| `👀 In Review` | PR open, awaiting review or merge |
| `✅ Done` | Merged, verified, closed |
| `🚫 Blocked` | Cannot proceed (document blocker in Notes) |
| `⏭️ Deferred` | Moved out of scope |

> **Important:** The dashboard matches these exact status strings (including emoji prefixes) when deriving task display status. Use them exactly as shown.

### Why Rich Text for Depends On?

The Notion API does not support writing multi-value relation properties via MCP tools. The dashboard uses a pipe-delimited string of page IDs as a workaround. The orchestrator parses this field to resolve dependency order.

---

## Step 3: Create task pages

Each task is a page inside a milestone database. Use this template for the page body:

```markdown
## Summary
One sentence: what is being built and why.

## Dependencies
- [Task name this depends on]
- Or: *None -- Wave 1.*

## Context
Design rationale, implementation spec, code skeletons, constraints.

## Acceptance Criteria

### Automated tests
- [ ] Compiler passes (`tsc --noEmit`)
- [ ] Unit tests pass
- [ ] [specific test assertions]

### Manual verification
- [ ] [runtime behavior checks]

## Files / paths affected
- `path/to/file.ts` *(new -- description)*
- `path/to/other.ts` *(update -- description)*

## Implementation notes
> To be filled in during/after implementation.
```

### Task writing best practices

- **One session per task.** If it takes more than ~2 hours, split it.
- **No design decisions left open.** All decisions belong in the task body.
- **Specific acceptance criteria.** "Works correctly" is not testable. "`npm run build` passes without errors" is.
- **List every file.** Prevents sessions from accidentally editing unrelated files.

See also [`task-writing.md`](task-writing.md) for the full task-writing guidelines.

---

## Step 4: Share the workspace with your integration

For each page and database the dashboard needs to read:

1. Open it in Notion.
2. Click **…** (top-right) → **Connections** → add your integration.

Sharing the Project Context page typically propagates to its child pages and databases, but it doesn't always. If the dashboard reports a 404 when fetching a milestone, double-check that the database itself is shared.

---

## Step 5: Add the project from the dashboard UI

With the dashboard running, project and milestone configuration is done entirely in the UI. There is no `PROJECTS` env var to edit and no restart required.

1. Open the dashboard at `http://localhost:5173` (dev) or `http://localhost:3000` (production).
2. Go to **Settings → Projects → Add project**.
3. Fill in:
   - **Name** — display name shown in the project switcher.
   - **Project directory** — absolute path to the local repo this project tracks (sessions are spawned in worktrees under `<projectDir>/.claude/worktrees/`).
   - **GitHub repo** — `owner/repo` for the project's PRs.
   - **Task source** — choose **Notion**.
   - **Context page URL** — the URL of the Project Context page from Step 1.
4. Save the project. The project now appears in the switcher in the top bar.
5. Open **Settings → Milestones → Add milestone** and, for each milestone you want to track:
   - **Name** — display name (e.g. `M1 — MVP`).
   - **Notion database ID** — the database ID from Step 2 (32-character hex, **not** a page ID).
6. The Tasks panel shows the active milestone's tasks. The default active milestone is the first one in display order; once a project has more than one milestone, a milestone selector appears in the header next to the project switcher. The selection is remembered per browser via `localStorage` (key `activeMilestone_<projectId>`) — there is no server-side "Active" flag.

The project record is persisted to the dashboard's SQLite database (`dashboard.db`) and survives restarts. Edit or remove projects and milestones from the same Settings screens at any time.

---

## Step 6: Verify

1. The Tasks panel loads tasks from the active milestone.
2. Tasks show correct status, priority, and type.
3. Launching a session from a `🗂️ Ready` task moves it to `🔄 In Progress`.
4. Opening a PR moves the task to `👀 In Review`.

If tasks don't appear, check the backend log for Notion API errors — the most common causes are an unshared database or a page ID accidentally pasted in place of a database ID.

---

## Page hierarchy reference

```
[YOUR_PROJECT_NAME]                    (Project Context page)
├── Product Design Doc                  (optional)
├── Technical Architecture              (optional)
├── Coding Guidelines                   (optional)
├── Task Writing Guidelines             (optional)
├── [M1] Task Board                     (database — one per milestone)
│   ├── Task 1                          (database page)
│   └── Task 2
├── [M2] Task Board                     (database)
│   └── ...
└── [M3] Task Board                     (database)
    └── ...
```

---

## Status lifecycle

```
Backlog -> Ready -> In Progress -> In Review -> Done
                        |                        ^
                        v                        |
                     Blocked ----[unblocked]------+
```

- New tasks always start at **Backlog**
- Move to **Ready** only after human review confirms scope
- The orchestrator handles **In Progress** and **In Review** transitions automatically
- **Done** is set after PR merge
