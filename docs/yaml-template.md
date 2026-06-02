# YAML Task Source Setup Guide

This guide covers how to configure a project to use `tasks.yaml` as its task backend — the file-based alternative to Notion. Tasks live in version control alongside your code, with no external service required.

The orchestrator reads tasks from `<projectDir>/tasks.yaml`, updates their status as sessions progress, and writes back `pr_url` when a PR is opened. All project and milestone configuration still lives in the dashboard's SQLite database.

> **Prefer Notion?** See [`notion-template.md`](notion-template.md) for the Notion workspace setup guide.

---

## Prerequisites

- The dashboard running locally (see the [Install guide](install.md))
- A project added to the dashboard with **Task source: YAML**

---

## Step 1: Create tasks.yaml

Two bootstrap paths are available:

**Option A — copy the example file:**

```bash
cp tasks.yaml.example <projectDir>/tasks.yaml
```

`tasks.yaml.example` lives at the repo root and contains a fully annotated starter file with one milestone and one example task.

**Option B — use the dashboard UI:**

If no `tasks.yaml` exists for a project, the Settings → Projects screen shows a **"Create empty tasks.yaml"** affordance. Clicking it writes a minimal skeleton file to `<projectDir>/tasks.yaml`.

Either way, `tasks.yaml` is gitignored by default (listed in `.gitignore` at the project root). Remove that entry if you want to track tasks in version control.

---

## Step 2: File schema

`tasks.yaml` uses a milestone-keyed schema. Top-level structure:

```yaml
project: # optional
  id: my-project
  name: My Project
milestones:
  - id: m1
    name: 'M1 — MVP'
    tasks:
      - id: task-001
        name: 'Implement feature X'
        status: Ready
        priority: High
        type: Code
        depends_on: []
        pr_url: null
        context: |
          Full implementation spec goes here.
        acceptance_criteria: |
          - [ ] Unit tests pass
          - [ ] tsc --noEmit passes
        files_affected:
          - src/feature.ts (new)
        notes: ''
  - id: m2
    name: 'M2 — Polish'
    tasks: []
```

### Top-level fields

| Field        | Type   | Required | Description                               |
| ------------ | ------ | -------- | ----------------------------------------- |
| `project`    | object | No       | Optional project metadata (`id`, `name`)  |
| `milestones` | array  | Yes      | One or more milestone objects (see below) |

### Milestone fields

| Field   | Type   | Required | Description                                       |
| ------- | ------ | -------- | ------------------------------------------------- |
| `id`    | string | Yes      | Unique identifier; used by the milestone selector |
| `name`  | string | Yes      | Display name shown in the dashboard               |
| `tasks` | array  | Yes      | List of task objects for this milestone           |

### Task fields

