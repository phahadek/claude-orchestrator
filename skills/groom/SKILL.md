---
name: groom
description: >-
  Run a Backlog Grooming session for a milestone. Loads full project context
  deterministically (via the backend's GET /api/groom-context route), explores
  the code regions tasks touch with a git-fresh cache, presents 🔲 Backlog tasks
  in batches for human sign-off, and marks them 🗂️ Ready. Use when the user says
  "groom", "grooming session", "let's groom milestone X", "bring the backlog to
  Ready", or starts a Backlog Grooming session. Requires a grooming manifest in
  the central config tree (config/projects/<dir>/grooming.json).
---

# Backlog Grooming

Grooming brings 🔲 Backlog tasks up to 🗂️ Ready: every open question resolved or
explicitly owned, scope verified against the actual code, tests and manual-gate
items enumerated — then the human signs off, batch by batch.

This skill exists because the procedure is **load-bearing but routinely skipped**:
under context pressure a single agent compresses the expensive Step-1 load and
"just decides." Here the deterministic parts are done by a script (nothing to
skip) and the judgment parts are gated on human sign-off (nothing to self-grant).

**Read `reference/anti-patterns.md` now** — those failure modes are the whole
reason this skill exists. Read `reference/presentation.md` before Step 2.

---

## Step 0 — Resolve manifest & mode

1. Read the repo's grooming manifest from the **central config tree** —
   `<config>/projects/<repo-dir>/grooming.json` (the loader resolves the config root via
   `$ORCHESTRATOR_CONFIG_DIR` / `--config-dir` / a host-aware default; `<repo-dir>` is the
   repo basename, override with `--project`). **If it is missing, stop** and tell the human
   (point them at `reference/manifest.example.json`). Do not improvise.
2. Note `architectural_control`:
   - `full` → this skill's default behavior (decide-and-rewrite within the rules).
   - `low` → **read `reference/low-control.md`** and follow the investigate-propose-route
     adaptation instead. The groomer does not own the architecture; resolution biases to
     proposing and routing to owners.
3. Determine the milestone (from the user, e.g. "groom M9"). If it isn't yet
   registered in `manifest.milestones` (routine right after a new milestone board is
   created), the loader no longer dead-ends — it prints a copy-pasteable entry with the
   neighbour auto-filled. Add that entry to the manifest, or pass `--board
<data-source-id>` to run immediately and persist the printed snippet afterward.
   Never improvise a board id — copy it from the board's Notion URL / context.md.
4. Determine **mode** from the cache dir `.skill-cache/grooming/<milestone>/`:
   - absent → **fresh** groom.
   - present → **resume**: the loader reuses fresh digests and re-explores only
     what changed. Same procedure either way.

Grooming runs **interactively in the main repo on `dev`** — never in an ephemeral
implementation worktree (the cache must persist). If you find yourself on a feature
branch in a worktree, stop and tell the human.

---

## Step 1 — Deterministic load (the backend route, not you)

Load through the backend, not by hand-fetching context pages or task bodies
yourself — that is exactly the step that gets skipped. **Do not shell out to
Notion directly** (no `notion-query.mjs` / `notion-page.mjs`, no vendored
`groom-load.mjs`) — the backend's `GET /api/groom-context` route (see
`packages/backend/src/routes/groomContext.ts`) is the sole loader now; it wraps
the same `loadGroomContext()` the dashboard's grooming panel calls, so the
skill and the panel always see identical context.

```bash
node ~/.claude/scripts/groom-context-client.mjs --milestone <M> [--project <project-id>]
```

`groom-context-client.mjs` is the vendored sanctioned node client (curl/wget
are off the auto-dispatch allowlist, `node` is not — re-vendored via the
`/sync-guidelines` skill), which calls the loopback, device-authed route
with `$ORCHESTRATOR_DEVICE_TOKEN` (host/port default to
`127.0.0.1:3000`, overridable via `$ORCHESTRATOR_BACKEND_HOST` /
`$ORCHESTRATOR_BACKEND_PORT`) and prints the `GroomLoadResult` bundle as JSON
on stdout. If it exits non-zero, **stop** — a partial load means a
contaminated groom. Report the error.

