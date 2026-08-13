---
name: gate
description: >-
  Run the Manual Verification Gate for a milestone against the gate-state API
  (readiness → pull runnable items by tier → human disposition → record).
  Use when the user says "run the gate", "gate check", "verify the gate for
  milestone X", or starts a Manual Verification Gate pass. Requires the
  gate-verification service's gate_item / gate_item_event tables and the
  backend's /api/gate/* routes to be live for the target milestone.
---

# Manual Verification Gate

The gate is orchestrator-tracked state, not a task-body checklist. Every
verification item lives as a `gate_item` row with a classification and a
state machine (`open` → `runnable` → `pass` / `fail` / `deferred`, with
`Prod-Mutating` passes parked at `pending-approval` until a human consents).
Every attempt is a `gate_item_event` — that log **is** the durable run
record. There is no dated run-note to write back into a task body, and
nothing here is loaded by fetching and parsing a Notion task's body.

This skill is a thin human-driven loop over the gate-state API
(`packages/backend/src/routes/gateState.ts`, business logic in
`packages/backend/src/gate/gateService.ts`), called through the sanctioned
node client `gate-state-client.mjs` (loopback-only, device-authed — never
shell out to Notion or hand-fetch a task body for this).

```bash
node ~/.claude/scripts/gate-state-client.mjs <command> ...
```

`gate-state-client.mjs` is the vendored sanctioned node client (see
`packages/backend/scripts/gate-state-client.mjs`, re-vendored via the
`/sync-guidelines` skill), using `$ORCHESTRATOR_DEVICE_TOKEN` (host/port
default to `127.0.0.1:3000`, overridable via `$ORCHESTRATOR_BACKEND_HOST` /
`$ORCHESTRATOR_BACKEND_PORT`) the same way the other sanctioned session
clients (`groom-context-client.mjs`, `staged-intents-client.mjs`) do. If
`ORCHESTRATOR_DEVICE_TOKEN` is unset, **stop** — this skill only runs inside
an orchestrator-launched session.

---

## Core doctrine — read this before running a gate

**The whole point of a gate session is to take verification work off the
operator.** Its job is to conserve the operator's time, not spend it — to supply
the method, the judgment, and the push itself. The most expensive failure this
skill can commit is **handing the work back**: declaring an item "not closable
this session," "needs you to drive," dropping it at the first `partial`,
**mass-deferring items you never actually tried to stage**, or offering an
option-menu ("which do you want?") where the session could have just done the work
and reported the result. Every one of those spends operator time that the gate
exists to save. **Deferral is the disposition-shaped version of the same hand-back**
— "hard to observe" is a cue to *stage the behavior*, never to `deferred` it (Step
3); reserve `deferred` for the genuinely-rare-and-unsafe-to-manufacture item punted
to a later milestone. So the governing rule, above all the mechanics below:
**exhaust the observe-by-reading path and _act_; never declare an item un-closable
or hand it back — as an escalation *or* as a disposition — until you actually have.** Escalation is legitimate
only for a real decision that is the operator's to make, a genuinely blocked
resource, or `Prod-Mutating` consent — never as a substitute for doing the
observable work.

> **Tier decides _how_ you close a hard-to-observe item — "stage it, never defer it" is not
> tier-blind.** The push above is right, but it has been applied too flatly: staging a wedged-group
> recovery drill was correct; staging a cgroup-OOM test on the live host was not. Read it as:
>
> - **`Prod-Mutating` → _simulate_, don't perform.** Reproduce the *condition* the item describes
>   without mutating real state — a scratch object, a forced code path, a synthetic row. If the only
>   way to observe it is to actually harm production, you do not stage it.
> - **Trigger hasn't fired → _park_ it with a trace guide, via the `not-yet-triggerable`
>   disposition.** Wait for the natural occurrence instead of forcing one. Parking is **not**
>   deferral and **not** a hand-back — *provided* it carries the trace guide below. This is the
>   legitimate third path between "stage it" and "defer it", and its absence is what made this
>   doctrine read as all-or-nothing. *(This was the `Opportunistic` tier's job; that tier is retired
>   and the disposition now carries it — the item parks at `pending` on a backoff clock.)*
> - **`Human-Observation` → a person observes it.** No headless session can ever pass one; it
>   surfaces to the operator through the Decision Inbox.
> - **`Read-Only` → just go read it.** Unchanged — and it now also covers the bounded,
>   cleanly-reversible scratch write.
>
> **The trace guide is what makes a park legitimate** — and it is no longer only convention: the
> server **rejects** `not-yet-triggerable` without non-empty evidence naming the observable to
> watch for. Every non-resolving disposition (`noted`,
> `needs-setup`, a parked `not-yet-triggerable` item) records **the exact observables to capture when the
> behavior fires**: which table or log, which field, which value separates pass from fail, and the
> query that will settle it. A park with a trace guide is a *prepared* verification the next session
> executes in one step; a park without one is a punt wearing better clothes. This pattern emerged
> organically across a real run and earned its keep — treat it as the standard content of any
> non-resolving disposition.