| Field                 | Type           | Required | Description                                                       |
| --------------------- | -------------- | -------- | ----------------------------------------------------------------- |
| `id`                  | string         | Yes      | Unique identifier within the file (e.g. `task-001`)               |
| `name`                | string         | Yes      | Task title — shown in the Tasks panel                             |
| `status`              | string         | Yes      | See [Status vocabulary](#status-vocabulary)                       |
| `priority`            | string         | No       | See [Priority vocabulary](#priority-vocabulary)                   |
| `type`                | string         | No       | See [Type vocabulary](#type-vocabulary)                           |
| `depends_on`          | string[]       | No       | IDs of tasks this task depends on (see [Depends On](#depends-on)) |
| `pr_url`              | string or null | No       | PR URL — written automatically by the orchestrator                |
| `context`             | string         | No       | Implementation spec, design rationale, code skeletons             |
| `acceptance_criteria` | string         | No       | Checkboxes or prose; rendered as-is in the session spec           |
| `files_affected`      | string[]       | No       | List of files the task creates or modifies                        |
| `notes`               | string         | No       | Short human-facing note; leave blank otherwise                    |

---

## Step 3: Vocabulary reference

### Status vocabulary

The `status` field must be one of these exact strings (no emoji prefix in the YAML — the dashboard adds display formatting):

| YAML value    | Dashboard display | Meaning                                               |
| ------------- | ----------------- | ----------------------------------------------------- |
| `Backlog`     | `🔲 Backlog`      | Defined but not yet validated. Default for new tasks. |
| `Ready`       | `🗂️ Ready`        | Scoped, reviewed, ready to be picked up.              |
| `In Progress` | `🔄 In Progress`  | Actively being worked on.                             |
| `In Review`   | `👀 In Review`    | PR open, awaiting review or merge.                    |
| `Done`        | `✅ Done`         | Merged, verified, closed.                             |

The orchestrator manages `In Progress`, `In Review`, and `Done` transitions automatically by writing back to the file. Set new tasks to `Backlog` or `Ready`.

### Type vocabulary

| YAML value | Dashboard display | Meaning                                     |
| ---------- | ----------------- | ------------------------------------------- |
| `Code`     | `💻 Code`         | Has a PR. Default if omitted.               |
| `Planning` | `📋 Planning`     | Design or research task — not dispatchable. |
| `Testing`  | `🧪 Testing`      | Manual test task — not dispatchable.        |

### Priority vocabulary

| YAML value | Dashboard display | Meaning                                       |
| ---------- | ----------------- | --------------------------------------------- |
| `High`     | `🔴 High`         | Blocks other tasks or is on the critical path |
| `Medium`   | `🟡 Medium`       | Important but not blocking                    |
| `Low`      | `🟢 Low`          | Nice to have in this milestone                |

---

## Depends On

`depends_on` is an array of task `id` strings within the same milestone:

```yaml
- id: task-003
  name: 'Add export button'
  depends_on:
    - task-001
    - task-002
```

The orchestrator resolves dependency order at fetch time. A task with unresolved dependencies (i.e., a dependency not yet `Done`) is shown as blocked in the Tasks panel and cannot be dispatched.

---

## Manual Verification Gate

Manual verification tasks use `type: Testing` and are not dispatchable — they exist to track human test runs after code tasks are merged:

```yaml
- id: mvg-m1
  name: 'Manual Verification Gate — M1'
  status: Ready
  type: Testing
  depends_on:
    - task-001
    - task-002
  context: |
    Verify the following after all M1 code tasks are merged:
    - [ ] Dashboard loads at http://localhost:5173
    - [ ] Tasks panel shows tasks from tasks.yaml
    - [ ] Dispatching a Ready task spawns a session
  acceptance_criteria: ''
  notes: ''
```

---

## Step 4: Add milestones in the dashboard

Once `tasks.yaml` is in place:

1. Open the dashboard → **Settings → Milestones → Add milestone**.
2. Set the **Name** (e.g. `M1 — MVP`) and the **Milestone ID** matching the `id` field in `tasks.yaml` (e.g. `m1`).
3. Repeat for each milestone.

The Tasks panel shows the active milestone's tasks. The default active milestone is the first in display order; a milestone selector appears in the header once a project has more than one.

---

## Step 5: Verify

1. The Tasks panel loads tasks from the active milestone.
2. Tasks show correct status, priority, and type.
3. Dispatching a `🗂️ Ready` task moves it to `🔄 In Progress` in `tasks.yaml`.
4. When the session opens a PR, `pr_url` is written to the task row automatically.

---

## File structure reference

```
<projectDir>/
└── tasks.yaml          # milestone-keyed; gitignored by default
```

```
tasks.yaml
├── project             (optional metadata)
└── milestones[]
    ├── id              (matches dashboard milestone configuration)
    ├── name
    └── tasks[]
        ├── id          (unique within file)
        ├── name
        ├── status      (Backlog | Ready | In Progress | In Review | Done)
        ├── priority    (High | Medium | Low)
        ├── type        (Code | Planning | Testing)
        ├── depends_on  ([] of task id strings)
        ├── pr_url
        ├── context
        ├── acceptance_criteria
        ├── files_affected
        └── notes
```

---

## Status lifecycle

```
Backlog -> Ready -> In Progress -> In Review -> Done
```

- New tasks always start at `Backlog`
- Move to `Ready` only after human review confirms scope
- The orchestrator handles `In Progress` and `In Review` transitions automatically
- `Done` is set after PR merge
