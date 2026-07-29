# Anti-patterns — why this skill exists

These are the failure modes a Design Execution session routinely falls into. The
skill's structure (deterministic load, cached investigation, one-question-at-a-time
sign-off, diff-gated page writes) exists to make each one hard. Read them before
you execute a design task.

The grooming skill's anti-patterns file has a short paragraph titled
"Design-task execution inherits the cadence" — this file is the long form of that
paragraph.

---

**Shelling out a throwaway script to record the lock.** `design-state.json` and
`code-map.json` are loader-seeded JSON on disk. Writing a one-off `_q6lock.cjs`,
running it with `node`, then `rm`-ing it — usually as a single `cd … && node … &&
rm … && echo` chain — is the single biggest source of permission friction in a
design session: every token (`cd &&`, `node`, `rm`) prompts, for a JSON edit the
**Edit** tool (or **Read + Write** the whole file) does in one auto-approved call.
It feels like "doing it properly with real code," but it is strictly slower,
promptier, and leaves a temp file behind. Use the file tools; never shell out to
mutate the cache.

**Batch-locking Implementation Notes mid-discussion.** A Design task with five
open questions tempts a session to "summarize all five and move on" once the
broad direction feels right. Don't. Each question is its own sign-off, on its
own message, recorded in `design-state.json` before the next one starts. The
Implementation Notes are _the closing artifact_ — they get composed after every
question is locked, not as a running draft.

**Batching the state-write breaks resume-safety.** Distinct from batch-*locking*
above (which is about composing the Implementation Notes): this is deferring the
per-question **write to `design-state.json`** until finalization. Even when you
debate and sign off each question one at a time, if you only *persist* the locks
in a burst at the end, a crash mid-task loses every un-persisted lock — and the
skill's entire resume-safety promise (the loader preserves signed-off decisions
across runs) is void. Observed: Q2–Q4 of one task and all four questions of two
others were held un-written until finalization, and one late catch-up edit
corrupted the JSON. Write each lock the instant it's signed off, before the next
question — and **re-read the file after each edit to confirm it's still valid
JSON**. The Edit tool does this in one auto-approved call; there is no reason to
defer it.

