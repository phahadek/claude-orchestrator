# Jira Project Setup Guide

This guide walks you through configuring a Jira project as the task backend for Claude Code Orchestrator. Tasks live as Jira issues organized by Epic and dispatched by workflow status.

The orchestrator reads issues from an Epic's issue tree and transitions their status as sessions progress through the coding lifecycle. Project and milestone configuration lives in the dashboard's SQLite database — there is no `PROJECTS` env var to edit.

> **Prefer Notion, GitHub, or YAML?** Jira is one of four task sources. See [`notion-template.md`](notion-template.md), [`github-template.md`](github-template.md), or [`yaml-template.md`](yaml-template.md) for the other backends.

> **Writing a task, not configuring Jira?** This guide covers Jira _setup_ and the orchestrator's field/status mappings. For how to _author_ a well-scoped orchestrator task on Jira (the Jira peer of [`task-writing.md`](task-writing.md)), see [`jira-task-writing.md`](jira-task-writing.md).

---

## Prerequisites

- A Jira Cloud or Jira Server instance
- A Jira API token (Cloud) or Personal Access Token (Server) — see [Auth](#auth) below
- Three env vars set in `packages/backend/.env` — see [Auth](#auth) below
- The dashboard running locally (see the [Install guide](install.md))

---

## Recommended project setup

### Issue types

The orchestrator maps Jira issue types to its own type vocabulary. The default mapping is:

| Jira issue type | Orchestrator type | Dispatchable? |
| --------------- | ----------------- | ------------- |
| `Story`         | `📋 Planning`     | No            |
| `Task`          | `💻 Code`         | Yes           |
| `Sub-task`      | `💻 Code`         | Yes           |
| `Bug`           | `💻 Code`         | Yes           |
| `Epic`          | _(excluded)_      | No            |
| Any other type  | `💻 Code`         | Yes           |

**Key distinction — Story vs Task:**

- **Story** maps to `📋 Planning` (non-dispatchable). Use it as a container for a body of work: group sub-tasks under it but do not dispatch the Story itself. The orchestrator skips it.
- **Task** (and **Sub-task**, **Bug**) maps to `💻 Code` (dispatchable). Express standalone implementation work as a Task, not a Story. A Sub-task under a Story that has been scoped and ready is fully dispatchable on its own.

> **Tooling tasks (🛠️ Tooling):** If your project uses a custom `Tooling` issue type, add `Tooling: '📋 Planning'` to `type_mapping` in the project config to treat it as non-launchable.

You can override the type map per project by setting `type_mapping` in the dashboard project settings.

### Workflow statuses

Configure your Jira project's workflow to include these statuses. The default mapping is:

| Orchestrator status | Default Jira status |
| ------------------- | ------------------- |
| `🔲 Backlog`        | `Backlog`           |
| `🗂️ Ready`          | `To Do`             |
| `🔄 In Progress`    | `In Progress`       |
| `👀 In Review`      | `In Review`         |
| `✅ Done`           | `Done`              |

> **Important:** The orchestrator matches status names case-insensitively. Use the exact Jira status names shown above, or override them via `status_mapping` in the project config.

### Readiness gate

The orchestrator dispatches tasks whose status is in `ready_statuses`. The default set is **`['To Do', 'Ready']`**. Moving an issue from `Backlog` → `To Do` (or `Ready`) is the Jira equivalent of the Notion `Backlog → Ready` groom — it signals that the task is scoped and ready for a session.

You can override `ready_statuses` per project in the dashboard project settings.

---

## Issue body structure

Each Jira issue's **Description** field is the task spec. Write it in Jira wiki markup or Jira's rich-text editor following the same section layout as [`task-writing.md`](task-writing.md):

```
h2. Summary

One sentence: what is being built and why.

h2. Dependencies

- Depends on PROJ-12, PROJ-15
- Or: None — Wave 1.

h2. Context

Design rationale, implementation spec, code skeletons, constraints.

h2. Acceptance Criteria

h3. 🤖 Automated tests

- [ ] Compiler passes (tsc --noEmit)
- [ ] Unit tests pass

h3. 👁️ Manual verification

- [ ] [runtime behavior checks]

h2. Files / paths affected

- path/to/file.ts (new — description)
- path/to/other.ts (update — description)

h2. Implementation notes

> To be filled in during/after implementation.
```

The orchestrator reads the Description as plain text and injects it into each session's `CLAUDE.md`.

---

## Depends-On encoding

Dependencies between issues are declared using Jira's built-in **issue link** type. The orchestrator resolves blockers by reading the `is blocked by` inward link:

1. In the issue, click **Link issue** (or the equivalent in your Jira version).
2. Choose the link type **"is blocked by"**.
3. Select the blocking issue.

The orchestrator reads all `is blocked by` links at fetch time and treats them as the `Depends On` list. A task with unresolved blockers (a blocker not yet `✅ Done`) is shown as blocked in the Tasks panel and cannot be dispatched.

**Sub-task blocker inheritance:** A Sub-task automatically inherits its parent Story's `is blocked by` links in addition to its own. You only need to declare blockers on the Story; its sub-tasks are blocked implicitly.

> **No custom field required.** Dependencies use the native Jira issue link mechanism — no custom field configuration is needed.

---

## Milestone semantics

A **Milestone** in the dashboard corresponds to one Jira **Epic**. When you add a milestone in **Settings → Milestones**, set the **Milestone ID** to the Epic's issue key (e.g. `PROJ-1`).

When the orchestrator fetches ready tasks for a milestone, it scans the Epic's **2-level issue tree**:

1. **Level 1** — direct children of the Epic (Stories, Tasks, Bugs, etc. — Epics excluded).
2. **Level 2** — Sub-tasks of each Level 1 issue (excluding Epics and Sub-tasks at Level 1 to avoid double-fetching).

Both levels are scanned for dispatchable (`💻 Code`) issues in a `ready_statuses` workflow status. Sub-tasks generate their own PRs and are fully independent dispatch targets.

**Epic field auto-detection:** Jira Cloud uses the `parent` JQL field for Epic children; older Jira Server versions use a legacy `Epic Link` custom field. The orchestrator auto-detects which field works for your instance on the first fetch and caches the result. You can override the detection by setting `epic_field: parent` or `epic_field: 'Epic Link'` in the project config.

> **Sprint or Fix Version milestones:** The orchestrator does not currently use Jira sprints or fix versions as milestones. Use an Epic as the milestone container and put Tasks / Sub-tasks inside it.

---

## Priority mapping

Jira priority names map to the orchestrator's priority vocabulary as follows:

| Jira priority      | Orchestrator priority |
| ------------------ | --------------------- |
| `Highest` / `High` | `🔴 High`             |
| `Medium`           | `🟡 Medium`           |
| `Low` / `Lowest`   | `🟢 Low`              |

Priority is read directly from the issue's `priority.name` field and displayed in the Tasks panel for human reference. It does not affect dispatch order.

---

## Manual Verification Gate

The Manual Verification Gate is a `📋 Planning`-type issue (use issue type `Story` with default mapping) that acts as a wave checkpoint. It is not dispatchable.

Create an issue with:

- **Summary:** `Manual Verification Gate — M<N>`
- **Issue type:** `Story` (maps to `📋 Planning` — non-dispatchable)
- **Status:** `To Do` (so it appears in the task list but can't be dispatched)
- **Priority:** `High`
- **Epic Link / parent:** the milestone Epic
- **Description:**

```
h2. Summary

Manual verification checkpoint for M<N>. Run after all Wave N code tasks are merged.

h2. Dependencies

- Depends on PROJ-<code-task-1>, PROJ-<code-task-2> ...

h2. Context

Do not begin follow-up tasks that depend on confirmed behaviour until this gate passes.

h2. Acceptance Criteria

h3. 🤖 Automated tests

N/A — manual verification task only.

h3. 👁️ Manual verification

- [ ] Dashboard loads at http://localhost:5173
- [ ] [milestone-specific runtime checks]

h2. Files / paths affected

None.

h2. Implementation notes

> Record pass/fail per item and link to any follow-up bug tasks created.
```

Because the Story issue type maps to `📋 Planning`, the orchestrator never dispatches the gate task — it just shows it as a planning item in the Tasks panel.

---

## Auth

### Jira Cloud (API token + email)

1. Generate an API token at **https://id.atlassian.com/manage/api-tokens**.
2. Set three env vars in `packages/backend/.env`:

```env
JIRA_HOST=https://mycompany.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_TOKEN=<your-api-token>
```

The orchestrator uses HTTP Basic auth: `base64(email:token)`.

### Jira Server / Data Center (Personal Access Token)

1. Generate a PAT at **Your profile → Personal Access Tokens** in your Jira Server instance.
2. Set two env vars (omit `JIRA_EMAIL` — the client switches to Bearer auth when email is absent):

```env
JIRA_HOST=https://jira.mycompany.internal
JIRA_TOKEN=<your-PAT>
```

### Required API scopes

The orchestrator uses the following Jira REST API v3 endpoints:

| Endpoint                                   | Purpose                                    |
| ------------------------------------------ | ------------------------------------------ |
| `GET /rest/api/3/issue/{key}`              | Fetch a single issue (task page)           |
| `GET /rest/api/3/issue/{key}/transitions`  | Get available workflow transitions         |
| `POST /rest/api/3/issue/{key}/transitions` | Transition issue status                    |
| `POST /rest/api/3/issue/{key}/comment`     | Attach PR URL as a comment                 |
| `GET /rest/api/3/search?jql=...`           | Search issues (ready tasks, Epic children) |

For Jira Cloud, a standard API token tied to an account with **Project: Browse Projects** and **Issue: Edit Issues** permissions covers all of these. No admin scopes are required.

---

## One-time project bootstrap

Run these steps once when adding a new Jira-backed project.

### Step 1: Configure your Jira project workflow

Ensure your project's workflow includes these status names (or configure `status_mapping` in the dashboard to match your existing statuses):

- `Backlog`
- `To Do`
- `In Progress`
- `In Review`
- `Done`

Add transitions between them as needed. The `Backlog → To Do` transition is the readiness gate — moving an issue to `To Do` makes it eligible for dispatch.

**Required transitions:** The orchestrator applies transitions along the forward path only. At minimum, your Jira workflow must allow:

- `To Do → In Progress` (session start)
- `In Progress → In Review` (PR opened)
- `In Review → Done` (PR merged)

If a required transition is unavailable from the issue's current state, the orchestrator logs a warning and skips the Jira update — it does **not** fail the session. This means a misconfigured workflow results in issues silently staying at the wrong status rather than crashing.

**Orchestrator-only statuses (`🚫 Blocked`, `⏭️ Deferred`):** These are internal orchestrator states only. The orchestrator does **not** attempt a Jira transition for them — the issue remains at its current Jira status. You do **not** need to add `Blocked` or `Deferred` statuses to your Jira workflow.

### Step 2: Create an Epic for your milestone

Create a Jira Epic in the project. Note its issue key (e.g. `PROJ-1`). This is the milestone ID you will use in the dashboard.

### Step 3: Add the project from the dashboard UI

1. Open the dashboard → **Settings → Projects → Add project**.
2. Fill in:
   - **Name** — display name shown in the project switcher.
   - **Project directory** — absolute path to the local repo.
   - **GitHub repo** — `owner/repo` for PR tracking.
   - **Task source** — choose **Jira**.
   - **Context page URL** — optional; paste a URL to a context document if you want project context injected into every session.
3. Save the project.
4. Open **Settings → Milestones → Add milestone**:
   - **Name** — display name (e.g. `M1 — MVP`).
   - **Milestone ID** — the Epic issue key from Step 2 (e.g. `PROJ-1`).

### Step 4: Create your first task

Create a Jira issue in the project with:

- **Summary:** verb phrase (e.g. `Implement session replay export`)
- **Issue type:** `Task`
- **Status:** `To Do`
- **Priority:** `Medium`
- **Epic Link / parent:** assigned to your milestone Epic
- **Description:** following the [issue body structure](#issue-body-structure) above

The issue appears in the Tasks panel immediately. Click **Dispatch** to spawn a Claude session.

---

## Verify

1. The Tasks panel loads issues from the active milestone Epic.
2. Issues show correct status, priority, and type.
3. Dispatching a `🗂️ Ready` task transitions it to `🔄 In Progress` in Jira.
4. Opening a PR transitions the issue to `👀 In Review`.

If tasks don't appear, check the backend log for Jira API errors — the most common causes are an incorrect Epic key, missing `JIRA_TOKEN`, or a workflow that doesn't include the expected status names.

---

## Status lifecycle

```
Backlog → To Do → In Progress → In Review → Done
  (🔲)     (🗂️)      (🔄)           (👀)       (✅)
```

- New tasks always start at **Backlog** (`🔲`)
- Move to **To Do** only after human review confirms scope (this is the readiness gate)
- The orchestrator handles **In Progress** and **In Review** transitions automatically
- **Done** is set after PR merge

**Orchestrator-only states (not written to Jira):**

| Orchestrator status | Jira behavior                                               |
| ------------------- | ----------------------------------------------------------- |
| `🚫 Blocked`        | No Jira transition — issue stays at its current Jira status |
| `⏭️ Deferred`       | No Jira transition — issue stays at its current Jira status |

These states exist purely inside the orchestrator dashboard. No Jira status or transition is needed for them.

**Resilience:** If the orchestrator cannot find a direct transition to the target status (e.g. a workflow gap), it checks whether the issue is already in that status (in which case it's a no-op) and otherwise logs a warning and continues — it never fails the session due to a missing Jira transition.
