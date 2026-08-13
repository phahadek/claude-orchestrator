---
name: investigate
description: >-
  Operator-driven, live-symptom investigation: turn a reported issue into well-formed
  🔲 Backlog tasks grounded in the live operational record, not memory. The upstream of
  /groom — grooming brings Backlog to Ready; this produces the grounded Backlog. Read-only
  diagnosis by default, with a spelled-out ladder for operator-authorized in-session
  mutations: pull a live-health snapshot (true deployed SHA, active milestone, errored +
  idle/killed planning sessions, failed deploys, GitHub-verified needs-attention PRs, the
  active board), reconstruct the symptom by value, root-cause to file:line under an evidence
  law that matches each claim shape to its admissible proof, frame (caused-vs-exposed,
  transient-vs-systemic, cascade/blast-radius, re-verify deployed state), classify
  (Code-vs-Design, check ✅ Done designs, recognize subsumption), then draft and file
  🔲 Backlog tasks with SHA-stamped file:line anchors + 🤖/👁️ acceptance. Use when the
  operator says "investigate X", "look into why Y", "something's wrong with Z — dig in", or
  points at a live symptom and wants grounded backlog out of it. Distinct from /ops's
  Investigation mode (which works a pre-filed 🔎 task on the board); this is ad-hoc and
  operator-pointed.
---

# investigate — turn a live symptom into grounded 🔲 Backlog tasks

