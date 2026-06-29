# Jira Task Writing Guidelines

Guidelines for writing well-scoped, implementation-ready tasks on a **Jira-backed**
project. This is the Jira peer of [`task-writing.md`](./task-writing.md) — follow it
when creating Jira issues the orchestrator will dispatch.

> **Configuring Jira, not writing a task?** This page is about _authoring_ good
> tasks. For Jira _setup_ — auth, issue-type/status mappings, `ready_statuses`,
> `epic_field`, and project bootstrap — see [`jira-template.md`](./jira-template.md).

---

## Core principles

1. **One issue = one session.** If it takes more than ~2 hours of focused coding, split it into multiple issues (or sub-tasks).
2. **The implementing session should make no design decisions.** All decisions belong in the issue Description. Ambiguity causes scope creep.
3. **The Description is the spec.** Issue fields (type, status, priority) are metadata. Everything a session needs lives in the Description — not in comments, not in attachments.
4. **Jira has no "Notes" field.** Where the Notion flow uses a one-line human-only Notes field, on Jira put a one-line human flag in a **comment** if one is genuinely needed, or omit it. Never put the spec in a comment.

---

## Required Description sections (in order)

Every issue Description must have these sections in order, written in Jira wiki
markup (`h2.` / `h3.`). See [`jira-template.md` → Issue body structure](./jira-template.md#issue-body-structure)
for the copy-paste skeleton.

- **Summary** — one sentence: what is being built and why. No implementation detail.
- **Dependencies** — the issues this one is `is blocked by` (by key), or `None — Wave 1.`
- **Context** — the "why" and the spec: code skeletons, signatures, field names, file paths, explicit constraints. Write skeletons, not essays.
- **Acceptance Criteria** — two mandatory subsections (same as `task-writing.md`):
  - `h3. 🤖 Automated tests` — compiler/unit/script-verifiable, no human in the loop.
  - `h3. 👁️ Manual verification` — runtime/browser checks. If none (they belong to the gate), write `Covered by the Manual Verification Gate issue.`
- **Files / paths affected** — every file the issue creates/modifies, `(new)` / `(update — …)`.
- **Implementation notes** — leave as `> To be filled in during/after implementation.`

Aim for 5–10 acceptance-criteria items total. Each must be pass/fail without judgment.

---

## Issue fields → orchestrator role

| Jira field      | How the orchestrator reads it                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Summary**     | The task name. Verb phrase: _Implement_, _Add_, _Fix_, _Migrate_. Include the primary file/class.                                                        |
| **Issue type**  | Maps to the orchestrator type via `type_mapping` (default below). Decides **dispatchable vs not**.                                                       |
| **Status**      | Workflow status. `ready_statuses` (default `To Do`, `Ready`) is the dispatch gate. The orchestrator drives In Progress / In Review / Done automatically. |
| **Priority**    | `Highest`/`High` → 🔴, `Medium` → 🟡, `Low`/`Lowest` → 🟢. Display only; does not affect dispatch order.                                                 |
| **Issue links** | `is blocked by` links are the `Depends On` graph (see Dependencies below). Not a custom field.                                                           |

### Type → role: the Story vs Task distinction (load-bearing)

| Jira issue type | Orchestrator type                 | Dispatchable? |
| --------------- | --------------------------------- | ------------- |
| `Story`         | `📋 Planning`                     | No            |
| `Task`          | `💻 Code`                         | Yes           |
| `Sub-task`      | `💻 Code`                         | Yes           |
| `Bug`           | `💻 Code`                         | Yes           |
| `Epic`          | _(excluded — it's the milestone)_ | No            |
| Any other type  | `💻 Code`                         | Yes           |

- **Express standalone implementation work as a `Task`, not a `Story`.** A Story maps to `📋 Planning` and is **never dispatched** — it's a container. If you write code work as a Story, the orchestrator will skip it.
- A **Sub-task** under a scoped, ready Story is fully dispatchable on its own and opens its own PR.
- Use a Story only to group related sub-tasks, or for genuine planning/design work.
- See [`jira-template.md` → Issue types](./jira-template.md#issue-types) for `type_mapping` overrides (e.g. a custom `Tooling` type → `📋 Planning`).

---

## Readiness gate: `Backlog → To Do`

New issues start in **`Backlog`**. Moving an issue to **`To Do`** (any `ready_statuses`
value) is the Jira equivalent of the Notion `Backlog → Ready` groom — it signals the
task is scoped and eligible for dispatch.

An issue moves to `To Do` only after:

1. **Investigation is complete** — for bug fixes, root cause + concrete approach are documented (not "investigate and fix").
2. **All open questions are resolved** — no unresolved design decisions remain.
3. **Acceptance criteria are specific and testable.**
4. **A human has reviewed and confirmed scope.**

> ⚠️ **Don't create issues directly in `To Do` from automation.** Investigation
> sessions and scripts must create issues in `Backlog`; a human moves them to `To Do`.

---

## Dependencies & waves

- Declare a blocker with the built-in **`is blocked by`** issue link (not `relates to`, not `blocks`). The orchestrator reads the **inward** `is blocked by` link as the `Depends On` edge.
- A blocker that is not yet **`Done`** keeps the dependent task **blocked** (shown blocked in the Tasks panel; not dispatched).
- **Sub-tasks inherit their parent Story's blockers** automatically — declare blockers once on the Story; its sub-tasks are blocked implicitly (plus any of their own).
- **Waves** are implicit in the `is blocked by` graph: a wave is a set of issues with no blockers among them; wire the links after the issues exist. See [`jira-template.md` → Depends-On encoding](./jira-template.md#depends-on-encoding).

---

## Milestone = Epic

A dashboard milestone is one Jira **Epic**. Put tasks under the Epic; the orchestrator
scans the Epic's **2-level tree** (direct children + their sub-tasks) for dispatchable,
`ready_statuses` issues. The Epic itself is excluded; nested Epics/Initiatives are **not**
recursed into. See [`jira-template.md` → Milestone semantics](./jira-template.md#milestone-semantics)
for `epic_field` auto-detection (`parent` → `Epic Link` fallback) and overrides.

---

## Status lifecycle mapping

| Orchestrator status | Default Jira status |
| ------------------- | ------------------- |
| `🔲 Backlog`        | `Backlog`           |
| `🗂️ Ready`          | `To Do`             |
| `🔄 In Progress`    | `In Progress`       |
| `👀 In Review`      | `In Review`         |
| `✅ Done`           | `Done`              |

```
Backlog → To Do → In Progress → In Review → Done
  (🔲)     (🗂️)      (🔄)           (👀)       (✅)
```

- New issues start at **`Backlog`**; you move them to **`To Do`** (the readiness gate).
- The orchestrator drives **`In Progress`** (on dispatch) and **`In Review`** (on PR open) automatically; **`Done`** is set after merge.
- **Blocked** is _derived_ from unresolved `is blocked by` links, not a workflow status — you don't set it manually.
- The default mapping covers the five core statuses. If your workflow has extra statuses (e.g. `Blocked`, `Deferred`), map them with `status_mapping` in the project config; otherwise keep the workflow to the five above.

---

## Manual Verification Gate

Manual/runtime checks don't go in code-task Descriptions — they go in one dedicated
gate issue per milestone (or wave cluster):

- **Issue type:** `Story` (→ `📋 Planning`, non-dispatchable).
- **Status:** `To Do` (visible in the Tasks panel, never dispatched).
- **Parent/Epic:** the milestone Epic.

See [`jira-template.md` → Manual Verification Gate](./jira-template.md#manual-verification-gate)
for the full Description skeleton.

---

## Common mistakes to avoid

- **Writing standalone code work as a `Story`.** It maps to Planning and is never dispatched. Use a `Task`.
- **Putting the spec in a comment or attachment.** The Description is the spec; comments are for one-line human flags only.
- **Creating issues directly in `To Do` from automation.** Start in `Backlog`; a human promotes after review.
- **Using the wrong link type for deps.** Only `is blocked by` is read. `relates to` / `blocks` are ignored.
- **Re-declaring a parent's blockers on each sub-task** (or assuming sub-tasks _don't_ inherit them) — they inherit automatically.
- **Expecting recursion into nested Epics/Initiatives.** Only the Epic's 2-level tree is scanned.
- **Vague acceptance criteria / missing file paths / over-scoping** — same universal pitfalls as [`task-writing.md`](./task-writing.md#common-mistakes-to-avoid).

---

## Related documentation

- [Jira Project Setup Guide](./jira-template.md) — auth, issue-type/status mappings, `ready_statuses`, `epic_field`, bootstrap.
- [Task Writing Guidelines](./task-writing.md) — the canonical authoring guide; this page is its Jira peer.
- [Product Design](./design.md) · [Technical Architecture](./architecture.md) · [Coding Guidelines](./coding-guidelines.md).