The six disciplines below are how that rule is kept:

- **Code ≠ verification.** A passing unit test does **not** close a gate item. A
  behavior lives in the gate precisely because it is rare / runtime and a
  code-level test can't exercise it — so verification means *observing the
  behavior actually occurred* (in the system's own history, or live), never that
  the code looks correct. If a unit test could settle it, it was never a gate item.
  **Concretely: "the code is deployed and its unit tests pass" is _not_ a pass** —
  that reasoning has closed items that then had to be reopened. There is no
  passed-because-I-read-the-code.

- **Verify by reading history first.** Most gate items describe a behavior that
  has **already happened** in the orchestrator's own operational record — so the
  first-line strategy is to go read it, not to stage a fresh live scenario. Before
  any staging, look for a past real occurrence in `audit_log`, `session_events`,
  `pull_requests`, `local_branches`, and the git/GitHub record (`git -C <repo>
  log/show …`, `gh pr/run …`). This was the single most productive method across a
  full gate run; **staging is the fallback for behaviors history can't show.**

- **Exhaust observe-by-reading before declaring "needs a human."** "Hand this to
  you / not this session" is **buck-passing** when the read-history path hasn't
  been exhausted. Concrete tells of the failure, all seen in real runs: **giving
  up at the first `partial`** instead of reaching for `gh` / `git` /
  `session_events` / the code; **handing over an option-menu** ("which do you
  want?") instead of doing the work; **reaching for a heavy harness** (rebuilding
  a rig to re-run a check) before asking the cheap question — *has a Done 🧪
  Testing task already verified this?* A gate session's job is to *observe*, and to
  reach for the **harder** pass rather than pawn it off; escalate to a human only
  after reading the operational record genuinely fails to settle the item — or the
  check is `Prod-Mutating` (which needs consent by design, a different thing).

- **Verify before you claim.** Don't assert a state — "this was mis-accreted,"
  "there's no route for X" — until you've checked the source. Falsify the claim
  against the code / data first; an over-claim recorded as `evidence` pollutes the
  durable event log. And **prefer the operator's account of what they did over an inference from
  timing or logs** (`procedures.md` § Performance / host monitoring, rule 7) — a 26-second gap was
  read as automation in one run when simply asking would have settled it.

- **"Verified" is a word with a definition — don't narrate past your evidence.** The disposition
  vocabulary is server-enforced; **your prose is not**, and prose is where this gate's central
  distinction actually gets blurred. **"The code is deployed and the behavior never occurred" is not
  verification** — it is deployment plus absence of contradiction, which is precisely the reasoning
  *Code ≠ verification* exists to reject. Real run: an item was narrated as *"I verified that item
  directly"* on exactly that basis. The recorded disposition was correctly `noted`, so the durable
  record stayed clean — but the narration asserted the one thing this gate exists to police. **Say
  what you observed, in the words of the observation.** *"Code deployed, no occurrence in the
  record"* is an honest sentence; *"verified"* is a claim about a behavior you watched happen. **If
  you cannot name the event you observed, you did not verify it.**

- **Query defensively — a documented trap you have *read* is still a trap you will walk into.** A
  wrong query here returns a **confident wrong answer**, not an error, and this skill's entire output
  is built on such queries. Five vacuous reads in one run, three of them traps this project's own
  `context.md` documents explicitly: a filter on `local_branches.task_id` (**no such column**);
  `LIKE '%recover%'` matching 50 pushbacks containing the word "recovered"; a **truncated task-id
  prefix** reading the wrong task as Done; grepping `projected free memory` when the emitted string
  is `projected free host memory`; and concluding the memory gate emits nothing when **the log line
  lives at the caller**. **Reading the warnings is not the same as querying defensively.** Before you
  believe a result: confirm the column exists, print one raw row, check your match string against the
  *emitted* string, match ids in full, and confirm the zero you got could have been non-zero. Every
  count that will appear in your report is a claim to validate, not a fact.

> ⚠️ **Two non-obvious staging constraints (both have bitten real runs):**
> - **A remote-control session cannot mint a per-session stage credential.** Items
>   that need a live backend session to stage (the `85f0ad1d`-class — anything
>   requiring a real device/session-scoped stage) can't be staged from an RC session.
>   That does **not** make them unverifiable-so-defer — it means they're verifiable in
>   a **live orchestrator-launched session**; route them there rather than deferring.
> - **A Ready-flip on an auto-launch project auto-dispatches.** Marking any 💻 Code
>   task Ready on an auto-launch project immediately launches an unattended worktree —
>   so any staging that flips a task to Ready has a live side-effect. Stage with
>   **scratch tasks** and clean rollback (archive scratch, restore survivors); never
>   flip a real task to Ready just to observe.
> - **Filing a 🔲 Backlog task on an *armed* milestone is not inert.** The rule above covers a
>   Ready-flip; this is its quieter sibling. Where auto-launch is armed, a task filed at **Backlog**
>   can be groomed, implemented, reviewed and merged **unattended** — one filed task was merged
>   **28 minutes later** while the session recorded "left at Backlog, not groomed" as the end state.
>   *"I left it at Backlog"* describes what **you** did, not where the task ends up. When you file a
>   follow-on mid-gate, say so, and re-read its state before reporting.

> **Expect to hand off the final mutating step — that is the stable shape of an RC gate session, not
> a failure.** The harness reliably permits the entire analysis path and blocks the last
> state-changing action: a systemd write, a wrapped-marker `POST`, and a `group-commit` were all
> blocked in one run while every read and diagnosis ran clean. **Plan for it: do the full analysis,
> then stage the handoff as one paste-able command** with its expected output — rather than hitting
> the block mid-step and improvising. This is *not* the `Prod-Mutating` consent gate (a deliberate
> design feature); it is the harness permission boundary, and it lands on actions this skill
> otherwise treats as routine.

---

## Step 0 — Resolve the milestone

Determine the milestone (e.g. "M12") from the user or the active context. Do
not improvise one — ask if it's ambiguous.

## Step 1 — Check readiness

```bash
node ~/.claude/scripts/gate-state-client.mjs readiness --milestone <M>
```

Returns `{status: 'green' | 'blocked', blocking: GateBlockingItem[]}`.

- `green` — every item in the milestone is `pass` or `deferred`. Report this
  to the human and stop; there is nothing left to run.
- `blocked` — `blocking` lists every item not yet resolved, with its
  classification and current state. Use this as your worklist map, but pull
  the actual batch to work through the API in Step 2 — don't disposition
  straight off this summary list, and don't bulk-load the whole blocking set
  at once.

## Step 2 — Pull one runnable tier at a time

```bash
node ~/.claude/scripts/gate-state-client.mjs next --milestone <M> [--classification <C>] [--limit <N>]
```

Returns up to `limit` (default 10) `runnable` items from **one** tier. Tier
pull order, when `--classification` is omitted: `needs-triage` →
`Read-Only` → `Prod-Mutating` — untriaged items surface
first, then increasing blast radius. Never request the full runnable set;
always let the server pick or explicitly scope one tier.

An empty array means that tier has nothing runnable right now — either move
to the next tier explicitly via `--classification`, or re-run without a
classification to let the server advance to the next non-empty tier.

## Step 3 — Disposition each item, then record it

For every item in the pulled batch:

1. Read `item.text` (and `node ~/.claude/scripts/gate-state-client.mjs item <id>` for
   the full record, including prior `events`, if you need history before
   re-attempting one).

2. **Pre-flight — cross-check Done 🧪 Testing tasks.** Before staging any
   live/E2E check, ask whether a **Done 🧪 Testing task already owns this
   validation.** If one does, the item is a `pass` (**covered-elsewhere** — the
   behavior is done, just done by another task; cite the covering task in evidence,
   e.g. `covered-elsewhere: <taskId>`, **not** a `deferred`), and the only real
   question is _"what would I do here that the Testing task hasn't?"_ Don't re-run
   what's already been observationally verified.

3. **Verify by reading history first** (Core doctrine). Go find a past real
   occurrence in `audit_log` / `session_events` / `pull_requests` /
   `local_branches` / `git` / `gh` **before** staging anything. A behavior found
   in the operational record *is* a pass — record the pointer to it as evidence.
   Only when history genuinely can't show the behavior do you move to an active
   check (step 4). Remember **code ≠ verification**: reading the source to confirm
   a code path exists is not the same as observing the behavior happened.

4. **Perform the active check** the item describes (only when reading history
   didn't settle it):
   - **Read-Only** — mechanical or low-risk checks you can
     run and judge directly (read code, hit a read endpoint, inspect
     output).
     - **Scratch-write convention:** a **self-contained scratch write with clean
       rollback** (a throwaway scratch task you create and archive, restoring any
       survivors) is **`Read-Only`**, not `Prod-Mutating` — its blast radius is
       bounded and reversible. Reserve **`Prod-Mutating`** for a flip of **real**
       state (a real task's status, a real config row). This removes the recurring
       hesitation on staging checks that only ever touch scratch objects.
   - **Prod-Mutating** — do **not** self-grant a pass. These are
     non-mechanical: surface the exact action to the human, get their
     explicit go-ahead before performing anything that mutates production,
     and never mark one `pass` without a human present for it.
   - **needs-triage** — the item's classification isn't resolved yet, usually a
     **backfill artifact** (an entire milestone can land as `needs-triage` — M11
     did). Read `item.text` and judge which tier it belongs to (mechanical
     read-only check or bounded scratch write → `Read-Only`;
     anything that mutates production → `Prod-Mutating`). When you're confident,
     reclassify **before** dispositioning — **don't** guess a class or disposition
     the item blind:

     ```bash
     node ~/.claude/scripts/gate-state-client.mjs reclassify <gateItemId> <classification> [operator]
     ```

     `classification` must be one of `Read-Only`, `Prod-Mutating`, `Human-Observation`
     — the server rejects anything else, including `needs-triage` itself. Once
     reclassified, the item is picked up by its new tier on the next `next` pull
     (and by the continuous reconciler's auto-run path for
     `Read-Only`/`Prod-Mutating`). Classification affects blast-radius tiering (a
     `Prod-Mutating` reclassify changes what needs consent), so treat it as a
     triage decision: surface your proposed class to the human before applying, and
     if you're genuinely unsure which tier fits, flag it rather than reclassify
     blind.

5. Record the attempt as an event — this is what makes the log durable; do
   this for **every** attempt, not just resolving ones:

   ```bash
   node ~/.claude/scripts/gate-state-client.mjs event <gateItemId> \
     '{"disposition":"pass","evidence":"<what you observed>","deploySha":"<verified-sha>"}'
   ```

   **The disposition vocabulary is a server-enforced closed set** (`GATE_DISPOSITIONS`,
   `gateService.ts` — shipped in PR #941): the API **rejects** anything else with a 400, so
   an invented value (`blocked-unexercised-by-value`, `partial-…`) can no longer become a
   bespoke non-resolving state. `disposition` is also **optional** — an event with *no*
   disposition is a pure log entry (records `evidence`, leaves state unchanged). Put nuance in
   `evidence`, never in a made-up disposition:

   | disposition | rollup effect | when |
   | --- | --- | --- |
   | `pass` | ✅ resolves | behavior **observed** — in the operational record (history) or by live staging. Evidence: `verified: <what you observed>`, or `covered-elsewhere: <taskId>` (a Done 🧪 Testing task / sibling already verified it — *done* = **pass**, cite the task; **not** a deferral) |
   | `deferred` | ✅ resolves | **genuinely rare AND unsafe/impossible to manufacture**, punted to a later milestone to verify there — rare last resort, never "I didn't stage it" (`moved-to-<milestone>: <why>`) |
   | `discarded` | ✅ resolves (non-blocking) | the item is **void / mis-accreted / created in error** — not real work and **not** a next-milestone deferral. Terminal, audit-preserving, **requires evidence**. Where a mis-keyed / orphaned `gate_item` goes — **not** `deferred`. |
   | `fail` | ❌ stays blocking | behavior is **broken** — file the fix as a Code task (`filedFollowon: <taskId>`); the item stays unresolved, re-verified after the fix deploys. "Record `fail`" is not a resolution. |
   | `noted` | non-terminal (stays `runnable`) | "attempted, not yet resolved" — records the event + evidence without advancing state. The sanctioned home for a non-resolving attempt (or just omit `disposition`). |
   | `needs-setup` | non-terminal (stays `runnable`) | the verifier's bounded best-effort **abstain** — records the attempt; `next` skips the item until a later event supersedes it. |
   | `not-yet-triggerable` | non-terminal (advances to `pending`) | **`Read-Only`/`Prod-Mutating`-only, and requires `evidence`** — the triggering condition genuinely hasn't happened yet (no occurrence in history, nothing to stage). Enters a backoff schedule; `next` skips it until the backoff clock elapses, then it resurfaces `runnable` for a fresh look. |

   **Rules the vocabulary encodes:**
   - **"Hasn't happened yet" on a `Read-Only`/`Prod-Mutating` item is `not-yet-triggerable`, not
     `deferred`.** `deferred` means punted to a *later milestone*; `not-yet-triggerable`
     means the same milestone, waiting on its own backoff clock for the trigger to occur
     naturally. Don't reach for `deferred` just because nothing has fired yet — that's
     what `not-yet-triggerable` is for, and it keeps the item live in-milestone instead of
     punting it.
   - **"Hard to observe" means _stage it_, not defer it.** Staging is the fallback for
     exactly the behaviors history can't show (Core doctrine). `deferred` is **not** a bin
     for "code-reasoned," "never-occurred-in-prod," or "too fiddly to set up" — those are
     stageable, and mass-deferring them to clear the board is buck-passing dressed as a
     disposition. Reach for the harder observation *before* you ever type `deferred`.
   - **A broken behavior is not `fail`-and-done — it stays blocking.** File the fix as a
     Code task and **leave the item unresolved**: record the finding as an event with
     `filedFollowon: <taskId>` for the log, but the item does *not* resolve — it's pending
     the fix, re-verified after that fix deploys. "Record `fail`" is not a resolution, and
     a `fail` state correctly does not clear the rollup.
   - **A mis-accreted / orphaned item → `discarded` (with evidence), never `deferred`.**
     Deferred means punted-to-a-later-milestone; a void item that should never have existed
     is `discarded` — terminal and non-blocking, but audited.
   - **A compound item that won't isolate → split it** into atomic `gate_item`s
     (`task-writing.md` § atomic gate items), don't force a bespoke disposition.
   - **Two known vocabulary gaps — name them in `evidence` rather than forcing a fit.**
     - **Legitimate work that is genuinely unobservable and should _not_ carry forward** has no
       disposition that fits. `deferred` says punted-to-a-later-milestone (it *will* carry forward);
       `discarded` says void / never-real-work (it wasn't). One run used `deferred` plus a prose
       exception — which works **exactly once**, and thereafter reads as an ordinary punt to everyone
       downstream. Until the vocabulary gains a term, put the exception in the **first line** of
       `evidence` and flag it in the report; never let the disposition quietly misrepresent the item.
     - **`needs-setup` conflates "tried and couldn't" with "never got a session."** Because `next`
       skips the item, a **transient** failure becomes **permanent invisibility** — a capacity error
       silently shelved **28 items** in one run. Whenever you record `needs-setup`, state in
       `evidence` which of the two it was and what would change it. **General rule for any
       non-resolving disposition that hides an item from the pull: it must distinguish an attempt
       that failed from an attempt that never happened**, or a transient fault becomes a permanent
       one.

   **`deploySha` is load-bearing on a pass tied to a source commit — record it,
   don't treat it as optional.** It documents the exact SHA the behavior was
   verified against (evidence hygiene). It also guards a historical bug where a
   pass recorded without `deploySha` was auto-reopened when the item's
   `min_deployed_commit` filled on a later deploy; that reopen is now fixed in
   source (a pass is terminal for runnability — `gateService.ts:118`), but record
   `deploySha` regardless — belt-and-suspenders, and correct if your prod predates
   that fix. Also include `evidence` (freeform — text, a link, an `audit_log` /
   transcript excerpt) and `filedFollowon` when a fix was filed rather than fixed
   in place.

   > **Resolve `deploySha` at the moment you write the event — never carry one across a session, and
   > never back-correct in bulk.** On a live-deploying system production moves *during* the run (four
   > times in one night), so a SHA resolved at session start is already stale when you use it, and
   > chasing stamps is a treadmill: one run corrected **nine** and had **five more** go stale behind
   > it. Re-resolve immediately before each `event` call. If stamps have already gone stale in bulk,
   > **that is not yours to chase** — say so and move on. The durable fix is **server-side stamping at
   > event-write time** rather than trusting a client that may be hours old; that is a finding to
   > file, not a thing to hand-correct.

   For a `Read-Only` item this resolves the item directly.
   For a `Prod-Mutating` item, a `pass` event parks the item at
   `pending-approval` — it does **not** resolve yet.

6. **Prod-Mutating consent step** — after a `Prod-Mutating` item reaches
   `pending-approval`, get the human's explicit sign-off on the recorded
   evidence, then:

   ```bash
   node ~/.claude/scripts/gate-state-client.mjs approve <gateItemId> [operator]
   ```

   This is the only way a `Prod-Mutating` item resolves to `pass`. Never
   call `approve` without the human having actually reviewed that item's
   evidence — it is the consent gate, not a formality.

## Step 4 — Loop

Repeat Steps 2–3 for the next tier/batch until `readiness` reports `green`,
or until the human wants to stop for the session (leaving remaining items
`open`/`runnable` for a later pass — nothing is lost, the state persists
server-side).

### Reporting discipline

For a gate, *how* you report is part of the deliverable:

- **Separate `pass` from `deferred` counts — every time.** Never report a single
  "resolved N" number: "resolved" blurs passes and deferrals, and a reader will hear
  "passed N." Say "**passed X, deferred Y**" explicitly, so the real verification
  count is never inflated by punts.
- **Surface the per-pass reason list by default.** For a gate, the reason-per-pass
  (what was observed, where) *is* the deliverable — give it proactively, don't wait
  to be asked. A pass with no stated evidence is indistinguishable from a rubber stamp.
- **Never groom or promote the fix tasks a gate surfaces.** Filing a follow-on Code
  task for a broken behavior is correct; bringing it to 🗂️ Ready is **not** this
  session's job — a gate session verifies, it does not groom. Leave filed fixes at
  🔲 Backlog. *(But see the armed-milestone warning above — "left at Backlog" is not the same as
  "inert.")*
- **Never claim a sweep is complete without re-pulling it, and never do arithmetic in prose.** Two
  overclaims in one run: a tier sweep (the then-live `Opportunistic` tier, since retired) was
  reported finished while `ca637934` sat untouched,
  and a "16 not yet runnable" count was simply wrong. Both were self-corrected — but the operator
  should not have to audit your arithmetic. Before saying "all X are done", **re-run `next` for that
  tier and paste what the API returns**; before quoting any number, derive it from a command's output
  rather than from your memory of what you did. A completeness claim is a claim (§ Query defensively).

---

## Corrective commands — reopen & reclassify

Two client commands correct a resolved or mis-tiered item; both are human-driven
triage actions, not routine disposition:

```bash
node ~/.claude/scripts/gate-state-client.mjs reopen <gateItemId> [reason] [operator]
node ~/.claude/scripts/gate-state-client.mjs reclassify <gateItemId> <classification> [operator]
```

- **`reopen`** — deliberately move a **resolved** item (`pass` / `deferred`) back to
  runnable when it needs re-verification: a regression surfaced, the deploy that
  the pass was recorded against was rolled back, or a pass turned out premature.
  This is the *sanctioned* reopen — distinct from the historical auto-reopen bug
  (a pass is otherwise terminal, `gateService.ts:118`). Record the `reason`.
- **`reclassify`** — set the classification of a `needs-triage` (or mis-tiered)
  item, as in Step 3. Changes blast-radius tiering, so it's a human triage call.

> These commands live in `gate-state-client.mjs`; if a live run reports "unknown
> command," the vendored `~/.claude/scripts/` copy has drifted behind the deployed
> backend — reconcile it by running **`/sync-guidelines`** (which re-vendors the
> client via a local-preserving merge). Never blind-`cp` the repo copy over the
> live one — that force-overwrite is exactly what got the old `deploy-grooming.mjs`
> removed.

---

## What this skill does not do

- It does not fetch or parse any task body — `gate-load.mjs` (Notion-body
  fetch) and `gate-parse.mjs` (body parsing) are retired; there is no
  in-repo equivalent to reach for.
- It does not write a run-note back to a task — `gate_item_event` rows are
  the run record.
- It does not bulk-load a milestone's full item set — always pull one
  classification tier at a time via `next`.
- It does not resolve a `Prod-Mutating` item without a human-approved
  `approve` call.
