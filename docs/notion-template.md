# Notion Workspace Setup Guide

This guide walks you through creating a Notion workspace that the Claude Code Dashboard can use as a task backend. The dashboard reads tasks from Notion databases and updates their status as sessions progress through the coding lifecycle.

---

## Prerequisites

- A [Notion](https://www.notion.so) account
- A [Notion integration](https://www.notion.so/my-integrations) with read/write access to your workspace
- The integration's API key (starts with `ntn_`)

---

## Step 1: Create the Project Context page

Create a top-level page in your workspace. This is the master context page that the dashboard fetches at the start of every session.

**Page title:** `[YOUR_PROJECT_NAME]`

Add the following sections to the page body:

### Project Summary

A brief description of your project, its current status, and what milestone you're working on.

### Active Task Board

A callout or paragraph linking to the task board database (created in Step 2). The dashboard looks for this link to find your tasks.

> **Current phase**: [YOUR_MILESTONE_NAME]
>
> **Active task board**: [link to task board database]

### Session Instructions

Document your session workflow here. The dashboard's orchestrator injects these instructions into the `CLAUDE.md` file for each coding session. Include:

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

## Step 2: Create a Task Board database

Create an **inline database** (or a full-page database) as a child of your project context page.

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

Each task is a page inside the task board database. Use this template for the page body:

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

---

## Step 4: Configure the dashboard

Once your Notion workspace is set up:

1. Copy the **Project Context page ID** from its URL:
   `https://www.notion.so/[YOUR_PAGE_ID]`

2. Copy the **Task Board database ID** from its URL:
   `https://www.notion.so/[YOUR_DATABASE_ID]`

3. Add them to your `packages/backend/.env`:

```env
NOTION_API_KEY=ntn_[YOUR_TOKEN]
PROJECTS=[{"id":"my-project","name":"My Project","projectDir":"/path/to/repo","contextUrl":"https://www.notion.so/[YOUR_PAGE_ID]","boardId":"[YOUR_DATABASE_ID]"}]
```

4. Share the Project Context page and Task Board with your Notion integration (click "..." > "Connections" > add your integration).

---

## Step 5: Verify

Start the dashboard and check:

1. The Tasks panel loads your task board
2. Tasks show correct status, priority, and type
3. Launching a session from a Ready task moves it to In Progress
4. Opening a PR moves the task to In Review

---

## Page hierarchy reference

```
[YOUR_PROJECT_NAME]                    (Project Context page)
├── Product Design Doc                  (optional)
├── Technical Architecture              (optional)
├── Coding Guidelines                   (optional)
├── Task Writing Guidelines             (optional)
└── [Milestone] Task Board              (database)
    ├── Task 1                          (database page)
    ├── Task 2                          (database page)
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
- The dashboard orchestrator handles **In Progress** and **In Review** transitions automatically
- **Done** is set after PR merge
