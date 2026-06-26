# Anti-patterns — why this skill exists

These are the failure modes grooming routinely falls into. The skill's structure
(deterministic load, cached code reads, batch sign-off) exists to make each one
hard. Read them before you groom.

**Resolving without reading code.** Producing decisions from the task body alone
misses real gaps — a Pydantic field named differently than a downstream task
assumes; a store-interface method another task imports that doesn't exist yet; a
`RawPayload` shape that diverges from what the normalizer expects. Open the actual
code (or its code-map digest) before declaring an open question resolved.

**Skipping / compressing Step 1.** The deterministic load is large and front-loaded,
so a single agent under context pressure shortcuts it and "decides whatever." That
is the entire reason `groom-load.mjs` exists — let it do the load; don't hand-fetch.

**Locking an external API surface without a live call.** Search summaries and
community docs are unreliable for third-party APIs. Hit the real endpoint once
before locking a design that depends on its shape.

**Silently widening scope.** If grooming reveals a sibling task is needed, *create
the sibling*. Don't quietly grow the original task's scope to cover it.

**Locking sequencing in the task body instead of the `Depends On` property.**
The Notion `Depends On` property is the **only** thing downstream sessions
consult to know what blocks a task. Sequencing prose written into the task
body — *"Best worked after the X task"*, *"Pick up last in M9"*, a numbered
ordering in the Context section — is invisible to downstream sessions. They
read the property; they don't re-read the body for hidden ordering. If you
locked sequencing during grooming, it MUST be reflected in the property at
the same `notion-update-page` call that flips the task to 🗂️ Ready (Step 4).
A common variant of this failure: writing the sequence to the body during
the batch discussion and then "remembering to mirror it to the property
later" — by which point the task is already at Ready and downstream
sessions have already started reading the (empty) property.

