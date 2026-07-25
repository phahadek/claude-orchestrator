# Presentation — Step 2 detail

How to present 🔲 Backlog tasks for sign-off. The goal: the human can approve a
batch from your summary alone, without re-reading the task page or the code.

## Batching

- **Only 🔲 Backlog tasks get a decision.** Tasks at 🗂️ Ready / 🔄 In Progress /
  👀 In Review / ✅ Done are listed for context only — name + status, no 4-point
  breakdown, no sign-off ask. **⏭️ Deferred tasks are _not_ surfaced at all** —
  Deferred means _"scope superseded by another task"_, not _"do later."_ They
  are equivalent to ✅ Done from a grooming standpoint; don't include them in
  context lists, dep discussions, or sequencing chains.
- **Group by dependency cluster** — tasks that share a depends-on chain or a code
  region travel together. Sequencing comes from the depends-on graph; do not invent
  external "wave 1 / wave 2" labels.
- **One batch per message.** Never present the next batch before the current one is
  signed off.
- **Gates last.** Manual Verification Gate tasks are always the final batch.

## Dependencies — hard-block vs soft-order

Every Code task in a batch is examined for its **dependencies on other
tasks**, and each dependency is classified as one of:

- **Hard-block (prerequisite).** Task B _cannot start_ until Task A is at ✅ Done
  or 🗂️ Ready without breaking. _"Cannot start"_ is concrete: the upstream
  produces a symbol, schema column, store method, migration, or service
  contract that the downstream's diff literally references; or the CI / runtime
  sequence requires it (a migration must land before the consumer; a new
  alarm-rule kind must be registered before a daemon can emit it). **Test:**
  "if I started B before A is Done/Ready, what specifically breaks?" If you
  can name the break, hard-block. If you can't, it isn't.
- **Soft-order.** Task B is _better worked after_ Task A — the locked spec from
  A informs B's shape, or doing them together is more efficient — but B could
  technically begin in parallel with a placeholder. Examples: A locks a
  schema-design decision that B would otherwise have to guess; A's locked
  arch-page note clarifies B's acceptance criteria; A's investigation surfaces
  a constraint that would re-shape B's tests.

**Hard-block deps go in the Notion `Depends On` property.** That property is
the source of truth downstream sessions read; nothing else. The task body is
**not** authoritative for sequencing. Body sequencing is a session-narrative
fluff that downstream sessions never see — see the
_"Locking sequencing in the task body instead of the Depends On property"_
anti-pattern.

**Soft-order does NOT go in `Depends On`.** It's a batch-level conversation
that informs how the human schedules the work, but it doesn't bind. It lives
in the chat record only; do not persist it on the task.

**Classify explicitly during the batch discussion.** For every dep you propose:
ask _"hard-block (prereq) or soft-order?"_ and apply the test above. The
default when you cannot articulate the break is **soft-order, not hard-block**
— but the inverse mistake (classifying a hard prereq as soft) is also real and
more damaging: it produces a Ready task that fails the moment a worker picks
it up. Lean toward hard-block when the dep names a _symbol_ or _migration_;
lean toward soft-order when the dep names a _decision_ or _informing
investigation_.

### How dependencies appear in the batch summary

- **At batch level**, before the per-task 4-point summaries, render the
  proposed dep graph for the batch as a one-line ASCII chain:

  > **Dep chain (proposed):** ① → ② → ③ · ④ standalone · ⑤ depends on ② AND on `38122f91-…-81dd` (existing Ready)

  The `→` indicates a hard-block edge. Soft-order observations get a separate
  line if they matter to the human's scheduling:

  > **Soft-order:** prefer ④ before ⑤ (⑤'s test shape informed by ④'s investigation, but not blocking).

- **At per-task level**, the 4-point summary's task header includes the
  hard-block deps inline:

  > **① 💻 Code — Add HLTV RSS dedupe by GUID** · _Hard-block:_ none.
  > **③ 💻 Code — Wire the dedupe into the runner** · _Hard-block:_ ① (this batch), `38122f91-…-81dd` (existing Ready).

  Always include the _Hard-block:_ line — write _none._ if independent.
  Implicit-by-omission is how the previous failure mode happened.

## Size check (mandatory, per 💻 Code task in the batch)

