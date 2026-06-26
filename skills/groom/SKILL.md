---
name: groom
description: >-
  Run a Backlog Grooming session for a milestone. Loads full project context
  deterministically (via groom-load.mjs), explores the code regions tasks touch
  with a git-fresh cache, presents 🔲 Backlog tasks in batches for human sign-off,
  and marks them 🗂️ Ready. Use when the user says "groom", "grooming session",
  "let's groom milestone X", "bring the backlog to Ready", or starts a Backlog
  Grooming session. Requires a grooming manifest in the central config tree
  (config/projects/<dir>/grooming.json).
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
3. Determine the milestone (from the user, e.g. "groom M9"). It must exist in
   `manifest.milestones`.
4. Determine **mode** from the cache dir `.skill-cache/grooming/<milestone>/`:
   - absent → **fresh** groom.
   - present → **resume**: the loader reuses fresh digests and re-explores only
     what changed. Same procedure either way.

Grooming runs **interactively in the main repo on `dev`** — never in an ephemeral
implementation worktree (the cache must persist). If you find yourself on a feature
branch in a worktree, stop and tell the human.

---

## Step 1 — Deterministic load (the script, not you)

Run the loader. **Do not hand-fetch context pages or task bodies yourself** — that
is exactly the step that gets skipped. The script owns it.

```bash
node ~/.claude/scripts/groom-load.mjs \
  --milestone <M> \
  --repo <repo-root> \
  --env <manifest.notion_env>
```

If it exits non-zero, **stop** — a partial load means a contaminated groom. Report
the error.

On success it has written, under `.skill-cache/grooming/<milestone>/`:

- `context-bundle.json` — the 7 context pages (bodies in `context/`), the target
  board, neighbour boards, and every non-Done target task (bodies in `tasks/`),
  each with its parsed `packages` (the code regions it touches).
- `worklist.json` — per-package freshness (`fresh` / `stale` / `missing`) against
  the **local** integration branch, plus `unresolved_tasks`.
- `grooming-state.json` — per-Backlog-task skeleton (the artifact the promotion
  gate will check); preserved across resumes.

Read `context-bundle.json` and `worklist.json`. Read the context-page bodies in
`context/` — the master context, research goals, architecture, coding guidelines,
task-writing guidelines. **This is non-negotiable**: resolving a task without the
architectural constraints loaded is how grooming produces confidently-wrong decisions.

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

---

## Step 3 — Incorporate feedback (one item at a time)

Do not batch feedback. For each item: update Notion → confirm the change in chat →
continue.

- Clarification / correction → edit the task page now, confirm.
- New open question → add a `> ⚠️ Open question:` callout to the task's Context.
- Missing task → **draft it inline for review first**; create in Notion only after the human okays it.
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
   vs soft-order distinction), fill `size_check` (an object recording the size
   classification — see `presentation.md` § Size check — one of: `{ "loc": <number>,
"decision": "no_split" }` for ≤500 LoC tasks, `{ "loc": <number>, "decision":
"split_now", "split_into": ["<task-id>", …] }` after splitting, `{ "loc":
<number>, "decision": "unsplittable", "reason": "<one-line>" }` for the atomic
   case, or `{ "decision": "n/a" }` for Design/Planning tasks), and set
   `signoff: { "by": "<human>", "at": "<iso>" }`. _(All three — `signoff`,
   `hard_block_deps`, and `size_check` — are gated by the promotion hook. They
   must be written **before** the status flip, or the gate blocks the update.)_
2. **Then**, in a **single** `notion-update-page` call (`command:
"update_properties"`) per task, write **both** the canonical hard-block deps
   into the `Depends On` property **and** set `Status → 🗂️ Ready`. The
   `Depends On` value is the rendered task-ID list (e.g.
   `"38122f91-52f3-810f | 38122f91-52f3-8129"` — the project's existing pipe-separated
   convention). **Hard-block deps live in the property, never in the task body** —
   downstream sessions read the property; body sequencing is invisible to them.
   - If the task has no hard-block deps, write an empty `Depends On` (or leave
     it unchanged if already empty).
   - If existing `Depends On` text on the page held free-form prose (notes,
     hints, soft-order observations), it is overwritten by the canonical list.
     Soft-order observations are not persisted on the task — they were a
     batch-level conversation and live in the chat record.
3. Confirm in chat what was marked Ready **and** what `Depends On` value was
   written for each task. Then present the next batch.

**Gates last**: Manual Verification Gate tasks are the final batch, after all code
tasks are signed off.

When every batch is signed off, confirm the milestone board is fully groomed.

---

## Rules (hard)

- **Source of truth**: Notion for architectural rules, decisions, and task
  definitions. For _implemented_ detail (DDL, signatures, analyzer specs), the code
  under `source_root` wins; on intent/rationale, Notion wins.
- **Scope is the target milestone only.** Do not modify tasks on other boards unless
  a dependency issue is explicitly identified and the human approves it.
- **Never** mark a ✅ Done or ⏭️ Deferred task Ready. **Never** retroactively edit a
  task already at 🗂️ Ready or beyond — file a sibling instead (it may be picked up).
- **No silent Notion updates.** Every change is confirmed in chat before moving on.
- **Investigate before resolving.** Reading the code comes before deciding what's
  resolved. "Decide at implementation time" is a _defer_, not a _resolve_.
- **The human is the promotion gate.** Even a Ready-clean task waits for sign-off.
- **Code / Tooling tasks default to < 500 LoC estimated.** The size check is
  **load-bearing**, not advisory — every Code/Tooling task carries an explicit
  _Size:_ line in its presentation header, and `size_check` is a required field
  in `grooming-state.json` that the promotion gate enforces. Larger tasks split
  unless **demonstrably unsplittable** (see `presentation.md` § Size check).
  **When splitting: edit the original task down to one of the new subsets and
  create N-1 new siblings — do NOT demote the original to ⏭️ Deferred** (that
  loses history, comments, and inbound dep refs; Deferred has a specific
  meaning that doesn't fit splits). Design and Planning tasks are sized in
  open-question count, not LoC; write `{"decision": "n/a"}` for them.
- **Hard-block dependencies live in the Notion `Depends On` property, never in
  the task body.** Soft-order observations are batch-level conversation only —
  not persisted. The property write happens in the same `notion-update-page`
  call as the Ready status flip (see Step 4). See `presentation.md` §
  Dependencies for the hard-block-vs-soft-order test.

See `reference/anti-patterns.md` for the failure modes these rules prevent.