**Treating pushback as sign-off.** The closing prompt is _"Debate this — where am
I wrong?"_ — so the human's reply is _expected to contain content_: a reframe, a
counter-assertion, a missing premise, an unconsidered option, a strong assertive
framing. **That content is iteration data, not approval.** The correct response
is: investigate the new content, fold it into the question, re-present the
recommendation (or a different one if it flips), and ask for sign-off again. The
incorrect response — the failure mode this entry exists to prevent — is to
paraphrase the human's pushback (_"Recording the human's framing…"_) and stamp
that paraphrase into `design-state.json` as the locked decision. A sign-off is
explicit approval of a recommendation **you** presented (_"lock A"_, _"go with
that"_, _"your recommendation"_, _"ship it"_); it is never your synthesis of
content the human just introduced. The danger sign: you find yourself writing
_"Locked. Recording …"_ in the same message that contained novel claims you
haven't yet investigated. Stop, undo the stamp, run the investigation, re-present.

**Locking an external API surface without a live call.** Search summaries and
community docs are unreliable for third-party APIs. If a question turns on the
shape of a response, hit the real endpoint once in Step 1b and cache the observed
shape under `.skill-cache/design/<M>/api-shapes/`. Cite the cached shape when
presenting the question. Designing against documented-but-not-verified shapes is
how a follow-on Code task discovers the spec was wrong at implementation time.

**Resolving without reading code.** Producing a decision from the task body
alone misses real gaps — a Pydantic field named differently than the design
assumes, a store-interface method that doesn't yet exist, a `RawPayload` shape
that diverges from what a downstream task expects. Open the actual code (or its
cached code-map digest) before declaring a question resolved.

**The task body's premise can be stale — verify it, don't just answer it.** A
Design task's Open Questions are not the only thing to investigate; the **facts the
body states** are equally suspect. A body written a milestone ago may assert a
method or field already exists, that "there's no single target task," that some
subset "isn't session-stageable" — and be wrong now. Investigation repeatedly
caught exactly these (an `updateBody` that *was* already session-stageable, a "no
single target" that *had* one, a mis-scoped stageable subset) — but only because a
premise happened to get checked. Make it deliberate: **falsify the body's premises
before you build decisions on them.** A wrong premise silently poisons every lock
layered on top of it, and no downstream groomer will catch it.

**Inventing an answer a sister project already validated.** When a question designs
a capability a more-mature managed project has likely already solved — an off-box
backup, a real deploy trigger surface, an arch-page structure, a resource-isolation
model — reaching for a from-scratch recommendation without checking that project is
a wasted, lower-confidence guess. Read the sister project's arch pages / `context.md`
/ code as prior art *first* (the project index in `procedures.md` names them). The
highest-leverage moves in real sessions have been exactly these cross-project
checks — each turned an invented answer into a validated one. Cite what the sister
project does when you present the question.

**Calling something resolved when it's just deferred.** "Decide at implementation
time" is a _defer_, not a _resolve_. Either lock the answer now, or carry it
forward as an explicit Open Question in the body of the follow-on Code task.
Don't launder a defer into a locked decision — the Code task's groomer will only
catch it if it's surfaced.

**Silently widening scope of an in-flight Design task.** A surprise during
execution — a sibling decision the original task didn't anticipate — is **not**
licence to stretch the current task's scope. File a sibling Design task at
🔲 Backlog and let `/groom` handle it on its own pass. Widening silently leaves
the upstream Notion task body out of sync with what was actually decided.

**Editing a Notion arch page without showing the diff first.** Always present
the exact added/replaced text in chat and wait for _"okay"_ before calling
`notion-update-page`. The 7 context pages and the Future Scope page are
load-bearing for every downstream session — silent edits there are the most
damaging mistake this skill can make. See `page-edits.md` for the protocol.

**Filing follow-on Code tasks past 🔲 Backlog.** New Code / Operational /
Investigation tasks always start at Backlog. The `check-task-status.mjs` PreToolUse hook will block
creation at any other status, and the block is the gate, not the smell — the
smell is _trying_. If a follow-on task feels ready-to-implement, that's the
groomer's call, not yours. File it Backlog and let `/groom` decide.
(Body-level sign-off on the draft is **not** required — Backlog is the gate.
The skill drafts + creates; the human reviews at groom time or edits the
Notion page directly if a correction is needed sooner.)

**Skipping Step 1b investigation.** Going straight from "loaded the task body"
to "here are my recommendations" is the load-bearing failure mode. Without code
reads / live API calls / arch-page reads, the recommendations are guesses
dressed up as analysis. Step 1b is what separates this skill from a chat
session about the task.

**Skipping the completeness-critic pass.** Answering every Open Question is not the
same as designing the whole task. The questions cover the decisions the *author*
foresaw; they routinely miss the gap an *implementer* will hit — a durability /
recovery path, a second consumer that also reads the surface, an interaction with an
existing sweeper or scheduler, a loader / trigger / deploy step the spec silently
assumes, an unstated premise. The mandatory Step-3 critic pass ("what would an
implementer hit that no question owns?") exists precisely because these gaps don't
announce themselves. Run it on **every** task, including — especially — the ones that
feel complete; the surprises surface on exactly those. Then **dispose every gap**
(fold / note / file-sibling / sibling-owned); a found-but-undispositioned gap is the
same failure as never running the pass. The orchestrator's advisory **trace-coverage**
signal feeds the sweep as an **aid, never a gate** — a clean signal is not evidence the
critic ran — and every candidate's disposition is recorded in the durable
**completeness-disposition store** (`accepted|dismissed` + reason), never body prose and
never silently.

**Trimming the question set to make it "feel right-sized."** A design task with many open
questions is not a signal to *drop* questions down to a tidy count — question-count is a
soft diagnostic (`>~6` is a prompt to look at splitting), not a numeric gate, and it is
**not** wired into `size_check`. A genuinely too-large decision space is **split**: file
sibling Design tasks (the `file-sibling` disposition) and carry the questions there.
Trimming to hit a number silently discards decisions the implementer still has to make.

**Silently deciding not to capture something explicitly needed.** The worst outcome
of a defer isn't a wrong destination — it's *no* destination, chosen quietly. When a
decision needs recording (a defer-to-future-scope, a superseded assumption, a
cross-cutting note) and its obvious home isn't in the pre-loaded context bundle, the
failure mode is to conclude "there's nowhere to put this" and move on. There almost
always **is** somewhere: Future Scope always exists (a standalone page in some
projects, a `## Future Scope` section of the Master Context page in others), and every
arch page is in Notion, trivially searchable. The loaded bundle is a convenience, not
the edge of what exists. If you can't find the home, **surface the gap to the human**
— never let a needed capture die silently. A design session that quietly drops a
required capture has left the project's record wrong without anyone deciding to.

**Folding the decision summary straight into the Notion write.** After every question
locks (and the critic pass is dispositioned), the in-chat **decision-summary draft**
is a hard checkpoint, not a formality — draft it in chat, show it, get the _yes_,
*then* write. The drift this prevents: skipping the draft and composing the summary
directly into the `notion-update-page` call, so the human never sees the closing
synthesis before it lands in the task body. The draft is cheap and the last place a
misframed lock gets caught; don't optimize it away.

**Promoting unilaterally.** Even when a decision looks obvious — even when the
human says "I trust your call" in some earlier message — the explicit sign-off
on _this_ question is the gate. The human can wave through quickly ("yes, that
one"), but the wave must happen.

**Marking a Design task ✅ Done before its work is actually complete.** Done
means: every open question is locked + every architecture-page edit in
"Notion pages affected" is applied + every follow-on Code task is filed at
🔲 Backlog + the Design task's Implementation notes are written. All four,
or it isn't Done. The skill _does_ mark Done itself once those four are
finished — Design tasks have no PR-merge downstream, so there is no In Review
holding step. But premature Done — before the page edits ship, before the
follow-ons are filed, before Implementation notes are written — breaks the
pipeline assumption that downstream sessions can trust Done as a signal.

**Editing a ✅ Done Design task.** Don't. If a Done design was wrong, file a
follow-up Design task (sibling) that explicitly supersedes it. Retroactive
edits leave every Code task that was groomed against the original spec stale
without anyone noticing.

**Treating ⏭️ Deferred as "do later."** Deferred means _"scope superseded by
another task"_ — the work is accounted for elsewhere, the task itself is
final. It is the sibling of ✅ Done, not a parked-Backlog. The skill does not
surface Deferred tasks in the executable set, the prioritization proposal, or
the dep chain — they are equivalent to Done. A `Depends On` reference to a
Deferred task is satisfied (not blocking), same as a reference to a Done task.
_"Park this for a future milestone"_ is **NOT** Deferred — that's 🔲 Backlog
on this board or a future-milestone board entirely.

**Overriding a load-bearing constraint with task wording.** When a Design
task's body conflicts with an architectural non-negotiable already locked in
an arch page (Store-Interface Rule, UTC timestamps, append-only stores,
single raw-queue writer, UI-as-read-API-consumer, etc.), the constraint wins.
Surface the conflict; don't silently lock a decision that violates it. If the
constraint _should_ be revised, that's its own Design task on the arch page —
not a side-effect of this one.

---

## Recommendation-quality checks — how you form the recommendation

The entries above mostly catch *process* failures; these catch a subtler class — how the
**recommendation itself** is formed before you present it. They cluster with **Treating
pushback as sign-off**: the places a human pushes back are the richest signal, and each of
these is a recurring push-back direction made preventable. Run them as a pre-flight on every
recommendation.

**Reaching for new machinery before checking reuse.** The instinct to *build a mechanism* —
a new surface, message type, store, or field — before asking whether existing primitives
already compose to the need. (Real case: a proposed new message surface that `send_message`
already covered.) This is the code-review "reuse before you add" instinct applied to design.
**Before recommending any new surface / message / store / table, state explicitly why the
existing primitives don't compose.** If you can't articulate the gap, there probably isn't
one — recommend the reuse.

**Under-reading "advisory / non-blocking" as "toothless."** When a constraint calls a
component *advisory* or *non-blocking*, that does not mean it does nothing. (Real case: a
Tier-3 signal framed as "informs but never decides" that the human actually wanted to **route
back**.) The failure is collapsing "holds no hard veto" into "has no effect." **Pin exactly
what authority the thing is advisory _to_, and what it still drives** — routes, annotates,
escalates, feeds a later gate. "Advisory" scopes authority; it doesn't remove it.

**Claiming system state — "exists / shipped / runs" — without checking.** _"The task body's
premise can be stale"_ applies just as hard to your **own** premises about the system. (Real
cases, some this very session: "the critic is already shipped" when it was local-only, not in
the repo; "the CLI doesn't wrap reclassify" read off a stale vendored copy; "the reopen bug is
fixed" without confirming the deploy.) Three axes are load-bearing and routinely mis-asserted:
**shipped-vs-designed**, **local-vs-repo**, and **runs-the-skill-vs-adapts-the-precepts** — the
M12-era **dispatch model** (whether a session *consumes the skill* or is *injected procedure*)
is itself a premise that, mis-modeled, flips downstream answers. Never state "exists / shipped
/ runs / is fixed" as a premise of a recommendation without a check. Verify, then assert.

**Recommending a mechanism you haven't verified _works_.** The sibling of the entry above:
that one is about premises on *existing* state; this is about the mechanism a recommendation
*proposes*. It is just as easy to confidently float a mechanism that doesn't actually work —
and lock a decision on it. (Real case: a confirm-gate and a PreToolUse hook were both floated
as the enforcement path *as if they worked*, and neither did; the decision only came right
after a cheap test proved `--resume` **does** re-read `--allowed-tools`.) **When a
recommendation rests on an unverified mechanism — "this hook fires," "resume re-reads X,"
"that API rejects Y," "the classifier blocks Z" — falsify it with the cheapest possible probe
_before_ you lock, not after.** An "extraordinary claim" about how a mechanism behaves is a cue
to run the one-line test, not to assert harder. The lock is only as sound as the mechanism
under it — and a mechanism is cheap to check and expensive to discover broken at implementation
time.

**Defaulting to recommend-broad when the operator wants minimal scope.** The pull to apply a
good safeguard *everywhere* it could plausibly help (a new check in /design + /groom +
authoring + dispatched, when the operator wanted "only in /design for now"). This sits in real
tension with **disposition-don't-drop** (surface everything), and the resolution is precise:
**surface the broad option, recommend the minimal scope, let the operator expand.** Don't drop
the wider possibilities — name them — but default the *recommendation* to the smallest scope
that solves the actual problem, not the largest that could. Broad-by-default spends the
operator's review budget arguing scope back down.

---

## Inline design execution — the cadence applies whether or not /design triggered the session

You don't escape the procedure by not invoking `/design`. If a session is locking
spec decisions in a Design task, drafting follow-on Code tasks, or proposing
architecture-page edits — that's design execution, regardless of how the session
started. Every anti-pattern above applies; so do `presentation.md` and
`page-edits.md`.

The clean dividing line:

- **Drafting a follow-on task at 🔲 Backlog** as design surfaces it is idea capture
  — file it freely.
- **Locking decisions into a Design task's Implementation notes, applying
  architecture-page edits, or moving a Design task → ✅ Done** is design
  execution. It requires the per-question sign-off cadence and the diff-then-apply
  page-edit protocol. Neither runs automatically in an inline session.

**The safe exit from inline design work is to stop at 🔲 Backlog.** File the
follow-on tasks. Surface the open questions in chat or in the Design task's body.
Tell the human: _"the rest of this needs a design session; run `/design <M>`."_
Then stop. Do not write Implementation notes or apply page edits in the same
session.

If you genuinely need to close a Design task in-session, stop and invoke
`/design <milestone>`. The loader picks up the work-in-progress and the procedure
resumes.

The single most common inline-design failure: writing the Design task's
Implementation notes from a single message that summarizes "all the decisions" —
exactly the batch-locking anti-pattern at the top of this file, dressed up.

## When the question can't be locked here

Some questions surface during design that the skill cannot resolve — they need
the PM, the data team, a partner system owner, a security review, etc. Don't
launder these as locked decisions either. Two recoveries:

- **Route to owner**, mark the question `routed` in `design-state.json` with
  the owner and the asked-question text. The Design task waits for the owner's
  answer before it can close.
- **Carry forward**, drop the question into the body of the follow-on Code
  task as an explicit Open Question. The Code task can't reach Ready until
  `/groom` resolves it (or routes it again).

Either way: the question doesn't get "decided at implementation time" by
accident.
