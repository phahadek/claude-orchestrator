# Task Writing — Universal Authoring Standard

> **What this file is.** The single, project-agnostic standard for the **shape of a
> task page body**: what sections a task carries, how to write them, and the bar a
> task must clear before it is marked 🗂️ Ready. It is read by the `/groom` and
> `/design` skills, and by any **remote-control / planning / debug session** that ends
> up authoring a task. Re-open it at the moment you author or update a task — the
> Type, acceptance-criteria split, and Properties rules are reference content, not a
> skim-once summary.
>
> **What it is *not*.** It does not restate the rules that live elsewhere — consult
> those at their source:
> - **`config/procedures.md`** owns the task **lifecycle** (Backlog → Ready → In
>   Progress → In Review → Done), the **Type → who-executes-it** table, the **PR body
>   template + format**, and the **`Depends On` pipe-delimited convention**.
> - **`config/projects/<dir>/context.md`** (and the project's Coding Guidelines /
>   Technical Architecture pages) own the **project-specific slivers**: the verify
>   commands that acceptance criteria invoke, the load-bearing architectural
>   constraints to surface in Context, migration-ID rules, etc.
>
> When this file and a project's `context.md` disagree on a project specific, the
> project wins. When this file and `procedures.md` disagree on a universal rule,
> `procedures.md` wins and this file gets fixed.

---

## Core principles

1. **A task should be completable in one session.** Code/Tooling tasks: ~2 hours of
   focused implementation, ceiling ~500 lines of diff / ~10 files. Design/Planning
   tasks: a single discussion-and-document session that locks the decision. If it
   doesn't fit, split it.
2. **The implementing session should not need to make any design decisions.** Every
   decision belongs in the task body or in an upstream design page it links to.
   Ambiguity causes scope creep.
3. **The page body is the spec.** Properties (Status, Priority, …) are metadata.
   Everything a session needs to do the work lives in the page body.
4. **Notion is the source of truth for decisions.** Tasks reference architecture /
   coding-guideline pages by link, never by paraphrase. If a task disagrees with an
   architecture page, the architecture page wins and the task gets fixed.
5. **Notes is for human flags only.** One short sentence, only if a human needs to
   see something before the session starts. Leave it blank otherwise.
6. **Each task is exactly one Type — no hybrids.** A task is `📐 Design` *or*
   `💻 Code` *or* `🛠️ Tooling`, never two at once. If both spec-locking and
   implementation are needed, that is two tasks: a Design task upstream that closes
   when the spec is locked, then a Code task downstream that implements against it.
   (See `procedures.md` § Task types for what each Type triggers once Ready.)

---

## Required sections (in order)

Every task page carries these sections, in this order. Some vary by Type — noted inline.

### Summary
One sentence: what is being built/decided and why it matters to the system. No
implementation detail — that belongs in Context.

> ✅ *Code:* `Implement PermissionEngine — a stateless evaluator returning allow | deny | escalate for every tool call.`
> ✅ *Design:* `Lock the common ingestion interface — batch vs streaming Protocol shape, payload contract, idempotency layering.`
> ❌ `This task is about the engine which will be used to evaluate tool calls.`

### Dependencies
Bulleted list of the task names this task **directly** depends on (immediate blockers
only, never transitive). Write `*None.*` if there are none. This is the human-readable
mirror; the machine-authoritative dependency list is the **`Depends On`** property
(pipe-delimited page IDs — see `procedures.md`).

### Context
The "why" and the spec.
- **Design/Planning tasks:** the decision space — what is being decided, the options,
  the constraints, what upstream tasks already settled, what downstream tasks consume
  this. Cross-link the architecture page(s) that will be updated.
- **Code/Tooling tasks:** the implementation spec — type signatures, function/class
  skeletons, configuration values, file paths, event names.

**Write code skeletons, not essays.** A typed skeleton with stub bodies beats three
paragraphs describing it. Where exact code isn't needed, be concrete about shapes:
field names, return types, file paths.

