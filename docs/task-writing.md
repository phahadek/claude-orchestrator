# Task Writing Guidelines

Guidelines for writing well-scoped, implementation-ready tasks. Follow this when creating tasks in any milestone board — whether in a planning session or adding tasks mid-milestone.

---

## Core principles

1. **A task should be completable in one session.** If it takes more than ~2 hours of focused coding to implement, split it.
2. **The implementing session should not need to make any design decisions.** All decisions belong in the task body. Ambiguity causes scope creep.
3. **The page body is the spec.** Properties (Status, Priority, etc.) are metadata. Everything a Claude Code session needs to implement the task lives in the page body.
4. **Notes is for human flags only.** One short sentence, only if a human needs to see something before the session starts. Leave it blank otherwise.

---

## Required sections (in order)

Every task page must have these sections in this order:

### ~~Status~~ _(removed)_

Do **not** include a Status section in the page body. Status lives exclusively in the **Status property** (database metadata). A body Status section duplicates it and creates a maintenance burden — the two fall out of sync as the task progresses.

Existing tasks that still have a Status section can be left as-is; do not add it to any new tasks.

### Summary

One sentence. What is being built and why it matters to the system. No implementation detail here — that belongs in Context.

> ✅ `Implement PermissionEngine — a stateless evaluator that decides allow | deny | escalate for every Agent SDK tool call.`
>
> ❌ `This task is about implementing the permission engine which will be used to evaluate tool calls and decide whether to allow, deny, or escalate them to the user.`

### Dependencies

Bulleted list of task names this task directly depends on. Write `*None — Wave N.*` if there are none. Do not list transitive dependencies — only immediate blockers.

### Context

The "why" and design rationale. Explain what role this piece plays in the larger system, what constraints apply, and any non-obvious decisions. This is also where you put the implementation spec: class structures, method signatures, code skeletons, configuration values, and anything else the implementing session needs.

**Write code skeletons, not essays.** A typed class skeleton with stub methods is more useful than three paragraphs describing what the class should do. Where exact code isn't necessary, be concrete about shapes: field names, return types, event names, file paths.

**Call out constraints explicitly:**

- "No Notion API calls from this file — server-side only"
- "No Godot types anywhere in Simulation/"
- "Stateless — no instance-level caching"

### Acceptance criteria

Checkboxes split into two mandatory subsections — **every task must use both**:

- `### 🤖 Automated tests` — items verifiable by running the compiler, a unit test, or a script. No human in the loop.
- `### 👁️ Manual verification` — items that require a running app, a browser, or observing real runtime behaviour.

If a code task has no manual items (because they belong to the gate), write:
`Covered by the **Manual Verification Gate** task.`

Each item must be independently verifiable — pass/fail must be obvious without judgment calls. Aim for 5–10 items total across both subsections.

> ✅ `- [ ] SIGTERM handler calls shutdownAll() and exits with code 0`
>
> ❌ `- [ ] The server handles shutdowns gracefully`

**Do not put runtime/launch-and-observe items in code tasks.** Those belong exclusively in the Manual Verification Gate task for the milestone (or wave cluster). See the Manual Verification Gate section below.

### Files / paths affected

Bulleted list of every file the task creates or modifies, with `*(new)*` or `*(update X)*` annotations. This helps the implementing session know exactly where to work and prevents accidental scope creep into other files.

### Implementation notes

Always include this section, always leave it empty with `> To be filled in during/after implementation.` The implementing session fills it in — workarounds, deviations from the spec, PR link.

---

## Properties reference

| Property       | Guidance                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task Name**  | Verb phrase starting with an action word: _Implement_, _Scaffold_, _Add_, _Fix_, _Migrate_. Include the primary file or class name.                                                                                                                                                                                                                                                   |
| **Type**       | `💻 Code` for anything with a PR. `📋 Planning` for design/research tasks (non-dispatchable). `🧪 Testing` for manual test tasks (non-dispatchable).                                                                                                                                                                                                                                  |
| **Status**     | See lifecycle below. New tasks always start at `🔲 Backlog`.                                                                                                                                                                                                                                                                                                                          |
| **Priority**   | `🔴 High` = blocks other tasks or is on the critical path. `🟡 Medium` = important but not blocking. `🟢 Low` = nice to have in this milestone.                                                                                                                                                                                                                                       |
| **Depends On** | A Notion Rich Text property storing pipe-delimited page IDs (e.g. `<id1>\|<id2>`). The orchestrator parses this field at fetch time. Rich Text is used instead of a native Relation property because the Notion API's multi-value relation writes via MCP tools are unreliable; see [`notion-template.md`](./notion-template.md#why-rich-text-for-depends-on) for the full rationale. |
| **Notes**      | One short sentence for human attention only. Examples: "Requires M0 Notion migration to be applied first." or "API key must be set before this can be tested." Leave blank otherwise.                                                                                                                                                                                                 |

---

## Status lifecycle

| Value            | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `🔲 Backlog`     | Defined but not yet validated. Default for all new tasks.                     |
| `🗂️ Ready`       | Scoped, reviewed, and ready to be picked up in the next session.              |
| `🔄 In Progress` | Actively being worked on. Only one task should be In Progress at a time.      |
| `👀 In Review`   | Work complete; PR open, awaiting review or merge.                             |
| `✅ Done`        | Merged, verified, and closed.                                                 |
| `🚫 Blocked`     | Cannot proceed — blocker must be documented in Notes.                         |
| `⏭️ Deferred`    | Moved out of this milestone's scope. Add to 🔭 Future Scope if worth keeping. |

