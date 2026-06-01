# GitHub Task Source Setup Guide

This guide walks you through configuring a GitHub repository as the task backend for Claude Code Orchestrator. Tasks live as GitHub Issues, organized by milestone and labeled for status, type, and priority.

The orchestrator reads issues from a milestone-scoped query and updates their labels as sessions progress through the coding lifecycle. Project and milestone configuration lives in the dashboard's SQLite database — there is no `PROJECTS` env var to edit.

> **Prefer Notion or YAML?** GitHub Issues is one of three task sources. See [`notion-template.md`](notion-template.md) for Notion workspace setup or [`yaml-template.md`](yaml-template.md) for the file-based alternative.

---

## Prerequisites

- A GitHub repository (public or private)
- A GitHub Personal Access Token (PAT) or GitHub App — see [Auth](#auth-github-app-vs-pat) for tradeoffs
- The token set as `GITHUB_TOKEN` in `packages/backend/.env`
- The dashboard running locally (see the [Install guide](install.md))

---

## Label vocabulary

The orchestrator drives task status through labels. Three label axes are required: **Status**, **Type**, and **Priority**. Create all of these in your repository before adding the project.

### Status labels

| Label name      | Recommended color | Meaning                                    |
| --------------- | ----------------- | ------------------------------------------ |
| `status:backlog`     | `#d4d4d4` (grey)  | Defined but not yet validated              |
| `status:ready`       | `#0075ca` (blue)  | Scoped, reviewed, ready to be picked up    |
| `status:in-progress` | `#e4e669` (yellow)| Actively being worked on                   |
| `status:in-review`   | `#fbca04` (gold)  | PR open, awaiting review or merge          |
| `status:done`        | `#0e8a16` (green) | Merged, verified, closed                   |
| `status:blocked`     | `#b60205` (red)   | Cannot proceed (document blocker in body)  |
| `status:deferred`    | `#e4e4e4` (light grey) | Moved out of scope                    |

> **Important:** The dashboard matches these exact label names when deriving task display status. Use them exactly as shown — prefix included.

### Type labels

| Label name       | Recommended color | Meaning                                     |
| ---------------- | ----------------- | ------------------------------------------- |
| `type:code`      | `#5319e7` (purple)| Has a PR. Default for implementation tasks. |
| `type:planning`  | `#0075ca` (blue)  | Design or research task — not dispatchable. |
| `type:testing`   | `#f9d0c4` (peach) | Manual test task — not dispatchable.        |

### Priority labels

| Label name         | Recommended color | Meaning                                        |
| ------------------ | ----------------- | ---------------------------------------------- |
| `priority:high`    | `#b60205` (red)   | Blocks other tasks or is on the critical path  |
| `priority:medium`  | `#e4e669` (yellow)| Important but not blocking                     |
| `priority:low`     | `#0e8a16` (green) | Nice to have in this milestone                 |

---

## Issue body structure

Each task is a GitHub Issue. The issue body mirrors the section layout from [`task-writing.md`](task-writing.md):

```markdown
## Summary

One sentence: what is being built and why.

## Dependencies

Depends on: #12 #15

## Context

Design rationale, implementation spec, code skeletons, constraints.

## Acceptance Criteria

### 🤖 Automated tests

- [ ] Compiler passes (`tsc --noEmit`)
- [ ] Unit tests pass
- [ ] [specific test assertions]

### 👁️ Manual verification

- [ ] [runtime behavior checks]

## Files / paths affected

- `path/to/file.ts` _(new — description)_
- `path/to/other.ts` _(update — description)_

## Implementation notes

> To be filled in during/after implementation.
```

### Depends-On encoding

Dependencies are declared as a single line in the **Dependencies** section:

```
Depends on: #12 #15
```

- The line must start with `Depends on:` (case-insensitive).
- Each dependency is a `#N` reference to another issue number in the same repository.
- The orchestrator parses this line at fetch time to resolve dependency order.
- A task with unresolved dependencies (a dependency not yet `status:done`) is shown as blocked in the Tasks panel and cannot be dispatched.

If a task has no dependencies, write:

```
Depends on: none
```

---

## Milestone semantics

GitHub milestones map **1:1 to milestone-level filters** in the dashboard.

- Each milestone in the dashboard corresponds to one GitHub milestone.
- When you add a milestone in **Settings → Milestones**, set the **Milestone ID** to the GitHub milestone number (the integer in the milestone URL, e.g. `1` for `https://github.com/owner/repo/milestone/1`).
- The orchestrator fetches all open issues assigned to that milestone.
- Closing a GitHub milestone does **not** automatically close issues — close issues individually when they reach `status:done`.

> **One milestone per phase.** Keep milestones scoped to a logical release unit or sprint. The dashboard's milestone selector remembers the active milestone per project per browser, so switching is cheap.

---

## Manual Verification Gate

The Manual Verification Gate is a `type:testing` issue that acts as a wave checkpoint at the end of each milestone or logical task cluster. It is not dispatchable.

### Format

Create an issue with:

- **Title:** `Manual Verification Gate — M<N>`
- **Labels:** `type:testing`, `status:ready`, `priority:high`
- **Milestone:** the milestone it gates
- **Body:**

```markdown
## Summary

Manual verification checkpoint for M<N>. Run after all Wave N code tasks are merged.

## Dependencies

Depends on: #<code-task-1> #<code-task-2> ...

## Context

Do not begin follow-up tasks that depend on confirmed behaviour until this gate passes.

## Acceptance Criteria

### 🤖 Automated tests

N/A — manual verification task only.

### 👁️ Manual verification

- [ ] Dashboard loads at http://localhost:5173
- [ ] [milestone-specific runtime checks]

## Files / paths affected

None.

## Implementation notes

> Record pass/fail per item and link to any follow-up bug tasks created.
```

The native GitHub Markdown task list (`- [ ]`) renders as interactive checkboxes on the issue page — check them off as you verify each item.

---

## Auth: GitHub App vs PAT

The orchestrator needs read/write access to issues and labels for the repository. Two options:

### Personal Access Token (PAT)

**Easiest to set up.** Create a fine-grained PAT at **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**:

- **Repository access:** select the specific repo (or all repos if managing multiple projects)
- **Permissions:**
  - Issues: **Read and write** (read tasks, update labels/status)
  - Metadata: **Read-only** (required baseline)
  - Pull requests: **Read and write** (PR tracking and merge)

Set the token as `GITHUB_TOKEN` in `packages/backend/.env`. PATs expire — set a reminder to rotate before the expiry date.

**Tradeoffs:**
- ✅ Simple: one token, no app registration
- ✅ Works immediately with no callback URL
- ❌ Tied to a personal account — if the account loses access, the integration breaks
- ❌ Requires manual rotation on expiry

### GitHub App

**Better for teams or long-running setups.** Create a GitHub App at **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Permissions:**
  - Issues: Read & write
  - Pull requests: Read & write
  - Contents: Read (for PR file listings)
- Install the app on the target repository and generate a private key.

The orchestrator uses the app's private key to mint short-lived installation tokens automatically — no manual rotation needed.

**Tradeoffs:**
- ✅ No expiry: tokens are auto-refreshed
- ✅ Not tied to a personal account
- ❌ More setup: app registration, private key file, installation ID
- ❌ Requires `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, and `GITHUB_INSTALLATION_ID` env vars instead of a single token

> **Recommendation:** Use a PAT for solo projects and short evaluations. Use a GitHub App if the orchestrator will run unattended or is shared across a team.

---

## One-time repo bootstrap

Run these steps once when adding a new GitHub-backed project.

### Step 1: Create labels

Use the GitHub CLI (`gh`) or the Labels API to create all required labels. Quickest path with `gh`:

```bash
# Status labels
gh label create "status:backlog"     --color "d4d4d4" --description "Defined but not yet validated" --repo owner/repo
gh label create "status:ready"       --color "0075ca" --description "Scoped and ready to be picked up" --repo owner/repo
gh label create "status:in-progress" --color "e4e669" --description "Actively being worked on" --repo owner/repo
gh label create "status:in-review"   --color "fbca04" --description "PR open, awaiting review or merge" --repo owner/repo
gh label create "status:done"        --color "0e8a16" --description "Merged, verified, closed" --repo owner/repo
gh label create "status:blocked"     --color "b60205" --description "Cannot proceed" --repo owner/repo
gh label create "status:deferred"    --color "e4e4e4" --description "Moved out of scope" --repo owner/repo

# Type labels
gh label create "type:code"     --color "5319e7" --description "Has a PR" --repo owner/repo
gh label create "type:planning" --color "0075ca" --description "Design or research, not dispatchable" --repo owner/repo
gh label create "type:testing"  --color "f9d0c4" --description "Manual test task, not dispatchable" --repo owner/repo

# Priority labels
gh label create "priority:high"   --color "b60205" --description "Blocks other tasks" --repo owner/repo
gh label create "priority:medium" --color "e4e669" --description "Important but not blocking" --repo owner/repo
gh label create "priority:low"    --color "0e8a16" --description "Nice to have" --repo owner/repo
```

Replace `owner/repo` with your repository.

### Step 2: Create a starter milestone

```bash
gh api repos/owner/repo/milestones \
  --method POST \
  --field title="M1 — MVP" \
  --field description="First milestone" \
  --field state="open"
```

Note the milestone number from the response (e.g. `1`). Use this number when adding the milestone in the dashboard.

### Step 3: Add the project from the dashboard UI

1. Open the dashboard → **Settings → Projects → Add project**.
2. Fill in:
   - **Name** — display name shown in the project switcher.
   - **Project directory** — absolute path to the local repo.
   - **GitHub repo** — `owner/repo`.
   - **Task source** — choose **GitHub**.
   - **Context page URL** — optional; paste a URL to a `PROJECT.md` file in the repo (e.g. `https://github.com/owner/repo/blob/main/PROJECT.md`) if you want project context injected into every session. See [Project context opt-in](#project-context-opt-in) below.
3. Save the project.
4. Open **Settings → Milestones → Add milestone**:
   - **Name** — display name (e.g. `M1 — MVP`).
   - **Milestone ID** — the GitHub milestone number from Step 2.

### Step 4: Create your first task

Create a GitHub Issue in the repository with:

- **Title:** verb phrase (e.g. `Implement session replay export`)
- **Labels:** `type:code`, `status:ready`, `priority:medium`
- **Milestone:** assigned to M1
- **Body:** following the [issue body structure](#issue-body-structure) above

The issue appears in the Tasks panel immediately. Click **Dispatch** to spawn a Claude session.

---

## Project context opt-in

GitHub-backed projects can optionally include a `PROJECT.md` file in the repository root. The orchestrator fetches this file at the start of every session and appends it to the injected `CLAUDE.md`.

Use `PROJECT.md` for:

- Project summary and current milestone
- Session workflow conventions (branch naming, PR requirements, pre-merge checks)
- Links to design docs, architecture references, coding guidelines

If no Context page URL is configured for the project, no external fetch is made — the session proceeds with the task body and orchestrator rules only.

---

## Step 5: Verify

1. The Tasks panel loads issues from the active milestone.
2. Issues show correct status, priority, and type.
3. Dispatching a `🗂️ Ready` task moves the `status:ready` label to `status:in-progress`.
4. Opening a PR moves the issue to `status:in-review`.

If tasks don't appear, check the backend log for GitHub API errors — the most common cause is an incorrect milestone number or a missing `GITHUB_TOKEN`.

---

## Status lifecycle

```
status:backlog → status:ready → status:in-progress → status:in-review → status:done
                                        |                                      ^
                                        v                                      |
                                  status:blocked -------[unblocked]------------+
```

- New tasks always start at `status:backlog`
- Move to `status:ready` only after human review confirms scope
- The orchestrator handles `status:in-progress` and `status:in-review` transitions automatically by swapping labels
- `status:done` is set after PR merge
