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
follow-on Code / Operational / Investigation tasks that `/groom` will then bring to Ready.

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
> Step 3.5 (the page-edits loop just iterates a possibly-empty list).

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
Coding Guidelines, Research Goals, Future Scope, Project Milestones. **Future Scope is
always present**, but its shape varies by project: a **standalone page** in some
(e.g. polimarket-analyser), a **`## Future Scope` section of the Master Context page**
in others (e.g. claude-orchestrator). Either way it is the home for defer-to-future
decisions — locate it in the loaded bundle before you ever conclude "there's nowhere to
put this" (see § the silent-non-capture anti-pattern). Also read the
universal task-authoring standard at `config/task-writing.md` (no longer a Notion
context page — read it from local disk). **This is non-negotiable**: executing a design task
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
- **Cross-project prior-art reads** for any question that designs a capability a
  **sister / more-mature managed project may already have solved** — a backup
  strategy, a deploy trigger surface, an arch-page structure, a resource-isolation
  model. Before recommending an invented answer, read that project's arch pages /
  `context.md` / code as prior art (the project index in `procedures.md` lists the
  managed projects). A validated answer beats an invented one — this is among the
  highest-leverage moves in a design session. Cite what the sister project does when
  presenting the question.
- **Premise checks on the task body itself.** The Open Questions are not the only
  thing to investigate — the **facts the body asserts** can be stale. A body that
  says a method/field already exists, that "there's no single target task," that a
  subset "isn't session-stageable," or any other stated premise, must be **verified
  against current reality**, not taken on faith. Falsify before you build on it; a
  wrong premise silently invalidates every decision layered on top of it.

Keep package reads in subagents so the main window stays small — same reason as
grooming's Step 1b: the procedure must survive context pressure.

If `design-worklist.json` lists any **executable** task whose `dep_status` is
`blocked`, surface it and **stop** — that task isn't actually executable yet. Same
fail-loud posture as `/groom`.

---

## Step 2 — Prioritization proposal

> **Scale this to the milestone.** For a **small milestone (≤ ~4 executable tasks)**
> the full thematic-prioritization machinery is usually a no-op — collapse it to one
> line ("N tasks, deps allow any order; proposed order: …, objections?") and move on.
> Reserve the full grouping-by-theme treatment for milestones large enough that
> sequencing actually changes the outcome.

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
   - **Reconcile body-locked decisions before presenting anything.** A resumed or
     reclassified task often already carries locked answers in its body (a
     `LOCKED →` marker in Implementation notes, or an "Open questions resolved"
     row) that the loader seeded into `design-state.json` as *unlocked* — so it
     looks fresh when it isn't. Check the body first; for each already-settled
     question, reconcile it into `design-state.json` (`locked_decision` +
     `signed_off_at`) and **confirm with the human** rather than re-litigating it.
     If body and state disagree, surface the conflict; don't silently pick one.
   - **Surface inbound carries.** Scan `design-state.json` for any **carry aimed at
     this task** — a `carries: [{to_task, note}]` entry recorded on a *sibling*
     task pointing `to_task` here (Step 3.2). Surface each note before you start; a
     sibling's earlier lock may already constrain a decision on this task.

2. **For each open question, one at a time, in the order written in the task body:**
   - Present the question + the investigation findings from Step 1b + 2–3 viable
     answers with one-line pros/cons + a recommendation.
   - **Invite pushback explicitly.** _"Where am I wrong? Push back."_ The session
     is ready to be wrong; the human is the decider. Iterate as long as the human
     wants to debate.
   - On explicit sign-off, record the locked decision in `design-state.json` →
     `open_questions[i].locked_decision` + `signed_off_at` — **immediately, before
     you present the next question.** The write is load-bearing for resume-safety:
     a crash mid-task must lose nothing, so never defer the state-writes to
     finalization (that is a distinct anti-pattern from batch-*locking* — see
     `anti-patterns.md`). After each edit, **re-read the file to confirm it is still
     valid JSON** (a bad edit once corrupted it). **Never batch-lock multiple
     questions in one message.**
   - **Record cross-task carries structurally, not in prose.** If the locked
     decision **constrains or feeds a sibling task** (an atomic-apply another task
     must honor, a shared hard-block, a cap the sibling enforces), record it as an
     outbound carry: `design-state.json` → this task → `carries: [{to_task, note}]`.
     That way the constraint travels to the sibling (surfaced at its Step 3.1)
     instead of living only in this task's `locked_decision` prose or your head —
     where cross-task threads get dropped. **Reach for `carries` first, not the
     follow-on task's `Dependencies`/prose.** A constraint threaded into a follow-on
     body reads as ordering, not as the specific decision the sibling must honor, and
     it's easy to under-use the field precisely when you're deep in a decision — the
     moment you say "…and that means task X must…" is the cue to write a carry.

