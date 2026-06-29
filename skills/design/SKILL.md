---
name: design
description: >-
  Run a Design Execution session for a milestone. Loads full project context
  deterministically (via design-load.mjs), investigates the open questions in
  each Ready / In-Progress 📐 Design and 📋 Planning task, proposes a thematic
  execution order for human sign-off, then walks each task one open-question at
  a time — debating trade-offs, locking decisions, updating architecture pages,
  and filing follow-on 🔲 Backlog Code tasks. Use when the user says "design",
  "design session", "let's run a design session for milestone X", "execute the
  design tasks", or starts a Design Execution session. Requires a grooming
  manifest in the central config tree (config/projects/<dir>/grooming.json),
  shared with the /groom skill.
---

# Design Execution

Design Execution is the **upstream** sister to grooming. A 📐 Design or 📋 Planning
task arrives with an unresolved decision space; this skill drives that space to a
locked spec, applies the spec into the live architecture pages, and files the
follow-on Code / Tooling tasks that `/groom` will then bring to Ready.

```
📐 Design / 📋 Planning  ──/design──▶  🔲 Backlog Code  ──/groom──▶  🗂️ Ready  ──implement──▶  ✅ Done
```

> **Scope note.** Throughout this skill, _"Design task"_ refers to **both
> 📐 Design and 📋 Planning** tasks — they share the same workflow shape (open
> questions → locked decisions → follow-on Backlog tasks, with or without
> architecture-page edits). The skill targets both types and treats them
> identically. The only material difference in practice: Planning tasks more
> often have an empty `Notion pages affected` list (planning produces task
> sequencing, not architecture lock-ins), which is handled transparently by
> Step 3.4 (the page-edits loop just iterates a possibly-empty list).

This skill exists because the procedure is **load-bearing but routinely improvised**:
under context pressure a session executing a Design task tends to batch-lock
implementation notes mid-discussion, silently widen scope, edit architecture pages
without showing the diff, or call a defer a "resolve." The anti-pattern file already
prescribes the shape (`reference/anti-patterns.md`) — this skill operationalizes it.

**Read `reference/anti-patterns.md` now** — those failure modes are the whole reason
this skill exists. Read `reference/presentation.md` before Step 2, and
`reference/page-edits.md` before any architecture-page write in Step 3.

---

## Step 0 — Resolve manifest & mode

1. Read the repo's grooming manifest from the **central config tree** —
   `<config>/projects/<repo-dir>/grooming.json` (shared with `/groom`; resolved via
   `$ORCHESTRATOR_CONFIG_DIR` / `--config-dir` / a host-aware default). **If it
   is missing, stop** and tell the human (point them at the `/groom` skill's
   `reference/manifest.example.json`). Do not improvise.
2. Note `architectural_control`:
   - `full` → this skill's default behavior (decide-and-rewrite within the rules).
   - `low` → propose-and-route mode. The skill drafts the decision and the page
     edit but does not apply them; instead it routes to the owner via comment /
     sub-task. Same Step-3 cadence; different terminal step.
3. Determine the milestone (from the user, e.g. "design M9"). If it isn't yet
   registered in `manifest.milestones` (routine right after a new milestone board is
   created), the loader no longer dead-ends — it prints a copy-pasteable entry with the
   neighbour auto-filled. Add that entry to the manifest, or pass `--board
<data-source-id>` to run immediately and persist the printed snippet afterward.
   Never improvise a board id — copy it from the board's Notion URL / context.md.
4. Determine **mode** from the cache dir `.skill-cache/design/<milestone>/`:
   - absent → **fresh** design session.
   - present → **resume**: the loader preserves signed-off question decisions and
     applied page edits across runs.

Design Execution runs **interactively in the main repo on `dev`** — never in an
ephemeral implementation worktree (the cache must persist; this skill drives the
human, it does not ship code). Any _implementation_ triggered by a follow-on Code
task is a separate session on its own feature branch, governed by the normal
workflow.

---

## Step 1 — Deterministic load (the script, not you)

Run the loader. **Do not hand-fetch context pages or task bodies yourself** — that
is the step that gets skipped. The script owns it.

```bash
node ~/.claude/scripts/design-load.mjs \
  --milestone <M> \
  --repo <repo-root> \
  --env <manifest.notion_env>
```

If it exits non-zero, **stop** — a partial load means a contaminated session. Report
the error.

On success it has written, under `.skill-cache/design/<milestone>/`:

- `context-bundle.json` — the fixed context pages (bodies in `context/`), the
  target milestone board, neighbour boards, and every non-Done 📐 Design task
  (bodies in `tasks/`).