`/investigate` is the **upstream of `/groom`**. Grooming brings `🔲 Backlog` → `🗂️ Ready`; this
produces the grounded Backlog. It takes an operator-reported symptom ("sessions are erroring after
the last deploy", "the design launch keeps failing") and turns it into **`🔲 Backlog` tasks rooted in
the live operational record** — not in what the code looks like it should do.

**Read-only diagnosis is the default posture.** Observe the record, root-cause it, file. Diagnosis
never mutates another session's git/PR/worktree to learn what it can read. An interactive run can
escalate to operator-authorized action (fire a verify/ops session, correct a status/Type, an
operator-granted DB write) along the ladder in **§ The mutation boundary** — never improvised, never
across the two forbidden lines (managed PRs; session worktrees/git).

The skill's value is a verification discipline that refuses to trust premises, statuses, or the
checkout HEAD, plus a repeatable **investigate → classify → file** loop. Follow it even when the
symptom looks like a one-line fix.

> **Not `/ops`'s Investigation mode.** `/ops` works a **pre-filed `🔎` Investigation task** already on
> a milestone board, under its journal/staging machinery. `/investigate` is **ad-hoc and
> operator-pointed**: there is no task yet — the symptom is the input, filed Backlog tasks are the
> output. It shares `/ops`'s by-value / falsify / root-cause disciplines but not its task lifecycle.
> If the operator points you at an existing `🔎` task, that's `/ops`.

This skill shares its planning-procedure core with `/groom`, `/design`, and `/ops` — see
`../_shared/reference/hard-rules.md` (canonical source
`packages/backend/src/planning/procedureCore.ts`): **deterministic load, not hand-fetch** (Flow step
2), **the operator is the gate** (nothing files without sign-off), **no silent writes**, and **`git
-C`, never `cd && git`**.

## What it is mostly (honest scoping)

Most rules this skill enforces already live in `config/procedures.md`,
`config/projects/claude-orchestrator/context.md`, and `config/task-writing.md`. This skill is not
net-new policy. It is three things made explicit and repeatable:

1. **The live-health snapshot loader** (`investigate-load.mjs`) — one read-only pull that starts every
   investigation grounded in what is actually deployed and failing, so you never diagnose against the
   checkout HEAD or from memory.
2. **§ Evidence law** — the claim-shape → admissible-evidence table that turns "falsify before you
   assert" from a slogan into a lookup.
3. **The investigate → classify → file loop**, with the **Code-vs-Design** and **subsumption**
   disciplines baked in, so a symptom becomes the right shape of task.

> **Scope — this is the *orchestrator's own* investigation flow.** The loop is generic; the loader and
> toolkit are orchestrator-specific — they read `dashboard.db` and its tables (`sessions`,
> `deploy_run`, `project_deployed_sha`, …). Investigating a **different managed project's** live
> issues (polimarket's analyst MCP / daemons / datastore) is **not covered**: that record lives behind
> its own surfaces. A generic multi-project `/investigate` depends on the board task *"Inject
> project-specific investigation instructions into dispatched sessions"* (`3a622f91-52f3-8171`, 📐
> Design, in progress). Until it lands, point this skill only at `claude-dashboard`.

## Invariants (hard rules — every run)

- **Read-only is the default; two mutations are forbidden under any grant.** Diagnosis is always
  read-only — never mutate to *learn* what you can read; the loader's DB handle is `{ readonly: true
  }`. An interactive run can take operator-authorized action, but only along the **§ The mutation
  boundary** ladder. Two lines no grant can authorize (`procedures.md` § Hard rule): (a) closing /
  merging / updating any **managed PR**; (b) any write to a **session worktree or its git** (push,
  commit, rebase, checkout, stash, editing files under `…/.claude/worktrees/…`, hand-editing
  `.git`/refs/HEAD). Fixes there ship as filed `🔲 Backlog` tasks. **Do not even propose crossing
  them.**
- **Deployed SHA ≠ checkout HEAD ≠ last-attempted deploy.** What is live is `project_deployed_sha`
  (the loader's `deployed.sha`) — not the checkout HEAD, not the target of the most recent
  `deploy_run`, which may have failed mid-step. Fixes land fast here: **re-verify deployed state
  before framing anything as still-broken**, and read the loader's `deployHint`. A symptom reproduced
  against HEAD may already be fixed in what runs, or the reverse.
- **The id-space traps** (all three cost real friction — do not re-derive by hand):
  - **Registry id vs config-dir.** The orchestrator's own id-space is **`claude-dashboard`** (the DB
    `project_id`, deploy report-in, gate/seed keys). The config-dir / Notion name is
    **`claude-orchestrator`**. The loader takes `--project claude-dashboard`; the config-dir name
    finds no project.
  - **`notion:`-prefixed task ids.** In the DB (`task_cache`, `audit_log.task_id`, session `task_id`)
    task ids are **`notion:<uuid>`**; board ids are bare uuids. The loader surfaces both forms
    verbatim — carry the right one to the right surface.
  - **Full-id matching only.** These boards' task ids share long structured prefixes
    (`3a622f91-52f3-81…`); the 8-4-4 short form is **not unique**. Match and join on the **full** id —
    a truncated `startsWith` / `LIKE '<short>%'` silently hits the wrong row.
- **The stale-belief trap — re-read a status live before asserting it.** Any status you read earlier
  this session may already be false. Statuses move in minutes: a task grooms Backlog→Ready, a PR
  merges, a session flips idle→done. Before asserting *"still Backlog"* / *"the session never did its
  work"* / *"that PR is still open"*, **re-read the row now.** Falsify-before-assert includes
  falsifying your own earlier reads. Near-misses from real runs: asserting "still Backlog" off a
  pre-groom read; calling a session's output "fabricated" off a stale transcript; verifying a PR with
  a **bare number against the wrong repo** (numbers are per-repo — use the loader's per-PR `repo` and
  its GitHub-verified `github`/`stale` fields, not `pull_requests.state`); correlating on the **wrong
  id shape** (bare vs `notion:` — use `taskIdForms`).
  - **Cadence: anything read more than a few minutes ago is *unread*.** On an active board "re-read
    before asserting" is too weak — statuses, board state, and code all move within the hour. This
    binds on three things it is tempting to exempt: **files you already read this session** (the
    working tree advances under you — re-read **at the deployed SHA**, `git -C <checkout> show
    <deployed-sha>:<file>`, not the checkout); **your own filed work** (a run asserted a third-party
    change was a mystery while describing a fix its *own* task had already shipped); and **any
    conclusion you carried forward from an earlier turn**. Three assertions in one run — "still
    Backlog", "unaffected by #1380", "still calls `onSelectIntent`" — were each false within the hour.
- **Never recommend an irreversible action against a session without reading its event stream.
  `idle` is not `abandoned`.** The universal form is a hard rule — `procedures.md` § Never recommend
  a terminal action against a session on status alone. A session's `status` records a transition, not
  activity (§ Performance / host monitoring, rule 6). Before recommending anything terminal against a
  session — conclude it, kill it, archive it, release its branch, clear its row — **read its
  `session_events`: last-event age AND total event count.** Real near-miss: a session was recommended
  for conclusion to free its branch, on the reasoning `idle + 33 hours + holding a branch =
  abandoned`. Its stream held **4,288 events of nearly-finished work**; acting on the recommendation
  would have destroyed it. Elapsed time and `idle` are the *absence* of evidence, not evidence of
  abandonment. This binds even while you are arguing that idle is not terminal — that argument was
  live in the same session that made this recommendation.
- **The transcript read is a precondition, not a recommendation. No claim about what a session did —
  or why — before you have read its `session_events`.** This is a **gate**: without the transcript you
  do not have a cause, and you do not state one. State rows, intent rows, and artifacts describe the
  **envelope**; they cannot distinguish *"the session never supplied it"* from *"the session supplied
  it and something ate it."* Real run: nine intent members all showed `groom_proposal = null` and the
  cause was reported as "the session didn't supply one" — the transcript, one query away, showed a
  **3,272-character proposal supplied every time**, silently discarded by the envelope. **A supporting
  base rate does not corroborate a cause you have not read the record for**: that wrong answer came
  decorated with 191/557 rows and looked well-evidenced. This was previously written as emphasis
  ("concluding from snapshot rows alone means you haven't read the transcript yet") and was violated
  repeatedly *while being believed followed* — hence a gate, not a reminder.
  - **The gate fires on the *shape of the claim*, not on how under-informed you feel.** This is the
    half that keeps failing. Any sentence of the form *"session S completed / didn't complete / ran to
    completion / stalled / skipped / never did Y"* trips it — **including one you feel you already
    know the answer to**, because feeling informed is precisely the state in which the gate gets
    walked through. Check the shape, not the confidence: if the subject is a session and the predicate
    is what it did, you need its stream, now, before the sentence. Real run: *"the polimarket design
    sessions ran to completion but didn't mark the task Done"* — inferred **entirely from current task
    bodies containing decisions**, i.e. the gate's own named substitution (read the artifacts instead
    of the stream) performed verbatim, in a run that had read and believed the gate. The transcripts
    showed the opposite: **grooming had pre-empted the design**. Cost: a whole analysis with its
    causality inverted.
- **Acknowledgement is not compliance — the next action is what agreement looks like.** Saying "you're
  right" and then proceeding with your own plan is a null response that costs the operator the
  correction twice. On accepting a correction: **state what you are doing differently, then do that**
  — not the plan you already had. A correction also **persists for the rest of the session**; a rule
  conceded once does not need re-conceding each time it applies. Both halves were flagged in a single
  run — agreeing-then-proceeding, and re-proposing a corrected action roughly ten times.
- **Ambiguous input: resolve it before acting — naming an ambiguity does not license acting on your
  reading of it.** **If you call an input ambiguous, you may not act on your interpretation in the
  same turn.** Ask, then act. Real run: a bare `+` was read as approval, *said aloud to be
  ambiguous*, and acted on anyway — tasks filed. Flagging the ambiguity and then proceeding is worse
  than either doing the thing silently or asking cleanly: it transfers the risk to the operator while
  keeping the action. One clarifying sentence costs a round-trip; a wrong read costs the filing.
- **Capture-don't-drop.** A durable learning — a load-bearing gotcha, a corrected fact, a
  newly-understood failure mode — does not die in the chat. Fold it into its home: project facts →
  `context.md`; task-authoring rules → `task-writing.md`; universal procedure → `procedures.md`. If
  the home isn't obvious, **surface the gap to the operator** — never conclude "there's nowhere to put
  this" (`procedures.md` § Never silently drop a needed capture). Capture during the run; a dedicated
  session folds it in. Don't derail the investigation to edit a guideline mid-flight. **Bank each item
  once.** Note a new capture when it appears and report the full set once, at close — re-listing the
  banked items every turn is noise that buries the run's actual output.

## Evidence law — the claim shape dictates the admissible evidence

Every instance of this failure is one mechanism: a cheap check returned a result consistent with the
hypothesis, and the search stopped. Reciting "falsify before you assert" does not prevent it — the
discipline has been recited and violated in the same session. What prevents it is mechanical. Before
stating a claim, find its shape here and confirm you ran **that** evidence.

| Claim shape | Admissible evidence | The cheap substitute that fails |
| --- | --- | --- |
| "X is not wired / not deployed / absent" — any **negative** | A search whose **scope you can state**: repo-wide `git -C <checkout> grep`, then read every hit | Grepping the file you expect it in. Real run: grepped `planningCandidates.ts`; the wiring was in `DispatchTriggerEvaluator` |
| "Session S did / didn't do Y" | **S's `session_events` transcript** and its prompt file | Its merged PR's file list. Artifacts cannot show a failed tool call. Real run: a session had flailed on an MCP search, failed, and blocked the pipeline — invisible in the diff |
| "At time T the state was Z" | **Point-in-time** rows: `session_events`, `audit_log`, event timestamps | A **current-state** column. The events under study are what mutated it. Real run: `siblingUndispositionedIntentsAtLaunch=0` read current state, but those intents commit after launch — it counted zero by construction |
| "X is by design / intentional" | A **quoted** docstring, comment, commit message, or design doc | Inferring intent from a naming difference. Real run: the docstring directly above the two predicates said the opposite |
| "X is **correct** / working as intended" — the step *past* "by design" | The **outcome** it produces, traced to the surface that consumes it: what does an operator actually get, end to end? | The **intent** behind it. A quoted docstring proves the behaviour is *deliberate*; it says nothing about whether it is *right*. The row above answers only the first claim |
| "Session S is abandoned / safe to conclude" | Its **event stream** — recency **and** volume | `status='idle'` plus elapsed time (§ Invariants) |
| "This behaviour is a bug" | The spec, docstring, or invariant it **violates**, quoted | It looked wrong. Real run: git refusing to create an existing branch is correct — "fixing" it would have let duplicate dispatch succeed silently |
| "Task / design Y already owns this" | **Y's quoted body** | Y's **title**. Real run: `3ab22f91-52f3-8159` was asserted to own a "no tasks needed" question on its title alone; its body owns "has the session finished staging?" — a temporal question, not a semantic one |
| "X is already fixed — the code is deployed" | The mechanism's **runtime input, by value**: does the key it looks up equal the key that is stored? does the event it binds to actually fire? does anything read what it serves? | Its **presence at the deployed SHA**. Deployed ≠ working (`Done ≠ deployed ≠ working`). **Passing tests are actively misleading here** — a test constructs both sides in one consistent form, so a format/id-space mismatch between producer and consumer cannot appear in it |

**"By design" ends one enquiry and opens another — the outcome question is owed in the same breath.** The
two claims *"this is deliberate"* and *"this is fine"* are different, and satisfying the evidence law for
the first is exactly what makes the second feel settled. So the moment you write **by design**, the next
sentence you owe — unprompted, without waiting for the operator to ask it — is: **what is the
operator-actionable surface here?** Trace it: who consumes this artifact, and what actually lands in front
of a person? Real run: depth-review escalation was reported as working-as-designed on a quoted
`pauseReason.ts` declaration plus the design's locked decisions. Both quotes were admissible — for
*deliberate*. Neither touched the outcome, and the outcome fell out of **one query** once the question was
finally asked: `/fix` composes from a verdict that is **empty by construction**. Intent is upstream
evidence; the outcome is the claim. Same family as "deployed but inert" below — a mechanism that is
present, sanctioned, documented, and produces nothing.

**"Deployed but inert" is the highest-yield class this skill produces — and the easiest to dismiss as
already-fixed.** Three modes, each needing a different by-value check:

- **Never matches** — the guard runs, but its lookup key never equals the stored key (an id-space or
  format mismatch). Check: read one real stored key and one real lookup key and compare them.
- **Never fires** — the handler is bound to an event the relevant path does not emit. Check: confirm
  the event is emitted *in the scenario that matters*, not merely that it is defined.
- **No consumers** — the route / metric / field serves correctly and nothing reads it. Check: grep the
  consumers repo-wide and count them.

Real run, all three in one session: the `ops_journal` orphan guard (present at the deployed SHA, never
matches — id-space mismatch), the trust-rate metric (route serving, zero consumers), and
termination-triggered re-review (bound to `session_ended`, which a waiting session never emits). Every
one would have been dismissed as "already fixed" on a source read.

**Validate the instrument before trusting what it returns — state the coverage.** A query is not a
read of the record until you know what it dropped. Before concluding from any filtered, joined, or
type-coerced query, **state the fraction of the population it covers**: rows returned vs rows that
exist. **A filter that drops more than ~20% of the population is not a read of the record** — it is a
sample, and must be described as one or widened until it isn't. Two decisive real failures:

- A transcript reader filtered to `text` + `user_message`, dropping **489 of 571 events**. The
  preceding command had already printed `{"system":489,"text":71,"user_message":11}` — the number
  proving the filter was discarding the bulk of the record was **generated, then ignored**.
  Conclusions from the remainder were reported as complete.
- An ISO-string comparison against **epoch-ms** columns matched zero rows, and "no sessions since the
  deploy" was read as a fact.

**Replicate a predicate *exactly*, or you are measuring a different question.** When you reconstruct
a check the code performs — a budget, a capacity, a coverage count, an eligibility filter — **copy its
predicate verbatim from the source.** Every condition you add that the code lacks, and every
loosening you allow that it doesn't, silently changes the question while the number keeps looking
authoritative. Two from one run: a gate dispatch budget computed with `archived = 0` — a filter **the
code does not have** — returned **9** where the real budget was **0**, and that single added condition
hid the root cause across a dozen reads; a route-coverage scan reported **5** unbound routes by
prefix-matching and **22** by exact match. Neither number was wrong arithmetic; both answered a
question nobody asked. **Paste the predicate, don't paraphrase it** — and when you must diverge, say
which condition you changed and why, in the same breath as the number.

**A zero or a thin result is a claim about the instrument before it is a claim about the world.**
Before reporting any zero, confirm the comparison can be true at all: types match, the filter value
equals what the *producer* writes, the id-space is the same (§ Invariants — the id-space traps). A
vacuous query and a real absence are indistinguishable in the output.

**Column types vary per table — print one raw value before reading meaning into a filtered result.**
The epoch-ms trap has an inverted twin: `deploy_run.started_at` is **ISO TEXT**, so a
`>= Date.now() - N` comparison returned rows from **22 July** presented as "since 03:35 today" — a
silent type coercion that produced plausible, wrong history. Don't assume a timestamp column's units
or type from a sibling table; **`SELECT` one row, look at the literal value, and confirm your
comparison can be true against it.** Related and equally cheap to prevent: **never conclude absence
from truncated output** — a `head -40` on a session list nearly became "those rows were deleted."
Truncation is your formatting, not the data's.

**State the disconfirming test in the same clause as the claim** — before the operator asks, not
after. *"Not wired — `git grep <sym>` across the checkout returns 3 hits, all in `<file>`."* An
assertion whose disconfirming test you cannot name in one clause is not ready to state.

**Timestamps spanning more than one day carry their date.** Format `YYYY-MM-DD HH:MM:SS`. Bare
`HH:MM:SS` collapses a multi-day window into an apparent single day and inverts before/after
conclusions — it did exactly that across a 36-hour window on a real run.

## The mutation boundary — read-only default, operator-authorized escalation

`/investigate` diagnoses read-only and files Backlog tasks. But a live interactive run reaches the
point where the operator says **"do it here"** — fire that verify session, fix that Type, clear that
stuck row, edit that architecture page. That is legitimate; ad-hoc-ing it is not. Sort every proposed
in-session action into one of three tiers by **who may authorize it**:

1. **Forbidden under any grant — never, even if the operator asks.** Closing / merging / updating a
   **managed PR**; any write to a **session worktree or its git** (commit, rebase, checkout, stash,
   editing files under `…/.claude/worktrees/…`, hand-editing `.git`/refs/HEAD). These are catastrophic
   and irreversible from the outside (`procedures.md` § Hard rule). A fix that lives there goes
   through the task → PR path, or the operator applies it inside the owning session. **Refuse and say
   why** — don't propose it.
2. **Explicit operator grant AND the harness gate — never self-granted.** A direct **DB state write**
   (clearing a stuck `deploy_run`, flipping a pause flag). An autonomous run **stages only**. When the
   operator asks: state *which* row, *from → to*, and *why*; then let the **harness permission gate
   prompt** — routing around a blocked gate is never allowed. **Apply → reconcile** (re-read the row)
   **→ report** the before/after.
3. **Fine on explicit operator instruction — a sanctioned surface.** Firing a session through a
   **sanctioned launch route** (verify / ops / re-dispatch); **speaking to a live session through the
   dashboard's own operator surface** (see below); a **status / Type correction** (a paper property,
   not code); a **doc / architecture-page edit** the operator directed. Do these when instructed,
   **echo back** exactly what changed, and capture-don't-drop anything durable.

> **The dashboard's own operator surfaces are tier 3 — the ladder sorts by *whose state* you touch,
> not by which transport you reach for.** The three tiers enumerate launch routes and DB writes, which
> leaves the orchestrator's **WS / API operator surface** unnamed: sending a message into a running
> session, rejecting a staged intent, a report-in. Reasoning from *"this is the same call a sanctioned
> route makes"* gets the right answer, but the category belongs here rather than being re-derived each
> time. These are the dashboard acting **as itself, on its own state, through an audited path a human
> drives from its UI** — not another session's git (tier 1), not a raw row write (tier 2).
>
> Concretely: the WS **`send_message`** an operator types in the UI lands on
> `SessionManager.sendOrResume` (`packages/backend/src/ws/router.ts`) — the **same** call the
> sanctioned Fix route makes in `packages/backend/src/routes/tasks.ts`. On explicit operator
> instruction it is tier 3: do it, then echo back the exact text and the session it went to.
>
> Two limits that keep it tier 3 rather than free. **It is an action, never a diagnostic instrument** —
> `sendOrResume` may **resume a parked session, spawning a process** (`ws/types.ts`), so it can change
> what you are trying to observe; never send to learn something you can read. And it stays inside the
> § Hard rule: talking to a session is not touching its git, worktree, or PR, and no message may ask a
> session to do on your behalf what tier 1 forbids you from doing yourself.

The read-only default still holds: exhaust the observe-by-reading path first, and treat every
tier-2/3 action as operator-initiated, surfaced, and reconciled — never a silent side-effect of
diagnosis.

> **Prefer a sanctioned route over a DB write.** Before escalating to a tier-2 raw write, check for an
> endpoint that already does it: orphaned staged intents clear via `POST
> /api/staged-intents/:id/reject` (`{outcome, reason}`), a deploy reports in via
> `/api/deploy/report-in`. A route is audited, reversible by design, and needs no grant-gated write.
> Reaching for a `.cjs` DB write before checking for a route is a common miss.

## Producing backlog vs maintaining it

The skill's core is *producing* grounded Backlog. An investigation also touches tasks that already
exist, and the rule there is flat:

> ### Never edit a filed task. File a new one.
>
> Not "unless it's still 🔲 Backlog". Not "unless nothing has read it yet". Not "unless the fix is
> obvious" or "unless I filed it myself, moments ago". **A filed task has left your hands.** If it is
> wrong, incomplete, or superseded: **file a new task**, and wire the dependency if it needs
> sequencing.
>
> The one exception is an edit **the operator raises and directs** — their call, made explicitly, for
> that specific edit. It is not a path this skill proposes, invites, or reasons its way into.

This replaces an earlier version that made editing conditional on the task's status. **That
conditionality is what got reached through** — it kept the edit conceptually available, and edits to
filed tasks were re-proposed roughly ten times across one run, after correction. The conditions are
deliberately not restated here: they were reachable *because* they were written down. No version of
the nuance is worth its cost — **file new** is always available, always correct, and never needs
adjudicating at the moment of action.

The reasoning, stated once so it never needs re-deriving: 🗂️ Ready **is** the operator's sign-off on a
specific scope, so an edit adds ungroomed content to a groomed task — possibly one already dispatched
and in flight. A 🔲 Backlog task may be **mid-groom in a dispatched session right now**, and an edit
desyncs that session. And editing any filed task erases the record of what changed, which is why
`procedures.md` § Task authoring carries the same rule. Checking `recentPlanningSessions` or the board
status is useful **context**, never a licence: a clear check does not convert an edit into a good idea.

## Two entry modes — cold-start vs operator-pointed

The Flow front-loads the full loader snapshot. That is the **cold-start** mode: the operator names a
fuzzy symptom (*"sessions are erroring after the deploy"*) and you need the whole live-health picture
to find the threads. Most interactive investigations are **operator-pointed**: the operator hands you
a specific referent — a PR#, a session id, a deploy run, a task — and the first move is a **targeted
read** of exactly that (its row, its prompt file, its transcript).

- **Cold-start** → run the loader first (Flow step 2); let the snapshot surface the threads.
- **Operator-pointed** → read the named referent directly; run the loader (or a scoped slice) only to
  **re-ground** — confirm the live deployed SHA, dedupe against the board, place the finding. Don't
  re-run the whole loader per symptom; a fresh targeted read is less stale than a snapshot taken
  minutes ago (§ the stale-belief trap).

The disciplines are identical either way (reconstruct-by-value → falsify → classify → file); only the
entry point differs.

> ### Cold-start scope floor — the latest deploy
>
> **Don't auto-open threads on symptoms that predate the currently-deployed SHA.** The snapshot is a
> rolling window: `erroredSessions`, `recentDeploys`, `needsAttentionPRs`, and `recentAuditEvents` all
> reach back past what is running now. Threads you **self-select** from it start at the **completion
> instant of the latest successful deploy.** Older entries are not live symptoms — they are history
> against code that is no longer deployed, and root-causing one costs a full investigation to land a
> task anchored at a `file:line` that may not exist in the deployed tree.
>
> Three qualifications, because this is a scoping rule and not a blindfold:
>
> - **It governs what you *auto-select*, never what you are *handed*.** An operator-pointed referent is
>   in scope at any age — the operator has already decided it matters.
> - **Reading pre-deploy history is always fine; *opening a thread* on it is what's scoped out.**
>   Baselines, caused-vs-exposed, blame, and deploy-instant correlation all require looking back. The
>   floor bounds what you investigate, not what you may read.
> - **A pre-deploy symptom that still reproduces after the deploy is a post-deploy symptom.** Re-check
>   before discarding: recurrence promotes it, and its pre-deploy instances become evidence of a
>   *class* rather than a separate finding.
>
> When the deploy itself is the subject ("the deploy broke X"), the floor inverts — the pre-deploy
> state is the control, and you need it.
>
> **Get the boundary by value.** Take the completion time of the latest **successful** deploy from
> `deploy_run` / `recentDeploys` — a *failed* run did not change what is running, so it is never the
> floor — and compare in the column's own units. An ISO string against an **epoch-ms** column matches
> nothing and reads as "no activity since the deploy" (§ Evidence law — validate the instrument).
>
> **Declare the floor with the count it excluded**: *"scoping to the 2026-07-31 14:22 deploy `<sha>` —
> 9 of 23 errored sessions predate it."* The floor is a filter, so it owes the same coverage statement
> as any other (§ Evidence law). An undeclared floor is indistinguishable from not having looked.

## The procedure loop

**reconstruct → root-cause → frame → classify → draft → present → file.** Each stage carries a
discipline that, skipped, is how investigations go wrong.

> **The loader orients; the logs produce findings.** The snapshot points at threads. Almost every
> genuine finding is cracked by **reading a session transcript or an on-disk injected prompt**, not by
> snapshot fields. Treat log-reading (step 1) as the **primary instrument** and the loader as the
> index into it. This is not emphasis — it is the **gate** in § Invariants: no claim about what a
> session did, or why, before you have read its `session_events`.

### 1. Reconstruct the symptom from the live record, by value

Don't take the reported symptom at face value, and don't reason from the code's *intent* —
**reconstruct what happened from the record**, by value with provenance.

- **What a dispatched session was *told*:** its injected prompt sits at
  `<checkout>/.claude/session-prompts/<session-id>.md` (verbatim `--append-system-prompt-file`
  content; the loader prints the path per errored session). A clean planning prompt vs an injected
  coding scaffold (*implement / Pre-PR Gate / open a PR*) is obvious at a glance — this is how
  prompt-contamination bugs get cracked.
  - **Blind spot — the pre-assembly fail-loud class.** A planning/ops session that dies *before* its
    prompt is assembled has **no prompt file**: the loader shows `prompt-file: (none — PRE-ASSEMBLY
    fail-loud …)` and flags `preAssemblyFailure`. Don't chase the missing file. The diagnostic is
    `last_error_detail` (`… dispatched … with no injectedProcedureContent — refusing to fall back to
    buildOrchestratorClaudeMd`) **plus** the launcher's log line: `journalctl -u orchestrator.service
    | grep "failed to assemble planning procedure"`. `OpsSessionLauncher` emits `[OpsSessionLauncher]
    failed to assemble planning procedure for task <id> (<sessionType>): <err>` — `<err>` is the root
    cause. The absent prompt file is itself the tell that assembly failed, not the session.
- **What it *did* — the session transcript is the highest-yield surface; treat it as a first-class
  step, not a fallback.** Most dispatched-session findings come from here, and from the **idle/killed
  planning sessions** the loader surfaces (a bungled groom/design/ops parks `idle` and looks fine; its
  transcript is where the bungle is). Two surfaces:
  - **The prompt file** (above) — what the session was *told*.
  - **The `session_events` transcript** — what it *did*. Each row has an `event_type` + `payload`.
    `event_type='text'` rows are **assistant turns**: payload is `{type:'assistant',
    message:{content:[…]}}`, and the `content` blocks are `text` / `thinking` / `tool_use` /
    `tool_result` — parse `tool_use` for the exact calls, `tool_result` for what came back,
    `thinking`/`text` for reasoning. `event_type='user_message'` rows are **plain operator text**
    carrying `[operator-disposition]` markers — read these for what the session was steered to do.
    Correlate against `audit_log` `process_boot` + `deploy_run` timing to place a failure relative to
    a deploy/restart. Query `session_events` from a **`.cjs` file, not `node -e`** (§ Toolkit — the
    double-quote trap).
- **The system's own account:** the loader's `recentAuditEvents`, `needsAttentionPRs`,
  `recentDeploys`, and `erroredSessions` are starting threads — pull the rows by value (the full
  `last_error_detail`, the full `pause_reason`, the deploy event `detail`).

**Every registered number, status, and stated cause is a claim to re-derive, not a fact.** The
loader's classifications and a session's stated error are starting points.

### 2. Root-cause to `file:line`, and falsify before asserting

- **Dig to the *proven* mechanism** — the exact code path/line, config row, or state that causes the
  symptom, demonstrated by value. Ask "why, really?" one level past where it feels done; that flips
  the answer more than half the time. Stopping short is legitimate only at a genuine external or
  access blocker.
- **Name the instrument that would settle it — and stop when you don't have that instrument.** By the
  third turn on any single question, ask: *what would actually settle this?* If the answer is an
  instrument this session lacks — a browser, a live UI, prod access, a run you cannot trigger — you
  have hit the **evidence boundary**. Stop reading, file the finding with an explicit *"could not
  verify: needs `<instrument>`"* caveat, and move on. Real run: six turns of static reading on a
  disappearing session panel that only a browser could settle, ending in exactly that caveat — two
  turns would have produced the same task. **More static reading does not convert into an instrument
  you lack**, and the caveat is a legitimate output, not a failure.
  - **But exhaust your instruments before declaring the boundary — declaring it early is the commoner
    failure.** Name the read-only instruments you actually hold and confirm each is spent: **DB tables
    — including the audit and *scheduler* tables** (`audit_log`, `scheduler_audit`, `deploy_run`, the
    `*_event` tables); **`journalctl -u <unit>`**; **`git -C <checkout> log / blame / show
    <sha>:<file>`**; the **live API**; the **served bundle**. Two misses in one run: *"needs a
    browser"* was declared with `git log`/`blame` **untouched** — they held the feature commit and two
    clean follow-ups; and many turns went into `journalctl` silence before `scheduler_audit` turned
    "unknown" into `status=ok, items_processed=0` in a single query. **Silence in one instrument is
    not absence of evidence — it is that instrument's silence.**
- **When the operator holds the one instrument you lack, ask for a single scoped observation — never
  ask them to diagnose.** This is not escalation; it is using an instrument (§ The session does the
  work). **Ask for one observation, and enumerate what each possible answer would mean** — a
  discriminating table, so their reply resolves the question rather than starting a discussion. The
  two moves that broke real deadlocks were exactly this shape: *"which of these four strings is in the
  panel?"* and *"is the element present at height 0?"* Each is a thirty-second look with a
  pre-committed interpretation attached. *"Can you take a look and tell me what's wrong?"* is the
  anti-pattern — it hands back the diagnosis you were there to do.
- **Run every claim through § Evidence law before stating it.** For any conclusion — "it's fine",
  "that's the cause", "a deploy fixes it" — find the claim's shape in the table and confirm you ran
  the admissible evidence, not the cheap substitute. State the disconfirming test in the same clause.
  This includes any status you are about to assert: re-read it live (§ the stale-belief trap).
- **Read one instance of the data before proposing a mechanism.** Structural reasoning about
  carriers, fields, schemas, and where a value *could* live — with no payload read — produces
  confident nothing. Real run: four turns proposing carriers for a proposal payload (a new intent
  kind, a group-level field, a designated proposal-bearing member) without reading a single
  `decisionProposal` payload; one query showed the mandated five-part synthesis **already existed**,
  in an intent kind that was already in the set and already being used for exactly that. Before
  designing a mechanism, **`SELECT` one row and read it.**
- **Find the precedent before proposing a mechanism — the same shape is usually already solved
  nearby.** Before designing anything, **search the same subsystem for how this shape of problem is
  already handled**, and prefer extending that to inventing a parallel path. Two worst turns of one
  run, both this: a gate-verifier fix proposed *checking tool calls* when the real answer was that
  auto-adjudication should not exist — *"replace a broken machinery by some extra broken machinery"*;
  and an ops-closure design anchored on `PRMergeWatcher` (a PR merge — wrong shape) while the correct
  precedent, `completeDesignTask`, sat **forty lines above code already read three times.** The
  operator's *"have you seen design tasks?"* was worth more than the next three queries.
  **Corollary — a deviation from a consistently-applied pattern is usually the defect, not a gap to
  fill with machinery.** When a system applies one rule everywhere (here: *sessions stage, the
  operator disposes*), the one place that departs from it is the bug. Fix the deviation; don't build
  a second mechanism to service it.
- **Before proposing a mechanism on "wording has already failed" grounds, check that the wording
  exists.** `procedures.md` § *When a documented rule keeps being violated, more wording is not the
  fix* licenses reaching past documentation for a mechanism — but its premise is **a rule that is
  already stated, explicit, and broken anyway.** That premise is a claim like any other, and it costs
  one grep: is this rule written down *anywhere today* — `procedures.md`, `task-writing.md`, the
  injected `procedureCore.ts`, the relevant skill? **Zero hits → wording is the correct lever, and a
  mechanism is over-engineering.** Hits → quote them, *then* argue the mechanism. Run the grep
  **before** you draft the mechanism, not after the operator names the cheaper lever. Real run: a
  `decision.pickOne` split was proposed as a mechanism fix by reflex from that section; the grep, run
  only once the operator had pointed at session instructions, returned **zero hits** — the rule had
  never been stated, so nothing had failed, and the proposal was duplicate tooling that did not need
  to exist. The reflex is strongest exactly where the check is cheapest.
- **An explanation of why the system might be right is not a finding.** On hitting something odd the
  reflex is *"is this actually correct?"* — not *"here is why this might be intentional."* A
  docstring, a naming convention, an apparent design symmetry: each is a **claim to check**, and the
  check is usually thirty seconds of reading directly above the code. Real run: *"a parked groom
  doesn't block, by design"* was inferred from a naming difference between two predicates while the
  docstring above them said the opposite. **When the operator rejects a rationale, drop it** — do not
  re-offer a weaker one (latency, performance, "probably deliberate") to salvage the position. That
  spends the operator's scrutiny defending a guess.
- **Read the source of truth first.** Before interpreting any zero, anomaly, or "looks broken", read
  the relevant architecture / findings / `context.md` section — it often documents the exact trap. Use
  `git -C <checkout> show/log/blame` (read-only) to anchor the mechanism to a commit and confirm
  whether it is in the **deployed** SHA.
- **To check whether a fix is deployed, test by *content*, not PR-head-SHA ancestry.** This repo
  **squash-merges**, so a PR's head SHA never becomes an ancestor of `dev` — `git merge-base
  --is-ancestor <pr-head> dev` is **meaningless** and will report a landed fix as missing. Check
  content: `git -C <checkout> show <deployed-sha>:<file>` and look for the fix, or find the squashed
  commit (`git -C <checkout> log <deployed-sha> -- <file>`, or grep the deployed tree).

### 3. Frame the finding

- **Caused vs exposed** — did a recent change *cause* this, or *expose* something latent? (Blame/log
  against the deployed SHA answers it.) The framing changes the fix and its priority.
- **Transient vs systemic** — a one-off (a killed session, a flake) vs a reproducible class. Only a
  systemic finding warrants a task; a transient one warrants a note.
- **Silent-success paths — can the record tell "no work" from "blocked"?** A component reporting
  `status=ok, items_processed=0` is **indistinguishable from a component that is wedged**, and it
  reads as healthy on every dashboard. When you find one, ask whether the record can separate the two
  cases — and **if it cannot, that is itself a finding**, independent of whichever case is live right
  now. Same family as "deployed but inert" (§ Evidence law), one layer out: there the mechanism never
  fires; here it fires, does nothing, and says so in the voice of success.
- **Re-verify deployed state** — recheck `deployed.sha` and the `deployHint` *now*. Fixes land fast;
  the finding may shift from "file a fix" to "already fixed; verify." Then **check it is actually
  working, not merely deployed** (§ Evidence law — "deployed but inert"). And **phrase the deployed
  status explicitly**: calling a recurrence a "second live instance" implies the fix never shipped. If
  the fix *is* deployed and the defect recurs by another route, say exactly that — ambiguous phrasing
  about deployed state invites a correction the operator should not have to make.
- **Cascade / blast-radius — the biggest miss if skipped.** Before committing to a fix, ask **what
  else assumes the thing this change touches?** A fix filed in isolation breaks an unstated assumption
  elsewhere. This is `/investigate`'s analogue of `/design`'s completeness critic, and it is not
  optional. Enumerate the consumers of the symbol / rule / state (`git -C <checkout> grep`, read the
  callers, check the intent-kind / dedup / status rule that touches it), then either widen the finding
  or name the cascade in the task. Worked misses: a "parallel open questions" fix that landed into a
  `decision.pickOne` dedup which ate all but the last question; a "Deferred semantics" fix that
  introduced a *blocked → stay at Backlog* rule that stalled grooming. Both would have been caught by
  "what consumes this?"
- **Solve the requirement, not its symptoms.** When the operator states a requirement — *"make
  c744fe03 canonical"* — the answer is the thing that satisfies it, not mitigations for what goes
  wrong while it stays unsatisfied. Real run: the answer offered was pause reasons and unarchiving,
  both mitigations for the session *not* being canonical; the actual answer — delete the 101 corpses
  so latest-started-wins resolves correctly — also freed the leaked slots the workarounds would not
  have. Before presenting, **re-read the operator's requirement verbatim and state how the proposal
  satisfies it.** A proposal that only reduces the pain of not satisfying it is a workaround: say so
  and keep looking.

### 4. Classify — Code vs Design, check Done designs, recognize subsumption

Decide the **Type**, and whether a task is the right output at all (`task-writing.md` § Code vs
Design; § Task types):

- **💻 Code (`🔲 Backlog` + a few open questions)** — the approach is clear; what's open is a few
  bounded confirmation points, each with an obvious recommended answer, resolvable at grooming. The
  default for a root-caused bug.
- **🔎 Investigation — for a live symptom you could not root-cause.** The classification axis is not
  only Code-vs-Design: **a Code task must be executable by a headless session with no browser, no prod
  access, and no live dashboard.** If your finding's first step is *"reproduce the failure in a running
  dashboard"*, a Code task is the wrong output — **the auto-dispatched executor inherits the exact
  evidence boundary you just hit** (§ 2), in a browserless worktree, with no way to say so. File a
  🔎 **Investigation** instead: it runs *interactively*, where the instrument exists, and **its output
  is the Code task** you couldn't yet write. Real run: a 💻 Code task was filed whose first acceptance
  step required a running dashboard. Test before filing: *could a headless worktree session finish
  this?* If no, it is an Investigation.
- **📐 Design** — only when resolving the open questions **mints a durable architectural decision the
  rest of the system must obey**, or the space is open (several viable approaches with real
  trade-offs), or the debate *is* the deliverable. A `/design` session is expensive. **"Has open
  questions" is not a reason to make it Design.** Cost asymmetry breaks ties toward Code.
- **Check ✅ Done designs before filing a 📐 Design.** Search the milestone boards (the loader's board
  + `notion-query.mjs` over prior boards) for a design that covers it. Re-proposing an already-decided
  or already-rejected design wastes operator time. If one exists, file the **follow-on** — a Code task
  against the locked decision, or a narrow reopen.
- **Recognize subsumption; promote a Future-Scope note when its trigger fires.** If an open board
  task, a Future-Scope note whose trigger just fired, or a prior resolution already owns the finding,
  **don't file a duplicate** — fold your evidence into the existing item, or propose promoting the
  note. The loader's board is the dedupe surface; match on the **full** id. **Ownership is decided by
  the body, never the title** — fetch the candidate's body and quote the owning line (§ Evidence law).
  A title compresses a task to a topic; two tasks on one topic routinely own different questions.
- **Consolidate same-region findings — a serial chain is a granularity smell.** Subsumption guards
  against duplicating *existing* tasks; this guards against fragmenting *your own*. Findings that edit
  the **same code block / rule set / function** are one task, not several hard-blocked in a chain:
  chaining A→B→C over one block serializes work that lands together anyway. Real tell: three tasks all
  rewriting the same `procedureCore.ts` design-rule block. Before filing N related findings, ask
  whether they are **one change to one place**; if so, file one task with N acceptance criteria.
  (Split genuinely independent work — this is about findings that co-locate.)
- **The third finding in one subsystem is a stop signal, not a third task.** Subsumption guards
  against duplicating others' tasks; consolidation guards against fragmenting one change. This guards
  against the worse failure: **filing around a cause you have not found.** At the third drafted
  finding in one subsystem, **stop drafting and ask what is underneath them.** Each can be
  individually defensible and the set still be a symptom list. Real run: blocked-member recovery, the
  pushback default, duplicate dispatch, gate-verify dedup, the crash budget, and a slot leak were six
  defensible tasks; one substrate defect — **idle treated as terminal** — explained all six, plus a
  wedged group, an archived-while-running session, and a 95-session launch loop. Producing well-formed
  tasks is not understanding the system, and it is the more comfortable of the two. Before filing the
  third, **state the common substrate explicitly** — including "checked; genuinely independent because
  <X>".
- **The same defect *class* in N different places is one upstream defect — fix the write path, not
  each reader.** The rule above works *within* one subsystem; this is the same instinct one level up,
  and it catches what that rule cannot: findings scattered across **unrelated** subsystems that are
  all the same *shape*. **Before filing the second instance of a defect class you have seen before,
  search for the rest of the class**, then ask where the invariant should have been enforced — at the
  **producer**, not at each consumer. Real run: **five** tasks filed against the same id-space defect
  (`notion:` prefix and/or hyphenation) in five different lookups — the `ops_journal` guard, the groom
  dep gate, and three earlier. Each per-instance fix was correct, and none of them was the fix:
  **normalize at the write path so a mixed-format id cannot be persisted.** When `context.md` already
  names something a recurring trap, **the recurrence count is itself the finding** — a documented
  "third-bite trap" reaching a fifth bite is evidence that per-instance hardening is the wrong lever.
  File the upstream task and **rank it above the per-instance ones**; N readers hardened against a
  producer that still emits both formats is N places to re-break.
- **Never smuggle.** A code fix an investigation surfaces is a *separate* `💻 Code` task — an
  investigation *produces* tasks, it does not *contain* "implement module X" as acceptance criteria. A
  prod/env change → `🔧 Operational`; a live-data decision needing the board's machinery → a `🔎
  Investigation` task for `/ops`.

### 5. Draft → present → file `🔲 Backlog`

- **Draft in conversation first** (`task-writing.md` is the authoring standard). The body is the spec:
  **Summary · Dependencies · Context (the proven mechanism, anchored to `file:line`) · Acceptance
  criteria (🤖 Automated + 👁️ Manual, 5–10 items) · Files/paths affected · Implementation notes
  (empty)**. Set Priority from the *verified* severity.
  - **"Re-open the standard at the moment you author" fails at scale — re-open it per *batch*, and
    carry the field constraints inline.** One run authored 30+ tasks off a single early read and
    violated a rule it had already read that session. The constraints that actually get dropped,
    restated here so they travel with the draft instead of depending on recall:
    - **Files/paths affected: every entry is a repository path.** Never prose. A real violation —
      *"backend and frontend tests for staging, envelope threading, and panel rendering"* — cost a
      groom session two blocked attempts and ~10 minutes of self-correction. **A second instance
      shipped undetected because the gate is bypassable**, so your own per-task check is the only real
      gate. Run it per task, not per session.
    - **Verify every path with `git ls-files`, not a filesystem existence check — mechanically, not
      attentively.** Run the entries through a loop and file only once it is clean. A later run
      produced three corrupted paths — `packagesting/`, `packagesges/`, `packagesist/` — *while
      knowing this rule and knowing the gate is bypassable*; the tasks in that same run where the loop
      was run first were clean. **Attentional care demonstrably does not work here**, and the
      corruption is string-mangling that reads as plausible at a glance.
      - **Use the promotion gate's own predicate — `[ -e "$checkout/$p" ]` is the wrong instrument
        and this skill previously mandated it.** The gate does not ask whether the path *exists*; it
        asks whether the entry resolves to a **tracked file** or carries an explicit `*(new)*` marker
        — `isFilesPathsResolved` (`packages/backend/src/groom/groomGate.ts`) blocks on
        `!isNew && !existsInRepo`, where `existsInRepo` is membership in the `git ls-files` set
        (`filesPathsEntryExistsInRepo`, `groom/groomLoad.ts`). **`-e` passes for a directory, and a
        directory entry blocks at grooming** — untracked-but-present files pass it too. Real run: the
        prescribed loop ran clean and **four** tasks were still blocked at grooming on their
        Files/paths entries. Per entry: `git -C <checkout> ls-files --error-unmatch <p>` — a non-zero
        exit is a task that will block.
      - **`*(new)*`-marked entries skip the tracked check entirely, so nothing downstream catches a
        bad one** — check by eye that each is a **full file path** (directory + filename +
        extension), never a bare directory.
      - **Strip hedge tokens** (`and/or`, …) — the same gate rejects a Files/paths entry containing
        one, separately from the path check, and it is not a prose section.
    - **Acceptance criteria split 🤖 Automated / 👁️ Manual**, 5–10 items, each independently checkable.
    - **Implementation notes stays empty** — it belongs to the implementing session.
- **"Mirror the existing X" is the highest-risk sentence in a task — say which semantics transfer and
  which do not.** A mirror instruction reads as safe and low-effort, which is exactly why it ships
  unexamined: it delegates a semantics question to an implementer who will resolve it by pattern-match.
  **Never write "mirror X" alone.** Name the exact helper, counter, or guard to use, state explicitly
  what carries across, and state what does *not*. **Both regressions introduced by one run came from
  this single sentence shape:**
  - *"`completeOpsTask` mirrors `completeDesignTask`'s guards"* — but a design session's terminal state
    **is** completion, while an ops session's completion is a **separate state machine**. Result: an
    investigation marked ✅ Done with `finding_or_proposal = NULL`.
  - *"the verify budget mirrors `computeAvailableCapacity`"* — but it never named **which** live-session
    counter, and the DB-backed one counts **104 archived idle corpses**. Result: dispatch budget pinned
    at 0.

  The test before you write it: *if the implementer resolves this mirror the most obvious way, and the
  obvious way is wrong, does anything catch it?* If not, the mirror needs its semantics spelled out —
  and a mirror across a **type boundary** (design→ops, PR→session, review→verify) almost never
  transfers whole.
- **Stamp the observation SHA on every evidence claim.** This repo merges fast — a Backlog task's
  premise can decay within the hour, and "is this still true?" is expensive without a baseline. Every
  evidence block and `file:line` anchor names the **SHA it was observed against**: the deployed SHA
  (`deployed.sha`) for live-behaviour claims, the exact commit for a code anchor (`git -C <checkout>
  rev-parse HEAD`, or the blame commit). A dated claim without a SHA is not re-verifiable.
- **`file:line` anchors make a finding refutable, not just actionable — so anchor precisely.** The
  payoff is that a groom/design session can read the cited lines and **refute** the task if it is
  wrong (a real groom refuted a task outright by reading `gateService.ts:219-225`). A refutable claim
  is safer than a plausible one. Cite the lines you verified, not an approximate region.
- **Present the draft before filing** — especially a prescriptive Code task that dictates a fix; the
  operator may reframe, defer, reject, or point out subsumption. Accurate-the-first-time beats
  file-then-correct: run the one-level-deeper check *before* presenting.
  - **Standing authorization is real — take it, and stop re-asking.** When the operator says "file
    it" / "just file them" as an **instruction rather than a response** — typically once the first
    task or two have established the shape — that is a **standing grant for the batch**. File without
    presenting each body. **Acknowledge it once** ("filing the rest without presenting"), then file.
    Re-presenting every body after a standing grant is the same failure as re-asking a settled
    question (§ Invariants — acknowledgement is not compliance), and it spends exactly the throughput
    the grant was given to buy. The grant **lapses on a material scope change** — a new defect class,
    a different milestone, or a task prescribing a fix in a region the operator has not seen — where
    you present again and say why.
- **For a design-adjacent finding, present the *lever* before drafting.** When the fix turns on a
  settled-or-open architectural decision (which knob to turn, wrong-fix-lever, Future-Scope-vs-task,
  settled-design-vs-new-design), present the **root cause + proposed lever** in a sentence or two and
  ask *"is this the right lever, or is it already-decided / Future Scope?"* Operators repeatedly
  reframe exactly these, and a full draft on the wrong lever is wasted. Draft the body once the lever
  is agreed. A cleanly root-caused bug goes straight to draft-then-present.
  - **When the diagnosis does not *force* the fix, present the solution *space* — two or three
    candidate levers with their trade-offs — not one recommendation.** "Present the lever" is written
    as a singular and reads as one; that is the defect. A clean root cause manufactures the feeling
    that the fix follows from it, and it usually doesn't: the same cause admits several levers on
    **different axes**, and a singular recommendation silently deletes the axes you never enumerated.
    The test before presenting: *does the evidence pick this lever, or did I pick it?* If you picked
    it, name the alternatives — and check they differ in **kind**, not in threshold; two settings of
    one knob is one lever, presented twice. Real run: 8/8 timeouts had a concurrent peer against solo
    runs of 96–301 s — the diagnosis was solid and the single lever offered was **bounding runs in
    flight**. The operator's fix was **fan-out per run**, an axis never surfaced. The *same run* later
    presented milestone-panel placement as a space, and that one went cleanly. A genuinely forced fix
    still goes straight to draft; everything else owes the space.
  - **Never offer a lever your own evidence has already shown to be insufficient.** A partial you have
    personally falsified is not a partial — it is a menu item you would argue against yourself, and it
    costs the operator a rejection to remove. If you found the counter-evidence, **drop the option and
    say you dropped it and why**; that is the useful output, not the option. Real run: a task-writing
    tweak was offered as a partial in a run that had *already noted* three sibling tasks with
    identical wording grooming fine.
- **File at `🔲 Backlog`, never `🗂️ Ready`.** Only a human review (a `/groom` pass) promotes to Ready.
  **Flipping a 💻 Code task to Ready auto-dispatches it** on this live board, so `/investigate` never
  flips Code→Ready (the `check-task-status.mjs` PreToolUse hook also enforces this). File via
  `notion-create-pages`; set `Depends On` (full pipe-delimited page ids) where a real hard-block
  exists. Resolve uncertainty toward hard-blocking — under-declaring races worktrees. **But register
  the consequence the inherited doctrine omits: a hard block gates the dependent's *grooming*, not
  only its dispatch.** A task whose `Depends On` names a not-yet-✅-Done task cannot be groomed to
  Ready at all. So "over-declaring just waits" understates it — it holds the blocked task out of
  grooming until the blocker is Done. Hard-block for a genuine conflict or prerequisite (same code,
  same migration number); don't hard-block for soft ordering, which now costs a grooming stall.
- **Milestone routing:** blocks the current milestone → current; a next-theme concern or one needing a
  migration → the next milestone.

### Filing at scale — a batch is a graph, not N independent tasks

The dependency doctrine above is written for **one** task in isolation. Filing thirty into one board
creates a **graph**, and there the per-task rule ("resolve uncertainty toward hard-blocking") runs
straight into its own counterweight ("a hard block gates the dependent's *grooming*, not only its
dispatch"). Reasoning case-by-case across a batch produces **inconsistent output** — a defect in the
deliverable, not merely in process. Real run: three tasks hard-blocked on same-file grounds while
three materially similar ones were deliberately left unblocked, with no stated reason for the
difference.

- **Write the dependency criterion down once, before filing the batch, then apply it mechanically.**
  Any member that deviates must **name why this case differs**, in the task. The defect above was not
  which choice was made — either was defensible — it was that comparable cases got different treatment
  from re-deciding each time.
- **Default criterion at scale: same *region*, not same file.** Hard-block when two tasks both mutate
  the same function / block / migration number / config key. Same-file co-location is too coarse a
  trigger once the batch is large — it manufactures chains that gate grooming where no conflict
  exists.
- **Render the graph before filing it.** List the chains root→leaf with their depth. **A chain deeper
  than ~3 is a grooming stall, not a safety measure** — every link must reach ✅ Done before the next
  can even be groomed. Prefer breadth: collapse a deep chain into one task (§ consolidate same-region
  findings), or re-check whether the middle links are real conflicts.
- **State the batch's shape to the operator** — count, chain depths, and the criterion you applied — so
  the graph is reviewable *as a graph*. Thirty task titles are not a reviewable artifact.

## Flow

1. **Invoke → restate the symptom + state the posture.** Echo back the symptom as you understand it,
   and state plainly: this is **read-only diagnosis** — you will file `🔲 Backlog` tasks; any
   in-session mutation follows the **§ mutation boundary** ladder (never a managed PR / session git; a
   DB write only on an explicit grant through the harness gate). **Pick the entry mode** (§ Two entry
   modes): a *specific* referent (PR#, session id, deploy run, task) → **targeted read** first (step
   3), loader only to re-ground; a *fuzzy* symptom → full loader first.
2. **Load the live-health snapshot — deterministically** (cold-start: up front; operator-pointed: to
   re-ground). Run the loader before any judgment step:
   ```bash
   node ~/.claude/scripts/investigate-load.mjs --project claude-dashboard
   ```
   It opens `dashboard.db` **read-only** and emits: the true `deployed` SHA + a `deployHint` (deployed
   ≠ HEAD ≠ attempted), the `activeMilestone` (+ board id), `erroredSessions` (each with its on-disk
   prompt-file path), **`recentPlanningSessions`** (recent non-Done groom/design/ops — the idle/killed
   "looks fine but bungled it" class, each with its prompt file), `recentDeploys` (failed attempts
   flagged), `needsAttentionPRs` (**each with its `repo` and a GitHub-verified `github`/`stale` flag —
   a `stale` PR is already merged/closed and is NOT a live symptom**), `recentAuditEvents`, and the
   authoritative non-Done `board` (via `notion-query.mjs`). Every task id is surfaced pre-normalized as
   `taskIdForms:{ bare, notion }`. Full field contract: `reference/snapshot.md`. **For cold-start this
   load is a precondition** — do not interpret any zero or anomaly before it exists. If the board half
   degrades (`source: 'unavailable'`), run the printed command by hand; if PR verification is
   unwanted, `--no-verify-prs` degrades each to `unverified` + its exact `gh -R <repo>` command; if the
   loader is unreachable, hand-load the same set read-only and say so. Then `Read` the project's
   `context.md` (§ Inspecting live state, § Deployment, the id-space section).
   **Before picking threads, set the cold-start scope floor** (§ Two entry modes): resolve the latest
   *successful* deploy's completion instant, drop pre-deploy entries from thread selection, and
   declare the floor with the count it excluded. Operator-pointed referents are exempt.
3. **Reconstruct → root-cause → falsify** (loop steps 1–2). Pull the specific rows by value — the
   session prompt file, the `session_events` transcript (the highest-yield surface), the full
   error/pause/deploy detail — and dig to the proven `file:line` mechanism. **Run every claim through
   § Evidence law**, including re-reading any status live (§ stale-belief trap). Never mutate to learn
   what you can read.
   > **Batched symptoms → parallel sub-agents, *where the Agent tool is available*.** Operators often
   > dump several *independent* symptoms at once. Where sub-agents are available, fan each independent
   > root-cause thread out to a parallel read-only `Explore` / `general-purpose` sub-agent (each does
   > reconstruct → root-cause on its own symptom), then synthesize and run frame → classify → draft →
   > file yourself. Keep threads sharing a suspected cause in **one** agent so they don't race to the
   > same conclusion; a single deep thread stays in the main line.
   >
   > **Check availability first — some sessions disable the Agent tool**, and this skill's advice then
   > contradicts the harness. When it is unavailable, **say so up front and state the serial plan**:
   > the thread order, and where you expect to be at each checkpoint. An 8-item batch that silently
   > runs serially reads as a stall; the same batch announced as serial, with an order, is a plan. The
   > fan-out is an optimization — its absence changes **pacing, not method**.
4. **Frame** (loop step 3) — caused-vs-exposed, transient-vs-systemic, **cascade/blast-radius ("what
   else assumes this?")**, re-verify deployed state, **solve the requirement not its symptoms**.
5. **Classify** (loop step 4) — Code-vs-Design, check ✅ Done designs, recognize subsumption /
   Future-Scope promotion, **consolidate same-region findings**, **stop at the third finding in one
   subsystem**, don't smuggle.
6. **Draft → present → file** (loop step 5) — draft per `task-writing.md` (evidence stamped with its
   **observation SHA**, `file:line` anchors precise enough to be refutable), present to the operator,
   file at `🔲 Backlog` on confirmation. Never flip Code→Ready.
7. **Capture-don't-drop** — before closing, fold any durable learning into `context.md` /
   `task-writing.md` / `procedures.md`, or surface the gap. Report what you filed and what you
   captured; stop. Don't propose wrapping (`procedures.md` § Don't propose wrapping).

## Toolkit it vendors

All read-only or draft-then-confirm; all sanctioned by `procedures.md` / `context.md`:

- **`investigate-load.mjs`** — the read-only live-health snapshot loader (see `reference/snapshot.md`).
- **The read-only `better-sqlite3` accessor** — for anything the loader doesn't surface: a query using
  the bundled driver, `{ readonly: true }`, against the orchestrator's SQLite DB. **The DB path and
  the runtime directory to run from are host facts — read them from the project's `context.md`**
  (§ Inspecting live state), or take `$ORCHESTRATOR_DB_PATH` where it is set; this skill deliberately
  does not hardcode either. Load-bearing tables: `sessions`, `session_events`, `audit_log`, `pull_requests`,
  `deploy_run` + `deploy_run_event`, `project_deployed_sha`, `milestones`, `task_cache`.
  - **Write a `.cjs` query file — don't use `node -e` for anything non-trivial.** In a `node -e`
    one-liner a **double-quoted** SQL string literal (`WHERE x = "foo"`) is parsed by SQLite as an
    *identifier*, so it silently becomes a column reference and throws `SqliteError: no such column:
    foo`, or matches nothing. Put the query in a `.cjs` file with **single-quoted** SQL literals and
    run it: the quoting is unambiguous and the file is re-runnable.
  - **Never write.**
- **The session-prompt-file reader** — `Read <checkout>/.claude/session-prompts/<session-id>.md` (the
  loader prints the path).
- **`notion-query.mjs`** — paginating board/DB enumerator (never the 25-capped MCP search);
  `--no-done --json --env <path>/packages/backend/.env`. Used for prior-board dedupe and Done-design
  search. **`notion-create-pages`** (MCP) — file the drafted Backlog task(s), on confirmation.
- **Scoped, read-only `journalctl` / `git -C` / `gh`** — `journalctl -u orchestrator.service` for the
  running service; `git -C <checkout> show/log/blame` to anchor a mechanism to a commit and check
  whether it is in the deployed SHA; `gh -R phahadek/claude-orchestrator …` for CI/PR state. All
  **read-only inspection**; `git -C`, never `cd && git` (§ hard-rules).