3. **Completeness-critic pass — mandatory, once every question is signed off,
   *before* composing the Implementation notes.** Ask the load-bearing question:
   _"What would an implementer of this task's locked spec hit that no open
   question owns?"_ Probe deliberately for the gap classes that recur:
   - **Durability / failure modes** — crash, restart, partial write, empty input,
     the backup / recovery path no question asked about.
   - **Dual-read / consumer-set gaps** — who *else* reads or writes this surface? A
     decision made for one consumer can be wrong for a second that no question named.
   - **Interaction bugs** — does the locked spec collide with an existing component
     (a sweeper, a scheduler, a sibling analyzer, a hot-reload path)?
   - **Missing scaffolding** — a loader, a trigger surface, a deploy step, a
     config-seed the spec silently assumes.
   - **State-mutation granularity** — for *any* design that mutates state (a store
     write, an apply, a supersede, a status flip), probe **granularity + atomicity +
     partial-failure** explicitly: per-item or grouped? atomic group or piecemeal?
     content-idempotent on replay? what state results from a partial failure? The
     pull is consistently toward finer granularity, atomic group semantics, and
     content-idempotency — surface those before presenting, not after pushback.
   - **Unstated premises** — a fact the spec leans on that no question verified.

   Consume the orchestrator's advisory **trace-coverage** signal as an aid —
   `POST /api/design/:taskId/trace-coverage` maps each follow-on Code task's regions
   + this task's acceptance criteria against the locked decisions and flags any output
   that traces back to **no** locked decision as a _possibly-unasked question_. It is
   **advisory, never a gate** (no error, no promotion block, no question-count
   threshold) — a clean signal is not evidence the critic ran.

   For **each** gap, classify and **dispose — never drop** (disposition-don't-drop):
   - **fold** → it belongs to an existing open question: reopen it, investigate,
     re-present, re-lock.
   - **note** → real but already-decided detail: record it in the Implementation
     notes.
   - **file-sibling** → a distinct decision needing its own design: file a sibling
     📐 Design task at 🔲 Backlog (via Step 3.6's create path).
   - **sibling-owned** → another task already covers it: note the reference and
     move on.

   Run the pass **even when the task feels complete** — it earns its keep exactly on
   the tasks that feel done. Surface the critic's findings + your proposed
   dispositions to the human and get sign-off before composing the Implementation
   notes; the human can add gaps or redirect a disposition. **Record every candidate's
   disposition in the durable completeness-disposition store** — `POST
   /api/design/:taskId/completeness-disposition` (one row per critic run: `{question,
   disposition: accepted|dismissed, reason}`) — **never** as body prose and **never**
   silently dropped.

4. **Once every question for this task is signed off *and the completeness-critic
   pass is dispositioned*, compose the Implementation notes** for the Design task
   body:
   - One-paragraph **decision summary** at the top.
   - An **"Open questions resolved"** table if there are ≥2 questions (the
     convention from closed Design tasks in the corpus).
   - A **"Notion pages updated"** list — filled in as Step 3.5 progresses.
   - A **"Follow-on tasks filed"** list — filled in as Step 3.6 progresses.
     Draft inline and show the human before writing to Notion.

5. **For each entry in "Notion pages affected"** — per `reference/page-edits.md`.
   **If the list is empty, don't just skip this step — ask the durable-home question
   explicitly:** _"where do these locked decisions durably land?"_ A terse Design task
   often under-declares its arch home (declares no pages-affected while clearly
   warranting a Technical Architecture edit); catch that here by default, not by
   leaning on the completeness-critic to find it. If the answer is a real arch page,
   add it and proceed; if the decisions genuinely live only in the Implementation
   notes / a follow-on, say so deliberately.
   - Fetch the target page via `notion-page.mjs` (full body, not MCP search).
   - Identify the exact section to amend; quote enough context to disambiguate.
   - Compose the exact addition/edit.
   - Present: _"I'm going to update `<page title>` § `<section>` — append after
     this anchor / replace these N lines. Diff below. Okay?"_
   - On sign-off, apply via `notion-update-page`. Stamp `design-state.json` →
     `pages_affected[i].applied_at`. **Never write to a context page silently.**

6. **For each follow-on Code / Operational / Investigation task identified during the design:**
   - **Pick the Type deliberately** (it determines downstream execution — see
     `procedures.md` § _Task types — what Ready triggers_). Pure code-generation
     work that does **not** depend on implementation-time data → 💻 **Code** (so the
     orchestrator auto-dispatches it once Ready). Work that *changes* prod/environment
     state through a sanctioned surface → 🔧 **Operational**; work that *diagnoses*
     from live data and files follow-ons → 🔎 **Investigation**; observational / E2E
     runs → 🧪 **Testing** (an Investigation variant). (🛠️ **Tooling** is **retired** —
     it split into 🔧 Operational / 🔎 Investigation.) If a single follow-on mixes
     dispatchable code-gen with interactive/observational work, **file two tasks** —
     never bury dispatchable code-gen inside an Operational/Investigation/Testing
     task, where the orchestrator won't auto-dispatch it.
   - **If the decision implies machine enforcement, file the orchestrator-side Code
     task — not just skill/docs.** When a locked decision says an invariant should
     be *enforced* (a gate, a validation, a write-path check) rather than merely
     *documented*, its durable home is orchestrator/backend code — the
     "machine-enforced > skill prose" principle. Scoping the follow-on as
     Docs/skill-only when the real fix is a backend enforcement point is the exact
     **skill-first scoping of an orchestrator surface** trap `task-writing.md`
     warns against: scope the owned surface (the orchestrator API / gate / check)
     first, the skill/UI as its consumer. If in doubt whether the decision needs a
     machine home, it does — file the Code task.
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

7. **Write the Implementation notes to the Design task body** via
   `notion-update-page`. Move task → ✅ **Done**. **Confirm in chat. Move to the
   next Design task.** A Design task's "doneness" is the spec being locked, the
   completeness-critic being dispositioned, the pages being updated, and the
   follow-on tasks being filed — all of which this step has just completed. There is no PR to merge or human review step
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

See `../_shared/reference/hard-rules.md` for the planning-procedure core this
skill shares with `/groom` and `/ops` (deterministic load, the human as the
gate, no silent writes, `git -C` not `cd`, and cache/state files via the
Edit/Write tool) — canonical source
`packages/backend/src/planning/procedureCore.ts`. Design-specific rules below:

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
  Code/Operational/Investigation tasks are the exception — they are created without
  per-body sign-off (Backlog status only; the human reviews at groom time or edits
  in Notion directly).
- **Never silently drop a needed capture.** When a decision must be recorded and its
  obvious destination isn't in the pre-loaded context bundle, you do **not** get to
  quietly decide "there's nowhere to put this." Find the destination (Future Scope
  and the arch pages are always in Notion, trivially searchable — the loaded bundle
  is a convenience, not the boundary of what exists) or surface the gap to the human
  — then capture. A silent non-capture of something explicitly needed is a defect,
  not a judgment call.
- **Persist each lock the instant it's signed off.** Write to `design-state.json`
  before presenting the next question — never batch the state-writes to
  finalization. Resume-safety depends on it: a mid-task crash must lose nothing.
  Re-read the file after each edit to confirm it's still valid JSON.
- **The completeness-critic pass (Step 3) is mandatory, not optional.** Run it after
  every question locks and before composing Implementation notes, even when the task
  feels done. Dispose every gap it finds (fold / note / file-sibling / sibling-owned)
  — never drop one. The orchestrator's advisory **trace-coverage** signal feeds this
  pass as an **aid, never a gate**; record each candidate's disposition in the durable
  **completeness-disposition store** (`accepted|dismissed` + reason), never as body
  prose and never silently.
- **Split-don't-trim.** A too-large decision space is handled by the **`file-sibling`**
  disposition — file sibling Design tasks and carry the questions there — **never** by
  trimming questions to shrink the set. Question-count is a **soft diagnostic** (`>~6`
  is a prompt to consider splitting), **not** a numeric trigger and **not** wired into
  `size_check`.
- **Check sister projects for prior art, and verify the task body's premises.**
  Before inventing an answer another managed project may already have validated, read
  its arch pages / `context.md` / code. And investigate the *facts the body asserts*,
  not just its open questions — a stale premise invalidates everything built on it.
- **Cache/state files are edited with the Edit/Write tool, never a shell script.**
  `design-state.json` / `code-map.json` are loader-seeded JSON on disk — Edit them (or
  Read + Write the whole file). Never `node _q6lock.cjs && rm …` or any `cd … && …`
  route; that is what causes the constant permission prompts.
- **Inspect the repo with `git -C <repo> …`, never `cd <repo> && git …`.** Design runs
  from the projects-root cwd; the `cd … && git` form prompts every time (Claude Code flags
  any directory-change-before-git as a hook-execution risk, regardless of allowlist).
  `git -C <repo> show/log/diff …` is allowlisted and silent. Use path flags for other repo
  tools too (`npm --prefix`, `uv --project`), not `cd`.
- **No question-bundling.** One open question per `decision.pickOne` intent, one
  sign-off per question — but independent questions can each be staged as their own
  intent in the same turn; only a question that depends on another still-unresolved
  one waits.
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