The size check is **load-bearing**, not advisory. It runs **for every** Code
task in the batch, and the result lands as a required line in that
task's header (see below). Skipping it is a procedure violation — the
promotion gate enforces this (a Ready promotion without a recorded size
classification is blocked, same as missing `hard_block_deps`).

### Estimate

Code tasks default to **under 500 LoC** estimated diff. Estimate
cheaply from the code-map digest: files touched × ~50–100 lines each, or by
recalling what similar past tasks in this repo landed at (CI / git history is
the ground truth — `git -C <repo> diff --stat` on the closest prior task is a
5-second calibration).

> **Always `git -C <repo> …`, never `cd <repo> && git …`.** Grooming runs from the
> projects-root cwd, so the repo is a subdirectory — but `cd <repo> && git …` trips a
> permission prompt **every time** (Claude Code flags any directory-change-before-git
> as a hook-execution risk, regardless of allowlist). `git -C <repo> show <sha> --stat`,
> `git -C <repo> log …`, `git -C <repo> diff --stat …` are allowlisted and run silently.
> Same for any other repo tool: use its path flag (`npm --prefix`, `uv --project`), not `cd`.

### Decide

One of three outcomes per task:

- **No split** (estimate comfortably < 500 LoC) — proceed.
- **Split now** (estimate > 500 LoC and splittable) — see procedure below.
- **Unsplittable** (estimate > 500 LoC and **demonstrably** must land atomically) — proceed with the original task as-is, with explicit reason in the header.

### Split procedure (when "split now") — nominate, don't perform

**Splitting is orchestrator-driven. A grooming session *nominates* a split
candidate; it never edits the task set into N pieces in-session.** Record the
nomination in `size_check` — `{ …, "decision": "split_now", "split_into":
[<planned subset ids/labels>] }` — and surface it in the batch. The
orchestrator's split-candidate detector runs **detect → confirm → route**: it
confirms the trip (a candidate far over the floor auto-confirms; one near the
floor waits for operator sign-off) and **routes the split to a dedicated split
session**, which performs the actual edit. The groomer's job stops at the
nomination.

The shape the **dedicated split session** follows (and the reason a split is
never a Deferred-and-recreate):

1. **Keep the original task; edit it down to one subset** — typically the
   foundational one (most others depend on it), or the one whose title fits most
   naturally as a narrowed version of the original. The original retains its
   Notion ID, history, and inbound dep references — which is the point.
2. **Create N-1 new sibling tasks at 🔲 Backlog** for the remaining subsets, each
   properly scoped. They go through their own grooming pass.
3. Do **NOT** demote the original to ⏭️ Deferred or mark it "superseded" —
   Deferred means _"scope superseded by another task,"_ which doesn't fit a
   split; it strands the original's history, comments, and inbound dep refs.

**Merging** two tasks is the same shape in reverse: nominate the merge candidate;
the orchestrator confirms and routes it. A grooming session never performs the
merge itself.

### Unsplittable test

If the task **genuinely cannot be split** — a tight cluster that must land
atomically (e.g., a schema migration paired with all its consumers, or a
refactor whose intermediate states don't compile) — proceed with the original
task. The _"unsplittable"_ framing **is** the gate. If you cannot articulate a
concrete reason the work has to land in one PR, **the task can be split** —
default to split. _"It's all related"_ is not a reason. _"Intermediate states
don't compile"_, _"the migration and its readers must roll together to avoid a
NULL window"_, _"the rename touches every callsite by definition"_ — those are
reasons.

### Per-task header line (required, not optional)

Every Code task in the batch carries an explicit _Size:_ line in its
header — alongside _Hard-block:_ — same shape as the dep line, same
"implicit-by-omission is how it gets skipped" lesson:

> **① 💻 Code — Add HLTV RSS dedupe by GUID** · _Hard-block:_ none. · _Size:_ ~120 LoC.
> **② 💻 Code — Backfill GUID column on existing raw_queue_files** · _Hard-block:_ ① (this batch). · _Size:_ ~80 LoC.
> **③ 🔧 Operational — Migrate phase-deriver state into Postgres** · _Hard-block:_ none. · _Size:_ ~720 LoC, **unsplittable** (migration + reader rollout must land together — intermediate state leaves resolution_review pointing at a dropped table).

Always write the _Size:_ line. _Skipping it is the failure mode this section
exists to prevent._

Design and Planning tasks are sized in open-question count, not LoC; the
_Size:_ line is optional on those (or write _Size: n/a (Design/Planning)_).

## The 4-point summary (per 🔲 Backlog task)

Each task's header line carries its **Type** marker (💻 Code / 📐 Design / 🔧 Operational /
🔎 Investigation / 📋 Planning / 🧪 Testing / 🚦 Gate / 📝 Docs / 🎨 Assets) before the title —
so the reader sees at a glance what kind of work is being groomed. Code and Design tasks need
different review attention (Design locks specs; Code consumes them; Operational /
Investigation sit beside both); surfacing the type makes that judgment immediate and reduces
"wait, is this the one that…" friction during sign-off.