**Call out constraints explicitly, inline.** Surface the project's load-bearing
architectural constraints relevant to this task (e.g. layer/purity rules, "no X from
this file", statelessness). The canonical list lives on the project's Coding
Guidelines / Technical Architecture pages — link them; don't paraphrase. If a task
disagrees with one of those constraints, the task is wrong, not the constraint.

### Acceptance criteria
Checkboxes split into two mandatory subsections — **every task uses both**:
- `### 🤖 Automated tests` — items verifiable by the type checker, linter, unit
  tests, or a script, with **no human in the loop**. Use the project's verify
  commands (from its `context.md` / `.claude-orchestrator.yml`). For Design tasks,
  write `*N/A — design task only.*`.
- `### 👁️ Manual verification` — items requiring a running app/pipeline, a browser,
  observed runtime behaviour, or a human read-through of an updated Notion page (for
  Design tasks).

Each item must be independently verifiable — pass/fail obvious without judgment.
Aim for **5–10 items total** across both subsections.

> ✅ *Code:* `SIGTERM handler calls shutdownAll() and exits with code 0`
> ✅ *Design:* `Technical Architecture page has a 'Common Ingestion Interface' section naming both Protocol signatures.`
> ❌ `The server handles shutdowns gracefully`

**Code/Tooling tasks must not put runtime/launch-and-observe items in their own
acceptance criteria** — those belong to the milestone's **Manual Verification Gate**
task (below). A Code task's manual-verification subsection reads:
`Covered by the **Manual Verification Gate** task.`

### Notion pages affected *(Design/Planning tasks only)*
Bulleted list of every Notion page this task creates or edits, with `*(new)*` or
`*(update — Section name)*`. The acceptance criteria reference these pages.

### Files / paths affected *(Code/Tooling tasks only)*
Bulleted list of every file the task creates or modifies, with `*(new)*` or
`*(update)*`. Lets the implementing session know exactly where to work and prevents
scope creep into other files.

### Implementation notes
Always present, always created empty: `> To be filled in during/after task completion.`
The implementing session fills it — workarounds, deviations, PR link (Code), final
decision summary (Design).

---

## Properties guidance

`procedures.md` is authoritative for **Type semantics** (which Type auto-dispatches vs
runs interactively) and the **`Depends On`** convention. This is the authoring summary:

| Property | Guidance |
| --- | --- |
| **Task Name** | Verb phrase starting with an action word (*Implement, Scaffold, Add, Fix, Migrate, Lock*). Include the primary file/class/decision. |
| **Type** | One of `💻 Code` / `📐 Design` / `📋 Planning` / `🛠️ Tooling` / `🧪 Testing` / `📝 Docs` / `🎨 Assets`. Exactly one. See `procedures.md` § Task types. |
| **Priority** | `🔴 High` = blocks others / on the critical path. `🟡 Medium` = important, not blocking. `🟢 Low` = nice-to-have this milestone. |
| **Status** | New tasks always start at `🔲 Backlog`. See Readiness gate below, and `procedures.md` § Status values for the full set (incl. the rare, orchestrator-set `🚫 Blocked`). |
| **Depends On** | Pipe-delimited page IDs of *direct* dependencies, machine-consumed. Blank if none. The body `## Dependencies` section is its human-readable mirror. |
| **Notes** | One short human-facing sentence, or blank. |

---

## Readiness gate — Backlog → Ready

New tasks start at `🔲 Backlog`. A task moves to `🗂️ Ready` only after **all** hold:

1. **Investigation is complete** — design space mapped (or root cause traced for a
   bug), constraints identified, relevant code paths / upstream decisions read.
2. **All open questions are resolved** — no unresolved trade-off remains. If the body
   has an `## Open questions` section (or a `> ⚠️ Open question:` callout), it is by
   definition not Ready.
3. **Acceptance criteria are specific and testable** — not `investigate and decide`.
4. **No deferred decisions in the body.** "Decide at implementation time," "TBD by
   impl session," "implementer chooses" are Backlog-class — this is the operational
   line between Backlog and Ready. *(Carve-out: a 📋 Planning task's job is to produce
   decisions; its readiness is about its own scope/method being clear, not about the
   questions it will answer being pre-resolved.)*
5. **A human has reviewed and confirmed** the scope.

> ⚠️ **Never create a task directly at Ready.** Tasks created by any automated or
> investigation session start at Backlog; only a human review promotes them. Marking
> a 💻 Code task Ready is a live action — the orchestrator auto-dispatches it — so an
> under-investigated Ready task becomes a broken worktree, not a review comment. This
> is enforced by the `check-task-status.mjs` PreToolUse hook.

For the procedure that applies this gate across a milestone's backlog, that is the
**`/groom` skill** — the single source of truth for the grooming procedure (there is
no Notion grooming-procedure page).

---

## Manual Verification Gate

Runtime/manual checks must **not** be scattered across code tasks. Each milestone (or
logical cluster of code tasks) gets one dedicated **Manual Verification** task acting
as a gate.

- **Why:** checking runtime behaviour after every code task means repeated
  context-switching and re-launching. One focused gate keeps the automated/manual
  split clean inside every code task.
- **In code tasks:** include only what's verifiable without a running app (type
  check, lint, unit tests, build). Strip every "launch and observe" item.