**Misclassifying a hard prerequisite as soft-order.** The test is concrete:
*"if I started B before A is Done/Ready, what specifically breaks?"* If you
can name the break (CI fails because the schema column doesn't exist; the
import statement references a symbol that isn't yet defined; the analyzer
emits a `kind` that hasn't been registered with the alarm rules table), it's
hard-block — and goes in the `Depends On` property. If you can't name a
concrete break and just have a feeling that *"A's spec informs B's shape"*,
it's soft-order — and stays a batch-level conversation, not a property
write. Misclassifying a hard prereq as soft produces a Ready task that
explodes the moment a worker picks it up; the inverse (calling soft hard)
just causes mild over-sequencing and is much cheaper to recover from. **Lean
toward hard-block when the dep names a symbol or migration; lean toward
soft-order when the dep names a decision or informing investigation.**

**Treating the size check as cosmetic.** The 500-LoC default is **load-bearing**,
not advisory. Every Code/Tooling task in a batch carries a *Size:* line in its
presentation header, and `size_check` is a required field in `grooming-state.json`
that the promotion gate enforces — a task without a recorded size classification
is blocked at promotion, same as a task missing `hard_block_deps`. The most common
failure: estimating the size, *thinking* about whether to split, but not writing
the classification down and not naming it in the header. The 500-LoC bound only
constrains behavior when sessions present and lock the estimate; otherwise it
silently dilutes.

**Promoting oversized Code/Tooling tasks without splitting.** The temptation is
to wave a 1,200-LoC task through because it *"feels coherent"* — but a Code task
that big is one no one can review, and the implementation session that picks it
up will either burn out or silently scope-creep. Split into ≤ 500 LoC subsets
unless the task is **demonstrably unsplittable** (see `presentation.md` § Size
check). *"It's all related"* is not a load-bearing reason; *"intermediate states
don't compile"* / *"the migration and its readers must roll together"* are.
When in doubt: split. A two-PR landing is cheap; a one-PR that can't be reviewed
is expensive.

**Demoting the original task to ⏭️ Deferred when splitting.** ⏭️ Deferred means
*"scope superseded by another task"* and is intended for tasks the project chose
not to do. Using it as a tombstone for the pre-split version of a now-split task
is a misread that produces three real costs: the original loses its accumulated
history and comments (Notion treats Deferred as essentially-closed), any inbound
`Depends On` references to the original now point at a closed task (and need
rewriting one-by-one to the post-split siblings), and the "Deferred" record
itself is junk that clutters board views forever. **Correct shape:** edit the
original task **down** to one of the planned subsets — keep its Notion ID,
history, and inbound refs — and create the N-1 *other* subsets as new sibling
tasks at 🔲 Backlog. The original task becomes one of the N split tasks; no
Deferred record needed. See `presentation.md` § Size check § Split procedure.

**Leaving "TBD" placeholders.** A `# TODO` or `pass` in upstream code — or in an
upstream task body — means that upstream task isn't actually Ready and the chain is
contaminated. Surface it; don't groom on top of it.

**Calling something resolved when it's just deferred.** "Decide at implementation
time" is a *defer*, not a *resolve*. Either lock the answer now or keep it as an
explicit Open Question. Don't launder a defer into a resolution.

**Promoting unilaterally.** Even when a task looks Ready-clean, the human is the
gate. Present the batch and wait for sign-off. Never self-grant promotion.

**Treating batch pushback as sign-off.** The close-out ask is *"Any changes or
questions before I mark these Ready and continue?"* — so the human's reply is
*expected to contain content*: a corrected scope, a missing sibling task to
file, a reframed acceptance criterion, an assertive framing of how something
should work. **That content is iteration data, not approval.** The correct
response is: apply the feedback (per Step 3 — one item at a time, confirmed in
chat), then re-present the batch (or a focused diff) and ask for sign-off
*again*. Never paraphrase the human's pushback (*"Recording the framing —
locking 1, 2, 3 with task 4 widened…"*) and stamp `signoff` into
`grooming-state.json`. A sign-off is explicit approval of the batch **as you
presented it** (or as you re-present it after edits) — not your synthesis of
what the human said in reply. Diagnostic: if your next action is to write
`signoff` to state and the human's prior message contained any unaddressed
edit, correction, or reframe, you are about to commit this anti-pattern. Stop,
apply the feedback, re-present.

**Editing a Ready/Done task.** Tasks at 🗂️ Ready or beyond may already be picked
up. If their scope was insufficient, file a new sibling task — do not retroactively
rewrite them.

**Treating ⏭️ Deferred as "do later."** This is the most common misread of the
Deferred status. **⏭️ Deferred means *"scope superseded by another task"* —
the work is accounted for elsewhere, the task itself is final.** It is the
*sibling* of ✅ Done, not a parked-Backlog. Consequences:
- Deferred tasks **do not appear in batch presentations** — not as targets, not
  in the *"Context (no action needed)"* list, not in dep chains. They are
  invisible to grooming.
- A `Depends On` reference to a Deferred task is **satisfied**, not blocked
  (same as a reference to a Done task). The superseding task does the work; the
  Deferred reference is historical.
- If you find an in-flight task with a `Depends On` pointing at a Deferred
  task, that's a stale dep worth flagging — the dep should probably point at
  the superseding task instead. Surface it in the batch discussion, but don't
  silently rewrite.
- *"Park this for a future milestone"* is **NOT** Deferred. That's an
  intentional 🔲 Backlog item with no current activity (or a new milestone
  board entirely). Deferred = closed, supplanted, final.

**Overriding a load-bearing constraint with task wording.** When a task's text
conflicts with an architectural non-negotiable (Store-Interface Rule, UTC
timestamps, append-only stores, single raw-queue writer, UI-as-read-API-consumer,
findings-scoped-to-ingested-communities), the constraint wins. Surface the conflict;
don't silently follow the task.

## Inline grooming — the cadence applies whether or not /groom triggered the session

You don't escape the procedure by not invoking `/groom`. If a session is
investigating a task body, drafting acceptance criteria, weighing whether something
is Ready, or recommending a status promotion — that's grooming, regardless of how
the session started or whether the human used the slash command. Every anti-pattern
above applies; so do the rules in `../SKILL.md` and `presentation.md`.

The clean dividing line:

- **Filing a new 🔲 Backlog task** as it occurs to you (during implementation, bug
  investigation, design execution, anything else) is *idea capture*, not grooming.
  Do it freely — `check-task-status.mjs` allows it.
- **Promoting 🔲 Backlog → 🗂️ Ready** is grooming, full stop. It requires the
  loader cache (so the procedure-mandated context is actually loaded, not skimmed)
  and the recorded human sign-off in `grooming-state.json` (so the
  `groom-gate.mjs` hook lets the Ready promotion through). Neither exists in an
  inline session.

**The safe exit from inline grooming work is to stop at 🔲 Backlog.** Draft the
task — body, dependencies, scope, what the investigation found — and file it at
Backlog. Tell the human: *"this needs grooming; run `/groom <M>` when you're ready
to bring it to Ready."* Then stop. Do not promote in the same session.

If you genuinely need to land at Ready before this session ends, stop and invoke
`/groom <milestone>`. The loader picks up the work-in-progress on the next pass and
the procedure resumes — your investigation is not wasted.

The single most common inline-grooming failure: conflating task **creation** with
promotion to Ready in one ask — *"create this on the M9 board at 🗂️ Ready"*. The
hook chain blocks this by design — `check-task-status.mjs` refuses creation at
non-Backlog status, and `groom-gate.mjs` refuses Ready promotion without recorded
sign-off. The blocks are the gate, not the smell. **The smell is trying.**

The related laundering pattern is calling an Open Question *"non-blocking"* or
*"pin during implementation"* to justify a Ready promotion from outside the
procedure. That's the *"Calling something resolved when it's just deferred"*
anti-pattern above, dressed up. Same anti-pattern, same response: lock the answer
now (one more investigation probe usually finishes it), or file at Backlog with the
question preserved verbatim.

## Design-task execution inherits the cadence

When a 📐 Design task moves to 🔄 In Progress, the execution session keeps grooming
discipline: surface unilateral decisions for sign-off one at a time (don't batch-lock
Implementation Notes mid-discussion); file follow-up Code tasks that each get their
own grooming pass before Ready; and cascade any reversal explicitly through dependent
task bodies, the Key Decisions Log, the architecture pages, and the Manual
Verification Gate — never assume downstream readers will infer it.

Design-task execution is itself driven by the `/design` skill — but the same
*"inline grooming"* rule applies one level up: if a session is executing a Design
task without invoking `/design`, the design-execution cadence still applies. The
safe exit is to file the follow-on Code tasks at 🔲 Backlog and route any further
work back through `/design` and `/groom`.