- `design-worklist.json` — per executable task: parsed `open_questions`,
  `pages_affected`, `depends_on`, `dep_status` (resolved against the board),
  `theme_tags`, `size`. Plus a `blocked` list (Design tasks at 🔲 Backlog that
  need `/groom` first, or whose deps aren't ready).
- `design-state.json` — per-task skeleton (the artifact tracking progress);
  preserved across resumes. Signed-off open questions and applied page edits
  survive; new questions in the task body are appended.

Read the context-page bodies in `context/` — Master Context, Technical Architecture,
Coding Guidelines, Research Goals, Future Scope, Project Milestones. Also read the
universal task-authoring standard at `config/task-writing.md` (no longer a context
page — read it from local disk). **This is non-negotiable**: executing a design task
without the
architectural constraints loaded is how design sessions produce confidently-wrong
decisions that cascade through every Code task that consumes them.

---

## Step 1b — Investigate (cached, judgment where needed)

Each Design task's `open_questions` define what needs deciding. Before presenting
any question in Step 3, do the read-only investigation it implies:

- **Code reads** for any question that turns on what the code actually does. Reuse
  the package-freshness model: dispatch one Explore subagent per stale/missing
  package, write digests to `.skill-cache/design/<milestone>/code-map.json` keyed by
  package path and stamped with the baseline SHA (same shape as grooming's, but a
  separate file — different question).
- **Live API calls** for any question that turns on the shape of an external API.
  `reference/anti-patterns.md` warns against locking an external surface from
  community docs alone; this is the step where that warning binds. Hit the endpoint
  once, cache the observed shape (`.skill-cache/design/<milestone>/api-shapes/`), cite
  the cached shape when presenting the question.
- **Architecture-page reads** for any question that touches a load-bearing
  constraint already locked in an arch page. Cite the page section verbatim when
  the constraint binds.

Keep package reads in subagents so the main window stays small — same reason as
grooming's Step 1b: the procedure must survive context pressure.

If `design-worklist.json` lists any **executable** task whose `dep_status` is
`blocked`, surface it and **stop** — that task isn't actually executable yet. Same
fail-loud posture as `/groom`.

---

## Step 2 — Prioritization proposal

Follow `reference/presentation.md` § **Prioritization**. In short:

- **Hard rule:** `depends_on` chain. Tasks whose deps aren't Done/Ready appear in
  a "Blocked" sub-list, not in the executable order.
- **Heuristic axes** (not hard rules — debate expected):
  1. **Theme cohesion** — group tasks touching the same arch-page area, the same
     `source_root` package, or the same downstream Code-task chain. A cluster of
     decisions lands consistent.
  2. **Size balance** — interleave so the human sees variety, not five 1-question
     tasks before one 6-question task.
- Priority tags (🔴 / 🟡 / 🟢) are a **tiebreaker only**, not the ordering axis.

Present the proposed order grouped by theme with a one-line rationale per group.
End with: _"This is the proposed order — push back, regroup, or approve."_ Debate
is expected and desired; the human reshuffles freely. Do not move to Step 3 until
the order is signed off.

---

## Step 3 — Execute one Design task at a time

Follow `reference/presentation.md` § **Per-question cadence**.

For the current Design task (in the approved order):

1. **Move task to 🔄 In Progress** via `mcp__claude_ai_Notion__notion-update-page`
   (`command: "update_properties"`). Confirm in chat. Stamp
   `design-state.json` → task entry → `moved_to_in_progress_at`.

2. **For each open question, one at a time, in the order written in the task body:**
   - Present the question + the investigation findings from Step 1b + 2–3 viable
     answers with one-line pros/cons + a recommendation.
   - **Invite pushback explicitly.** _"Where am I wrong? Push back."_ The session
     is ready to be wrong; the human is the decider. Iterate as long as the human
     wants to debate.
   - On explicit sign-off, record the locked decision in `design-state.json` →
     `open_questions[i].locked_decision` + `signed_off_at`. **Never batch-lock
     multiple questions in one message.**

3. **Once every question for this task is signed off, compose the Implementation
   notes** for the Design task body:
   - One-paragraph **decision summary** at the top.
   - An **"Open questions resolved"** table if there are ≥2 questions (the
     convention from closed Design tasks in the corpus).
   - A **"Notion pages updated"** list — filled in as Step 3.4 progresses.
   - A **"Follow-on tasks filed"** list — filled in as Step 3.5 progresses.
     Draft inline and show the human before writing to Notion.

4. **For each entry in "Notion pages affected"** — per `reference/page-edits.md`:
   - Fetch the target page via `notion-page.mjs` (full body, not MCP search).
   - Identify the exact section to amend; quote enough context to disambiguate.
   - Compose the exact addition/edit.
   - Present: _"I'm going to update `<page title>` § `<section>` — append after
     this anchor / replace these N lines. Diff below. Okay?"_
   - On sign-off, apply via `notion-update-page`. Stamp `design-state.json` →
     `pages_affected[i].applied_at`. **Never write to a context page silently.**

5. **For each follow-on Code / Tooling task identified during the design:**
   - **Pick the Type deliberately** (it determines downstream execution — see
     `procedures.md` § _Task types — what Ready triggers_). Pure code-generation
     work that does **not** depend on implementation-time data → 💻 **Code** (so the
     orchestrator auto-dispatches it once Ready). Interactive / observational work
     (running a tool, wiring it, inspecting results) → 🛠️ **Tooling** / 🧪 **Testing**.
     If a single follow-on mixes both, **file two tasks** — never bury dispatchable
     code-gen inside a Tooling/Testing task, where no worker will pick it up.
   - Draft the full body inline per `config/task-writing.md` (Summary /
     Dependencies / Context / Files paths affected / Acceptance criteria /
     Implementation notes-placeholder).
   - **Create immediately** via `notion-create-pages` with `Status = "🔲 Backlog"`.
     No per-task body sign-off — the body is the skill's draft, the human reviews
     it later (when `/groom` brings it to Ready) or edits the Notion page directly
     if a correction is needed sooner. The `check-task-status.mjs` PreToolUse hook
     enforces Backlog status on create.
   - After each create, post a 1-line confirmation in chat: _"Filed at 🔲 Backlog:
     `<title>` — `<new page URL>`."_ This is a notice, not a request — the user
     can override after the fact.
   - Record the new page ID in `design-state.json` → `followon_tasks[]`.

6. **Write the Implementation notes to the Design task body** via
   `notion-update-page`. Move task → ✅ **Done**. **Confirm in chat. Move to the
   next Design task.** A Design task's "doneness" is the spec being locked, the
   pages being updated, and the follow-on tasks being filed — all of which this
   step has just completed. There is no PR to merge or human review step
   downstream for the Design task itself; Done means done.

---

## Step 4 — Session close

When every executable Design task for the milestone is at ✅ Done, emit a
session summary:

- Tasks closed (title + Notion ID).
- Architecture / Future Scope pages updated (page title + section + a 1-line
  diff fingerprint pulled from `design-state.json`).
- Follow-on 🔲 Backlog tasks filed (title + new Notion ID).
- Suggest next: _"Run `/groom <M>` to bring these Backlog tasks to Ready."_

---

## Rules (hard)

- **Source of truth**: Notion for architectural rules, decisions, and task
  definitions. For _implemented_ detail (DDL, signatures, analyzer specs), the code
  under `source_root` wins; on intent/rationale, Notion wins.
- **Scope is the target milestone only.** Do not touch Design tasks on other boards
  unless a dependency issue is explicitly identified and the human approves it.
- **Never** re-open a ✅ Done or ⏭️ Deferred task by moving it back to In Progress.
- **Never** retroactively edit a Design task already at ✅ Done — file a sibling
  Design task instead.
- **Never** widen the scope of an in-flight Design task. A surprise during
  execution = file a sibling Design task at 🔲 Backlog (and let `/groom` handle it).
- **No silent architecture-page or Design-task-body writes.** Every arch-page
  edit and every Design-task status flip is confirmed in chat first. Follow-on
  Code/Tooling tasks are the exception — they are created without per-body
  sign-off (Backlog status only; the human reviews at groom time or edits in
  Notion directly).
- **Cache/state files are edited with the Edit/Write tool, never a shell script.**
  `design-state.json` / `code-map.json` are loader-seeded JSON on disk — Edit them (or
  Read + Write the whole file). Never `node _q6lock.cjs && rm …` or any `cd … && …`
  route; that is what causes the constant permission prompts.
- **Inspect the repo with `git -C <repo> …`, never `cd <repo> && git …`.** Design runs
  from the projects-root cwd; the `cd … && git` form prompts every time (Claude Code flags
  any directory-change-before-git as a hook-execution risk, regardless of allowlist).
  `git -C <repo> show/log/diff …` is allowlisted and silent. Use path flags for other repo
  tools too (`npm --prefix`, `uv --project`), not `cd`.
- **No batch-locking.** One open question per message; one sign-off per question.
- **Investigate before deciding.** Code reads / API calls / arch-page reads come
  before presenting a question. "Decide at implementation time" is a _defer_, not
  a _resolve_ — it becomes an explicit Open Question in the follow-on Code task.
- **The human is the gate for open-question locks and arch-page writes.** Even a
  recommendation that looks obvious waits for explicit sign-off on the question.
  After every question is locked, the skill marks the Design task ✅ Done
  itself — its "doneness" is the spec + page edits + filed follow-ons, all of
  which have completed within the session.
- **Follow-on Code tasks always start at 🔲 Backlog.** The `check-task-status.mjs`
  hook blocks creation at any other status — trying to short-cut is the smell.

See `reference/anti-patterns.md` for the failure modes these rules prevent.