The bundle has:

- `contextPages` — the context pages (`{id, title, markdown}`), fetched fresh
  every load.
- `board` — every non-Done target task (`{id, title, status, type, priority,
url}`), and `neighbourBoards` — the same shape for neighbour milestones
  (context-only).
- `targetTasks` — the target board's tasks, each carrying its parsed
  `filesSection` / `rawMarkdown`, plus **already-computed** judgment seeds:
  `readinessViolations` (the shared readiness gate run ahead of time),
  `sizeCheckSeed` (`{files, loc_method}` — a deterministic size-check seed),
  `typeCheck` (the type/content-mismatch scan), and `regions` (resolved
  package/file scope).
- `codeWorklist` — per-package deduped file paths declared across target task
  bodies (object form: package path → file list).
- `gitFreshness` — per-package freshness (`fresh` / `stale` / `missing`) vs. the
  **local** integration branch.
- `dependencyCandidates` — per-task dependency candidates (region overlap ∪
  declared Depends On) for the groomer to confirm — never auto-wired.

The bundle does not carry `milestone_gate_task_id` / `milestone_seed_task_id`
directly — derive them from `board` exactly as the old loader did: the single
row with `type === '🚦 Gate'` (null if absent), and the single `🔧 Operational`
row whose title contains "config-seed" case-insensitively (null if zero or
ambiguous if more than one match — surface either case rather than guessing).
Record both in `context-bundle.json` for the rest of the session to read.

Persist this session's working state locally exactly as before — the route is a
pure read, so the skill still owns the on-disk cache under
`.skill-cache/grooming/<milestone>/`: write `context-bundle.json` (context pages
+ board + neighbours + target tasks + the derived gate/seed task ids) and `worklist.json` (codeWorklist +
gitFreshness) from the bundle with the **Write** tool, and seed/merge
`grooming-state.json` (per-Backlog-task skeleton, preserved across resumes —
same merge rule as before: carry forward human-entered fields, always refresh
`status`/`title`/`type` from the live bundle, prune entries whose task is no
longer a live non-Done target) with the **Edit** tool. This is what makes
**resume** mode work and is unchanged from before the cutover — only the
_source_ of the bundle moved from a shell-out to the route.

Read the context-page bodies from `contextPages[].markdown`. Also read the
universal task-authoring standard at `config/task-writing.md` (it is not a
Notion context page — the skill reads it from local disk). **This is
non-negotiable**: resolving a task without the architectural constraints loaded is how
grooming produces confidently-wrong decisions.

**Disposition the constraints — don't just "read the pages."** The loader surfaces each
task's **binding constraints** (`targetTasks[].bindingConstraints` — the
`CONSTRAINT_CATALOG × regions` intersection). Before a task can promote, **disposition
every one** of its binding constraints as one of `complies` / `n-a` (+ a mandatory
`why`) / `conflict→route` (naming the routed 📐 Design task) — recorded in
`grooming-state.json` as `constraints_dispositioned` and re-derived + enforced
server-side (`groomGate.ts`, FM1). The mandatory architecture read **is** the
disposition, not a page-turn: a constraint you didn't disposition is a constraint you
didn't check.

---

## Step 1b — Explore the code (cached, judgment where needed)

Grooming decisions made from task bodies alone routinely miss real gaps. Read the
code the tasks touch — but only once per region, and only what changed.

**Per package in `worklist.json`:**