- **The gate task:** Type `🧪 Testing`; one per milestone (or per cluster); lists every
  runtime item stripped from the code tasks, grouped by source task. Leave `Depends
  On` empty (the dependency on all code tasks is implicit; documented in Notes:
  *"Run after all upstream code tasks are merged."*). Implementation Notes record
  pass/fail per item + links to any follow-up bug tasks.
- **Placement:** at the end of its cluster. Follow-up tasks that depend on confirmed
  runtime behaviour list the gate task in `Depends On`, not the individual code tasks.
- **Acceptance criteria:** still uses the two-subsection format — `### 🤖 Automated
  tests` reads `*N/A — manual verification task only.*`; all runtime checks live under
  `### 👁️ Manual verification`.

---

## Common mistakes to avoid

- **Putting the spec in Notes.** Notes is one human-facing sentence. Specs go in Context.
- **Vague acceptance criteria.** "Works correctly" is not a criterion; a concrete
  command-and-expected-output is.
- **Missing file paths (code) / page references (design).** A code task that doesn't
  list the files it touches, or a design task that doesn't name the pages it updates,
  is under-specified.
- **Over-scoping.** If Context runs more than ~3 screens, the task probably needs
  splitting. Each split must still be implementable independently.
- **Under-specifying interfaces.** If a task produces a class/function other tasks
  import, fully specify the signature here — type signatures are load-bearing.
- **Runtime items in code-task acceptance criteria.** They belong in the Manual
  Verification Gate task.
- **Creating tasks at Ready without investigation.** "Investigate and fix X" is
  Backlog, not Ready — do the root-cause analysis first, then specify the fix.
- **Skipping open-question resolution.** Trade-offs unresolved → stays Backlog.
  Present options with pros/cons, get a human decision, then move to Ready.
- **Deferring investigation to the implementing session.** "Decide during
  implementation" pushes a design decision onto a session with neither the context nor
  the mandate to resolve it. Resolve in grooming.
- **Disagreeing silently with an architecture page.** If a task contradicts a locked
  decision, fix the task — or open a separate Design task to revisit the decision.
  Never quietly diverge.
- **Including an Out-of-Scope section in the body.** Out-of-scope is a grooming-time
  concern. If a constraint must reach the implementing session, fold it into Context
  as an inline constraint; otherwise leave it out.

---

## Per-project additions

A project may extend this standard with slivers that only make sense for it — verify
commands invoked by acceptance criteria, the load-bearing architectural constraints to
surface in Context, migration-ID declaration rules, extra Type conventions. Those live
in the project's **`context.md`** and its Coding Guidelines / Technical Architecture
pages, never copied back into this file.