New tasks created during planning always start at `🔲 Backlog`. A task moves to `🗂️ Ready` only after:

1. **Investigation is complete** — root cause is identified, relevant code paths traced, and the fix approach is validated.
2. **All open questions are resolved** — no unresolved design decisions or trade-offs remain. If there are OQs, the task stays at Backlog until they're groomed.
3. **Acceptance criteria are specific and testable** — not placeholders like "investigate and fix".
4. **A human has reviewed and confirmed** the scope is correct.

> ⚠️ **Do not create tasks directly at Ready.** Tasks created by automated systems (e.g. orchestrator sessions, investigation sessions) must always start at Backlog. Only a human review moves them to Ready. This prevents under-investigated tasks from being picked up and worked on prematurely.

---

## Dependency waves

When planning a milestone, group tasks into waves before writing them. A wave is a set of tasks that can all be worked in parallel (no dependencies on each other). Wave N+1 depends on Wave N.

Benefits:

- Makes parallelism explicit — multiple sessions can run simultaneously on Wave 1 tasks
- Reveals the critical path — the longest dependency chain is where delays will happen
- Prevents tasks from being written with hidden circular dependencies

Name waves in the task's `Depends On` relation using the task names themselves (not wave numbers) — wave membership is implicit from the graph. The `Depends On` relation must be wired after all tasks are created, since it references other pages in the same board.

---

## Manual Verification Gate

Manual testing items must **not** be scattered across individual code tasks. Each milestone (or logical cluster of code tasks) gets a single dedicated **Manual Verification** task that acts as a wave gate.

### Why

Checking runtime behaviour after each individual code task requires repeated context-switching and re-launching the app. Consolidating into one task makes verification a focused session and keeps the automated/manual split clean inside every code task.

### In code tasks

Include **only** items verifiable without a running app: unit tests, compiler checks, `npm test` / `dotnet test`. Strip all "launch the app and observe" items from the code task's acceptance criteria entirely.

### The Manual Verification task

- **Type**: `🧪 Testing`
- One per milestone, or one per logical cluster if the milestone is large enough to warrant an intermediate check.
- Lists every runtime behaviour item stripped from the code tasks, grouped by source task.
- **`Depends On`**: leave empty. The gate's dependency on all code tasks is implicit from its wave placement and documented in Notes. Wiring every code task ID adds maintenance burden without value.
- **`Notes`**: _"Run after all Wave N code tasks are merged. Do not begin tasks that depend on these outcomes until this passes."_
- **Implementation Notes**: filled in after the session — record pass/fail per item and link to any follow-up bug tasks created.

### Wave placement

The Manual Verification task is always its own wave. Follow-up tasks that depend on confirmed behaviour must list the verification task in their `Depends On`, not just the individual code tasks.

### Acceptance criteria split (mandatory)

Every task — including the Manual Verification task — must use the two-subsection format:

- `### 🤖 Automated tests` — write `N/A — manual verification task only.` if none apply.
- `### 👁️ Manual verification` — all runtime checks live here.

---

## Common mistakes to avoid

**Putting the spec in Notes.** Notes is one sentence for humans. Specs go in the page body under Context.

**Vague acceptance criteria.** "Works correctly" is not a criterion. "`ts-node src/server.ts` starts without errors and logs `listening on port 3000`" is.

**Missing file paths.** Always list every file the task touches. This prevents a session from accidentally editing files it shouldn't.

**Over-scoping.** If the Context section is more than ~3 screens long, the task probably needs to be split. Each split should still be implementable independently.

**Under-specifying interfaces.** If a task produces a class or function that other tasks import, the interface must be fully specified in this task — not left for the implementing session to decide. Type signatures are load-bearing.

**Putting manual/runtime items in code task acceptance criteria.** Any item that requires launching the app, opening a browser, or observing runtime behaviour belongs in the Manual Verification Gate task, not the code task. Code task manual verification sections should read: `Covered by the **Manual Verification Gate** task.`

**Creating tasks at Ready without investigation.** Bug fix tasks require a root cause analysis before they can be marked Ready. A task that says "investigate and fix X" is not Ready — it's Backlog. The investigation must happen first (in a debug/planning session), and the task should be updated with specific findings, file paths, and a concrete fix approach before moving to Ready.

**Skipping open question resolution.** If a task has trade-offs or design decisions that haven't been resolved, it stays at Backlog. Present the options with pros/cons to a human, get a decision, then update the task and move to Ready.

## Related documentation

- [Product Design](./design.md) — user goals, workflows, UI layout, decisions
- [Technical Architecture](./architecture.md) — implementation details, project structure, data flow
- [Coding Guidelines](./coding-guidelines.md) — architectural rules, naming, patterns, git etiquette

For YAML-backed projects, the encoding of these conventions in YAML is documented in [yaml-template.md](./yaml-template.md).

For GitHub-backed projects, the encoding of these conventions on GitHub (label vocabulary, issue body sections, Depends-On syntax, milestone semantics) is documented in [github-template.md](./github-template.md).

For Jira-backed projects, the encoding of these conventions on Jira (issue types, workflow statuses, Story=Planning / Task=Code distinction, Depends-On links, Epic milestone semantics) is documented in [jira-template.md](./jira-template.md), and the Jira-specific authoring guidance — the Jira peer of this page — is in [jira-task-writing.md](./jira-task-writing.md).