- `fresh` → reuse the digest already in `code-map.json`. Do not re-read.
- `stale` or `missing` → dispatch one **Explore subagent** scoped to that package.
  Have it return a structured digest: public surface (classes/functions/signatures
  another task would import), the conventions in play, and anything that would
  invalidate a Backlog task's stated assumption. Write the digest to
  `code-map.json` keyed by the package path, stamped with `worklist.baseline_sha`:
  ```json
  {
    "src/polimarket_analyser/<pkg>": {
      "head_sha": "<baseline_sha>",
      "digest": "...",
      "explored_by_task": ["<id>"],
      "ts": "<iso>"
    }
  }
  ```
  (The loader reads `code-map.json` for freshness; the skill owns writing it.)

> **Write the cache/state files with the Edit/Write tool — never a shell script.**
> `code-map.json`, `grooming-state.json` (and the design skill's `design-state.json`)
> are ordinary on-disk JSON the loader already seeded. Mutate them with the **Edit**
> tool (a unique-string change) or **Read + Write** the whole file (a structural
> change). **Never** write a throwaway script and run it (`node _foo.cjs` then `rm`),
> and never shell out (`echo >`, `cat >`, a `cd … && …` chain). The script route does
> in three permission-prompting Bash calls (`node`, `rm`, the `cd &&` chain) what the
> Edit tool does in one auto-approved call — it is the cause of the constant
> permission friction, not a workaround for it.

**For each task in `worklist.unresolved_tasks`** (declared no resolvable path —
common, because real tasks reference code by identifier or prose, not a `Files /
paths affected` section): this is the **judgment** half the loader deliberately
left to you. Read the task body, extract the named symbols / analyzers / tables it
mentions, `grep` the repo to find the real file(s), map to a package, and explore
that package as above. If a stable area→package mapping emerges, **propose adding
it to `manifest.area_aliases`** so the loader resolves it next time — confirm
before editing.

Keep the package reads in subagents so the main window stays small (the procedure
must survive — that is the original failure mode).

---

## Step 2 — Present 🔲 Backlog in batches

Follow `reference/presentation.md`. In short:

- **Only 🔲 Backlog tasks need decisions.** Tasks at any other status are shown as
  context only (name + status), never promoted.
- Batch by **dependency cluster** (sequencing comes from the depends-on chain — do
  not invent external sequencing labels). One batch per message.
- For each Backlog task, give the 4-point summary: **what it achieves** / **open
  questions** (write _None._ if clean) / **automated tests** / **manual verification**.
  Ground every claim in the code-map digest and the context pages — not the task
  body alone.
- End the batch with: _"Any changes or questions before I mark these Ready and continue?"_
- **One batch at a time. Never present the next before the current is signed off.**

**Presentation is type-dependent — a mixed milestone runs both flows:**

- **💻 Code (auto-dispatched)** → the per-batch, per-task flow above: each task gets
  its 4-point summary and its own human decision (a wrong Ready launches an
  unattended worktree, so the stakes demand it).
- **📐 Design / 📋 Planning (interactive, picked up by `/design`)** →
  **approve-by-standard**: present **ONE consolidated triage**, not per-item asks —
  a **clean** list (names-only), **blocked** rows (+ the blocking dep), and
  **needs-attention** rows (+ the reason). The human engages **only** the
  needs-attention + blocked rows; **the clean set promotes by default (visible +
  veto-able)** — no per-item or bulk positive stamp. The clean-verdict standard, its
  taxonomy, and the deterministic floor that can only ever downgrade a proposed
  clean verdict live in `reference/presentation.md` § Consolidated triage.

---

## Step 3 — Incorporate feedback (one item at a time)

Do not batch feedback. For each item: stage the write → confirm the change in chat →
continue.

- Clarification / correction → stage a `task.updateBody` intent for the task now, confirm.
- New open question → stage a `task.updateBody` intent adding a `> ⚠️ Open question:`
  callout to the task's Context.
- Missing task → **draft it inline for review first**; stage a `task.create` intent
  only after the human okays it.
- Missing prerequisite (a sibling ingestion/storage/analyzer task the scope doesn't
  cover) → propose a **separate** new task. **Never silently widen** the existing scope.

If grooming reveals a design choice that needs human judgment, **present options
with pros/cons and stop** — do not pick unilaterally. Load-bearing constraints from
the architecture pages win over task wording (see `reference/anti-patterns.md`).

---

## Step 4 — Mark Ready after sign-off

Only after explicit sign-off on the batch (_"looks good"_, _"ship it"_, _"next"_):

1. **First**, record the sign-off in `grooming-state.json` for each task **in that
   batch**: fill `achieves`, `open_questions`, `tests`, `manual`, confirm `regions`,
   fill `hard_block_deps` (see `presentation.md` § Dependencies for the hard-block
   vs soft-order distinction), fill `size_check` (the size classification — see
   `presentation.md` § Size check — shape `{ loc, loc_method, files, decision,
   split_into?, reason? }`, where `decision` is one of: `"no_split"` (≤500 LoC —
   proceed), `"split_now"` with `split_into: ["<task-id>", …]` (over the threshold and
   splittable — you **nominate** the split; the orchestrator confirms and routes it to
   a dedicated session, see § Size check), `"unsplittable"` with `reason: "<one-line>"`
   (over the threshold but must land atomically), or `{ "decision": "n/a" }` for
   Design/Planning tasks) and `type_check` (the present-and-dispositioned
   type/content-mismatch scan — advisory, never a hard block on its own), determine the
   **Gate accretion** and **Seed accretion** content below for 💻 Code
   tasks (write it into the entry as `gate_contribution` / `seed_contribution` —
   these are transient staging fields the flip command below reads and submits;
   the durable record is still the gate/seed DB marker the flip call writes, keyed
   by this task's id), and set `signoff: { "by": "<human>", "at": "<iso>" }`.
   _(`signoff`, `hard_block_deps`, and `size_check` are gated by the promotion hook
   and must be written in `grooming-state.json` **before** the status flip, or the
   gate blocks the update.)_

**One-shot Ready-flip:** once the entry above is complete, promote the task with a
single call — no task id (or dependency id) is ever hand-typed on the command line,
every id is resolved from the entry itself:

```bash
node ~/.claude/scripts/groom-flip-client.mjs .skill-cache/grooming/<M>/grooming-state.json <taskId>
```

This posts the whole entry to the backend's `POST /api/groom/flip` route
(`packages/backend/src/routes/groomFlip.ts`, `TaskWriteCommands.flipToReady`), which
runs gate accretion + seed accretion + `setDependsOn` + `setStatus(Ready)` as one
transaction — the same order and the same `groomingGate` / dependsOn-before-Ready
invariants as the per-call path below, but rolling back any accretion already
committed if a later step fails, so a failed flip never leaves an orphan gate/seed
item or a wrong status. This **replaces** the six separate calls (gate accrete, seed
accrete, stage + apply `setDependsOn`, stage + apply `setStatus`) described next —
read the per-call breakdown when you need to understand or troubleshoot what the
one-shot command does, or when the discrete staged-intent surface is needed for
something the one-shot command doesn't cover (e.g. reviewing a staged write before
applying it).

**Gate accretion (💻 Code tasks):** Before flipping to Ready, mint the
task's stripped runtime/launch-and-observe items onto the milestone gate store. Read
the task body's `### 👁️ Manual verification` section — these are the items the task
spec says are _"Covered by the Manual Verification Gate."_ Call the accretion route
through the vendored client, **never** a `task.updateBody` body-append:

```bash
node ~/.claude/scripts/gate-state-client.mjs accrete \
  '{"project":"<project-id>","taskId":"<task-id>","title":"<task-title>",
    "milestone":"<M>","classification":"<Read-Only|Prod-Mutating|Opportunistic|needs-triage>",
    "items":[{"text":"<item 1>"}, "…"]}'
```

For a task with no standalone runtime item, call it with `"classification":"none"` and
an empty (or omitted) `items` array instead. Either way this POSTs to the loopback,
device-authed `/api/gate/accrete-contribution` route (see
`packages/backend/src/routes/gateState.ts`), which mints one `gate_item` per item on the
milestone gate store and records the `gate_accretion` marker
`checkGroomingPromotionGate` reads before allowing the Ready flip — the call itself is
the durable record; nothing further needs writing to `grooming-state.json`.

Confirm the accretion in chat before the Ready-flip.

**Seed accretion (💻 Code tasks):** The operational twin of Gate accretion.
Before flipping to Ready, mint the task's operational data/config seed — a prod-data
row/flag/default deliberately kept **out** of its auto-dispatched PR (e.g. an
`analyzer_configs` row, config-category defaults, alias/cohort flags) — onto the
milestone seed store. Call the accretion route through the vendored client, **never** a
`task.updateBody` body-append:

```bash
node ~/.claude/scripts/seed-state-client.mjs accrete \
  '{"project":"<project-id>","taskId":"<task-id>","title":"<task-title>",
    "milestone":"<M>","decision":"seeds","seeds":[{"spec":"<seed 1>"}, "…"]}'
```

For a task with no operational seed, call it with `"decision":"none"` and an empty (or
omitted) `seeds` array instead. This POSTs to the loopback, device-authed
`/api/seed/accrete-contribution` route (see `packages/backend/src/routes/seedState.ts`),
which mints one `seed_item` per seed on the milestone seed store and records the
`seed_accretion` marker `checkGroomingPromotionGate` reads before allowing the Ready
flip — again, the call itself is the durable record.

Confirm the accretion in chat before the Ready-flip.

2. **Then**, stage the write per task through the sanctioned device-authed
   staged-intents CLI client (`node ~/.claude/scripts/staged-intents-client.mjs
   create <kind> <json-payload> <projectId> [groupId]` — see
   `packages/backend/scripts/staged-intents-client.mjs`), **never** a direct
   `notion-update-page` call. This runs in the trusted Remote-Control session,
   so it stages through the same device-authed surface the dashboard panels
   use (`POST /api/staged-intents`, authenticated by
   `$ORCHESTRATOR_DEVICE_TOKEN` — **not** the stage-only
   `ORCHESTRATOR_STAGE_TOKEN` transport, which is reserved for unattended
   orchestrator-launched worktree sessions staging through the orchestrator
   MCP tool surface).
   After conversational sign-off in this session, apply each staged intent
   with `node ~/.claude/scripts/staged-intents-client.mjs apply <intentId>`
   (`POST /api/staged-intents/:id/apply`) — the readiness/groomGate guards
   still enforce on apply. This is not a UI panel: the session stages and
   applies its own writes, but only after the human has signed off in chat.
   - Generate one `groupId` per task (any stable string, e.g. the task id) so
     its writes present and apply as a unit.
   - If the task has hard-block deps (or had any and now has none), stage a
     `task.setDependsOn` intent: `{"taskId": "<id>", "dependsOn": ["<id>", …]}`
     — the rendered array of hard-block task IDs. **Hard-block deps live in
     the `Depends On` property, never in the task body** — downstream sessions
     read the property; body sequencing is invisible to them. If existing
     `Depends On` held free-form prose (notes, hints, soft-order
     observations), the canonical array overwrites it — soft-order
     observations are not persisted; they were a batch-level conversation and
     live in the chat record.
   - Then stage a `task.setStatus` intent with the **same `groupId`**:
     `{"taskId": "<id>", "status": "Ready", "groomingGate": {"size_check":
<the recorded size_check>, "type_check": <the recorded type_check>}}`. The
     `groomingGate` field is **required** — it is the command layer's
     promotion-gate check (`checkGroomingPromotionGate` in `groomGate.ts`,
     wired into `TaskWriteCommands.setStatus`), the successor to the retired
     `groom-gate.mjs` PreToolUse hook: a missing or undispositioned
     `size_check` / `type_check` blocks the apply with a 409 and an
     annotation on the staged intent, same failure mode as the old hook.
   - Apply the `task.setDependsOn` intent before (or together with) the
     `task.setStatus` intent — the Ready flip is blocked with a 409 unless its
     group already carries an applied (or concurrently-applied)
     `task.setDependsOn` for the same task.
3. Confirm in chat what was staged (Ready flip **and** `Depends On` value) for
   each task, and that it is now waiting for human apply. Then present the next batch.

### Approve-by-standard (interactive 📐 Design / 📋 Planning types)

The numbered flow above is the per-task **💻 Code** path. **Interactive types promote by
standard, not per item.** After the consolidated triage (Step 2), the human engages only
the needs-attention + blocked rows; every task left in the **clean** set promotes by
default (visible + veto-able) — you do **not** collect a per-item positive stamp.

- **Record a `triage` verdict** per interactive task in `grooming-state.json` — one of
  `clean` / `blocked` / `needs-attention` — alongside `constraints_dispositioned` (see
  Step 1 § constraint disposition). The flip client carries `triage` in `groomingGate`;
  the server re-derives the **deterministic floor** and can only ever **downgrade** a
  proposed `clean` (a hard-block dep not ✅ Done → `blocked`; no `## Open Questions`
  heading → `needs-attention`; a routed constraint-conflict → `needs-attention`). It
  never upgrades a judged `blocked` / `needs-attention` back to `clean`.
- **The `readiness_override` reason is auto-applied — never hand-typed.** For a 📐 Design
  task promoted clean, the backend supplies the standard template reason (_"Design task —
  open questions are the /design worklist, resolved at execution; triaged clean in the
  `<milestone>` consolidated Design triage"_); you record the clean `triage` verdict, not
  the reason string.
- **`size_check` is `{"decision": "n/a"}`** for Design/Planning, and gate/seed accretion
  does not apply (those are 💻 Code artifacts). Per-task disposition records + audited
  applies are preserved — the ceremony removed is only the per-item *positive stamp*.

**Gates last**: the milestone's **🚦 Gate** task is the final batch, after all code
tasks are signed off. Accretion happens incrementally — as each 💻 Code
task is promoted (Gate accretion above), its stripped items are minted onto the
milestone gate store via the accretion route, not appended to the Gate task body. The
final Gate batch confirms readiness (`node ~/.claude/scripts/gate-state-client.mjs
readiness --milestone <M>`) and presents the Gate for sign-off. The milestone
**config-seed** 🔧 Operational task accretes the same way (Seed accretion above) — a
human runs the seeded items via `/ops` at milestone end, after the code is merged and
deployed.

**Re-check the board before finishing — don't close on a stale snapshot.** Step 1 loaded the
board once at the start, but new 🔲 Backlog tasks can arrive *during* the session (the operator or
another session files them while grooming runs). So before declaring the board groomed, **re-query
the live board** for any 🔲 Backlog tasks not in the original worklist. If any appeared, **continue**
— groom them in fresh batches (Steps 2–4) exactly like the rest; don't defer them to "next time."
Repeat the re-query until a pass finds **no** new Backlog. Only then, when every batch is signed
off, confirm the milestone board is fully groomed.

---

## Rules (hard)

See `../_shared/reference/hard-rules.md` for the planning-procedure core this
skill shares with `/design` and `/ops` (deterministic load, the human as the
gate, no silent writes, `git -C` not `cd`, and cache/state files via the
Edit/Write tool) — canonical source
`packages/backend/src/planning/procedureCore.ts`. Grooming-specific rules:

- **Source of truth**: Notion for architectural rules, decisions, and task
  definitions. For _implemented_ detail (DDL, signatures, analyzer specs), the code
  under `source_root` wins; on intent/rationale, Notion wins.
- **Scope is the target milestone only.** Do not modify tasks on other boards unless
  a dependency issue is explicitly identified and the human approves it.
- **Never** mark a ✅ Done or ⏭️ Deferred task Ready. **Never** retroactively edit any
  **ordinary** task already at 🗂️ Ready or beyond — file a sibling instead. A Ready task
  may be in-flight: auto-dispatched if 💻 Code, human-run if 🔧 Operational /
  🔎 Investigation / 🧪 Testing — editing it races a live session. This holds for every ordinary type, **without
  exception**. The **🚦 Gate** is the lone non-ordinary task: an accumulator that, by its
  type's definition, accretes manual-verification items while sitting at Ready —
  appending to it is its lifecycle, not a modify-a-Ready-task exception.
- **No silent writes** (shared rule, groom-specific mechanics): every change is
  staged through `staged-intents-client.mjs` — never a direct `notion-update-page` call.
- **Investigate before resolving.** Reading the code comes before deciding what's
  resolved. "Decide at implementation time" is a _defer_, not a _resolve_.
- **Cite-or-route, never invent.** An open question that is an **architectural
  decision** is cleared only by (a) **citing a locked decision** (an arch-page rule or
  an already-✅-Done Design task) or (b) **routing to `/design`** — file a 📐 Design task
  and add a hard-block `Depends On` edge to it. **Never invent the answer in-grooming.**
  A task whose `Depends On` names a not-yet-✅-Done Design/Planning task is **not
  promotable** (the promotion gate blocks it, FM3; for interactive types the triage
  floor downgrades it to `blocked`).
- **Per-task sign-off is an invariant for 💻 Code.** A batched or momentum operator
  action ("these all look fine") **never** stands in for the per-task disposition
  records; 💻 Code tasks are always promoted **individually**. (Interactive Design /
  Planning types promote approve-by-standard — the *documented* batch flow, not a
  shortcut around this invariant; see Step 4 § approve-by-standard.)
- **The human is the promotion gate** (shared rule) — but its *granularity* is
  type-dependent, because the stakes are. For **auto-dispatched 💻 Code**, a wrong
  Ready launches an unattended worktree, so promotion is a **per-task human
  decision**, taken individually — a batched/momentum action never stands in for it.
  For **interactive 📐 Design / 📋 Planning** (which `/design` picks up, so a wrong
  Ready is a reversible glance, not a launch), promotion is **approve-by-standard**:
  under one consolidated triage the clean set promotes **by default (visible +
  veto-able)** — no per-item or bulk positive stamp (see Step 2 § consolidated triage
  and Step 4 § approve-by-standard). The gate is preserved either way; per-task
  disposition records + audited applies are preserved either way. **Reduced ceremony
  is not reduced rigor** — the investigation posture (arch-page reading, code
  exploration, anchor grounding) is the sole non-server backstop once the per-item
  decision is removed, and stays non-negotiable.
- **Code tasks default to < 500 LoC estimated.** The size check is
  **load-bearing**, not advisory — every Code task carries an explicit
  _Size:_ line in its presentation header, and `size_check` is a required field
  in `grooming-state.json` that the promotion gate enforces. The 500-LoC default
  is a **split *threshold*, not a hard ceiling** — a task over it is nominated for
  splitting (and a sub-500 task may split on a natural seam); there is **no hard
  file-count ceiling**; a task that must land atomically records `"unsplittable"` +
  `reason`. **Splitting and merging are orchestrator-driven: a grooming session
  *nominates* a split/merge candidate (`decision: "split_now"` + `split_into`),
  never performs it in-session — the orchestrator confirms the nomination and
  routes the split to a dedicated session** (detect → confirm → route; see
  `presentation.md` § Size check). Design and Planning tasks are sized in
  open-question count, not LoC; write `{"decision": "n/a"}` for them.
- **Hard-block dependencies live in the Notion `Depends On` property, never in
  the task body.** Soft-order observations are batch-level conversation only —
  not persisted. The `task.setDependsOn` intent is staged with the same
  `groupId` as the `task.setStatus` Ready flip (see Step 4). See `presentation.md`
  § Dependencies for the hard-block-vs-soft-order test.

See `reference/anti-patterns.md` for the failure modes these rules prevent.