Type is not cosmetic here — it determines **what happens when you flip the task to
🗂️ Ready** (see `procedures.md` § _Task types — what Ready triggers_):

- **💻 Code** Ready with no unsatisfied dependency → **the orchestrator auto-dispatches
  it unattended.** Marking it Ready _launches_ the work; a wrong `Depends On` or an
  unresolved open question becomes a broken worktree session, not a review comment. Treat
  the Code Ready-flip as a deploy, not a paper approval — this is why the sign-off + dep
  - size gates exist.
- **📐 Design / 📋 Planning** Ready → **not** auto-dispatched; it waits for `/design`.
  Do not groom these expecting a worker to pick them up.
- **🔧 Operational / 🔎 Investigation / 🧪 Testing** Ready → interactive (a human runs it), not
  auto-dispatched. Before promoting one, check it isn't smuggling dispatchable code: any pure
  code-generation portion with no dependency on implementation-time data should be
  **split out into a separate 💻 Code task** (per the size/split procedure) so it flows
  through auto-dispatch — the Operational/Investigation/Testing task keeps only the
  interactive remainder.
- **🚦 Gate** Ready → never auto-dispatched; a human runs the Manual Verification Gate
  once, at the end of the milestone. It rests at 🗂️ Ready and **accretes** manual-
  verification items as code tasks are groomed (its type's defined lifecycle), and is
  presented **last** (Step 4 — gates last).

Format: **`<n> <Type emoji + label> — <title>`**, e.g. **`① 💻 Code — Add HLTV RSS dedupe by GUID`**.

Then the five points:

1. **What it achieves** — one sentence: the goal and why it matters to the system.
2. **Open questions** — ambiguities, unresolved design decisions, or pre-implementation
   checks. Ground these in the code-map digest and the context pages, not the task body
   alone. Write **_None._** if genuinely clean. A `# TODO` / `pass` placeholder upstream
   means the chain is contaminated — surface it, don't paper over it.
3. **Automated tests** — what the task's `### 🤖 Automated tests` section will verify.
4. **Manual verification** — enumerate the runtime / launch-and-observe items this
   task contributes to the milestone gate, read from the task body's pre-groom
   `### 👁️ Manual verification` section when present. If the task has no such
   section, or no standalone runtime item, write _None._ The groomer accretes these
   items onto the milestone gate store via the gate-accretion route before the
   Ready-flip (see Step 4 — Gate accretion), then removes the section from the task
   body entirely — it is not replaced with boilerplate. Omitting accretion loses the
   test permanently: the item is stripped from the body and never lands on the gate
   store.
5. **Operational seed** — the operational data/config seed this task contributes to the
   milestone config-seed run: a prod-data row/flag/default deliberately kept out of its
   auto-dispatched PR (e.g. an `analyzer_configs` row, config defaults, alias/cohort flags).
   Write _None._ if it has none. The groomer accretes the seed(s) onto the milestone seed
   store via the seed-accretion route before the Ready-flip (see Step 4 — Seed accretion).
   The array field is `seeds`, not the gate's `items`. Omitting accretion loses the seed
   permanently: the code sits dark after merge until someone hand-seeds it.

Then, at the end of the batch, under a **Context (no action needed)** heading, list
the non-Backlog tasks by name + type + status — same Type-first convention as the
main entries so the type-at-a-glance reading holds across both blocks.

Close every batch with exactly this ask:

> Any changes or questions before I mark these Ready and continue?

## Consolidated triage (interactive 📐 Design / 📋 Planning types)

Interactive types don't get a per-task 4-point summary + per-item sign-off. They
get **one consolidated triage** for the batch — the presentation side of
approve-by-standard (`../SKILL.md` Step 2 / Step 4 § approve-by-standard).
Auto-dispatched **💻 Code is unaffected**: it keeps the per-task summary + per-task
human decision above (a wrong Code Ready launches an unattended worktree, so the
stakes demand per-item gating). A mixed milestone runs both flows.

**Format — three groups, one message:**

- **Clean** — a **names-only** list. Each is a genuine, decision-shaped,
  answerable-now, scoped open-question set. These promote **by default (visible +
  veto-able)**; the human need not stamp each.
- **Blocked** — one row per task **+ its blocking dep** (an upstream Design/Planning
  task not yet ✅ Done). Answerable only once the upstream locks.
- **Needs-attention** — one row per task **+ the reason** (no real questions /
  already-decided / not-answerable / mis-shaped / missing `## Open Questions`
  heading / a routed constraint-conflict).

The human engages **only** the blocked + needs-attention rows; silence on the clean
list is approval. Close with the same sign-off ask.

### The clean-verdict standard

A proposed `clean` verdict is the groomer's judgment call — earned by the
investigation posture (arch-page reading, code exploration, anchor grounding), **the
sole non-server backstop** once the per-item decision is removed. The server then
applies a **deterministic floor** that can only ever **downgrade** a proposed
`clean`; it never upgrades a judged `blocked` / `needs-attention` back to `clean`:

- **Hard-block dep not ✅ Done → `blocked`.**
- **Missing `## Open Questions` heading → `needs-attention`.**
- **A binding constraint dispositioned `conflict→route` → `needs-attention`**
  (force-downgrade — not clean until the routed Design task resolves).

The floor deliberately does **not** consult the Tier-2 deferral-phrase lexicon: that
lexicon is **advisory-only for Design** (a legitimate design deferral like _"decide
during implementation"_ trips the phrase but is normal design scoping, not a
readiness violation). Taxonomy: `clean` = an answerable-now, decision-shaped
question; `blocked` = answerable only after an upstream locks; `needs-attention` = no
real questions / already-decided / not-answerable / mis-shaped / missing heading.

## Sign-off vs iteration

The closing ask invites content. The human's reply may be: _"all good, ship"_
(sign-off), _"yes but widen task 2 to also cover X"_ (sign-off **with** an
iteration item), or _"no — these aren't Ready because Y; we need a new task
for Z and task 3 should be deferred"_ (iteration only, no sign-off).

The third case is the dangerous one. A confidently-phrased substantive reply
can read like a verdict. **Don't paraphrase it into a "lock."** When the human's
reply contains any unaddressed change — a new sibling task to file, a scope
correction, a reframed acceptance criterion, a deferral — the cadence is:
apply each edit per Step 3 (one item at a time, confirmed in chat), then
re-present the batch (or a focused diff of what's changed) and ask the closing
question again.

Mixed replies (sign-off with one rider) collapse to two messages: apply the
rider, confirm in chat, then mark the rest Ready. Never glue the rider into
the sign-off and skip the re-confirmation.

Sign-off is explicit approval of the batch as presented (or as re-presented).
Approved phrasings: _"looks good"_, _"ship it"_, _"next"_, _"mark them Ready"_.
**Not** approved: a substantive reply paraphrased into a lock. When in doubt,
ask: _"To confirm — apply your edits and then mark the rest Ready, or hold the
whole batch for re-presentation?"_

## Example shape

> **Batch 1 — ingestion freshness (3 tasks)**
>
> **① 💻 Code — Add HLTV RSS dedupe by GUID**
>
> - _Achieves:_ stops re-ingesting unchanged HLTV items, so downstream normalizers
>   don't reprocess. Matters because the raw queue is single-writer and append-only.
> - _Open questions:_ None. (Verified `RawPayload.guid` exists in `ingestion/rss`.)
> - _Automated tests:_ dedupe drops a duplicate GUID; distinct GUIDs pass through.
> - _Manual verification:_ None (task body carried no manual-verification section).
>
> **② 📐 Design — …**
>
> **Context (no action needed):** ④ 🔧 Operational — Wire CI table audit (🗂️ Ready) · ⑤ 📐 Design — … (🔄 In Progress)
>
> Any changes or questions before I mark these Ready and continue?
