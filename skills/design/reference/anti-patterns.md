# Anti-patterns — why this skill exists

These are the failure modes a Design Execution session routinely falls into. The
skill's structure (deterministic load, cached investigation, one-question-at-a-time
sign-off, diff-gated page writes) exists to make each one hard. Read them before
you execute a design task.

The grooming skill's anti-patterns file has a short paragraph titled
"Design-task execution inherits the cadence" — this file is the long form of that
paragraph.

---

**Batch-locking Implementation Notes mid-discussion.** A Design task with five
open questions tempts a session to "summarize all five and move on" once the
broad direction feels right. Don't. Each question is its own sign-off, on its
own message, recorded in `design-state.json` before the next one starts. The
Implementation Notes are _the closing artifact_ — they get composed after every
question is locked, not as a running draft.

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

**Filing follow-on Code tasks past 🔲 Backlog.** New Code/Tooling tasks always
start at Backlog. The `check-task-status.mjs` PreToolUse hook will block
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
