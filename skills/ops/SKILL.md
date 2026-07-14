---
name: ops
description: >-
  Execute a milestone's interactive 🔧 Operational and 🔎 Investigation tasks — the
  judgment-bound work that is NOT auto-dispatched. Two modes in one pass: Operational
  changes production/environment state through a sanctioned surface (config/catalog/entity
  authoring, backfills, alarm config, dependency installs, session/machine setup);
  Investigation produces a defensible decision from live data (diagnoses, spikes, zero/anomaly
  triage) and files follow-on tasks. Enforces: autonomous runs STAGE (never verdicts, never
  ✅ Done), read-only diagnosis before any write, falsify every "it's fine", audited
  read-modify-write, reconcile+capture, "Done ≠ deployed ≠ seeded ≠ working". Records durable
  research to a staging journal. Use when the user says "work the ops tasks", "run ops/tooling
  for milestone X", "work the operational/investigation tasks", or starts an overnight or
  interactive ops run on a project's task board.
---

# ops — execute a milestone's Operational & Investigation tasks

Companion to `groom` (backlog→Ready) and `design` (design tasks): this skill *works* the
🔧 **Operational** and 🔎 **Investigation** tasks — the interactive, judgment-bound ones that
are **not** auto-dispatched. Its whole value is a verification discipline that refuses to
trust premises, statuses, or convenient shortcuts, and that **treats an unattended pass as
staging, never as conclusions.** Follow it even when a task "looks like a one-liner."

> Scope: this skill runs 🔧 Operational + 🔎 Investigation, **plus observational / E2E 🧪 Testing
> folded in as an Investigation variant** (run the system live → a **disposition**: `pass` /
> `blocked-pending-fix` / `pass-with-caveat` — there is no "fail").
> **Test-authoring 🧪 Testing** (writing test code, no live-data dependency) and 📝 Docs stay out —
> the former is really 💻 Code, so reclassify it (the loader lists any it caught in `test_authoring`;
> flag the rest at triage). (Legacy 🛠️ Tooling tasks that predate the split are grandfathered; treat
> a live one as whichever mode it actually is.)

## The two modes

**🔧 Operational — change prod/environment state through a sanctioned surface, and verify it
landed.** The decision is already made; the work is the doing + verification. Uncertainty is in
**breadth / source / mechanics**, never in *whether* or *what*. Failure mode = **a bad write**
(wiped siblings, wrong source, a re-derive never run). Two flavors:
- **Directed** — fully-specified change: a backfill/re-derive from a known-good state, a
  dependency install, wiring a tool/MCP into sessions, a machine migration. Little/no research.
- **Research-first** — the *what to author* needs research (which teams/tournaments/streams/
  aliases): governed by **"research → present → author on confirmation; never apply before
  presenting."**

**🔎 Investigation — produce a defensible decision about a live issue from production data.**
The decision **is** the deliverable. Output = **filed follow-on tasks** (Code / Operational /
more Investigation) + an occasional inline change. Uncertainty is in **the conclusion itself**.
Failure mode = **a wrong conclusion**. Includes **spikes** (verify an external surface before
code depends on it). An Investigation may *produce* a Code task — that is a legitimate output,
never a reason it should have been Code. It must never *contain* "implement module X" as its own
acceptance criterion; that gets filed as a separate Code task.

> **Variant — observational / E2E 🧪 Testing.** A Testing task that *runs the system live and
> observes* is an Investigation whose deliverable is a **`disposition`** (journal field). **There is
> no "fail" state** — the outcome is one of:
> - **`pass`** — completed: demonstrated **by value** (verified working, not a green-looking
>   degenerate/zero result);
> - **`blocked-pending-fix`** — it surfaced an issue: **file the fix task and set *this* task to
>   🗂️ Ready + `Depends On` the fix** (it re-runs after the fix lands). Carries the observed evidence
>   + the filed fix — same root-cause bar as any Investigation (name the mechanism, never "it broke").
>   *This is not a dead end and not "Done" — it's a dependency.*
> - **`pass-with-caveat`** — done, with one aspect superseded/deferred and noted.
>
> *Test-authoring* (writing test code) is **not** this — it's 💻 Code.

## Execution context — autonomous vs interactive (this replaces "Phase 1 / Phase 2")

The old two-phase framing conflated two orthogonal things. Keep them separate:

- **Read-only diagnosis before any write** is a *safety ordering* — it holds inside **every**
  run, every mode. Never mutate to learn something you can read.
- **Who may commit a verdict or a write** is the *execution context* — **autonomous** (overnight,
  no operator: `--print` / no TTY) vs **interactive** (an operator is present). Context is
  auto-detected from the invocation; an operator may override it explicitly.

An autonomous run **stages**; it emits a staging report; a later **interactive** run **resolves**
it. **But the split governs *what you may commit*, not *whether to do the first-pass.*** Every run —
autonomous **and** interactive — does the full read-only first-pass over **every** task first (Flow
step 3). An interactive run does **not** get to skip staging and jump straight to resolving: unless
it is consuming a prior autonomous run's journal, it must run that first-pass itself before it walks
any task. **Skipping the first-pass is the single most common way this skill is mishandled** —
treat step 3 as a gate, not a suggestion.

### Commit-authority matrix

|  | **Autonomous (no operator)** | **Interactive (operator present)** |
| --- | --- | --- |
| **🔎 Investigation** | Read-only diagnose; record findings as **provisional candidates**; file follow-on tasks; freeze+capture incidents. **No verdicts** (no "VERIFIED", "not a bug", "root cause confirmed"); **no status flip.** | Earn the verdict *with* the operator (falsify it); make the call; occasional inline change; propose the status flip (operator confirms). |
| **🔧 Operational — research-first** | Research + verify sources the project's way; **stage a proposal** (what to author, breadth, source). **No write; no status flip.** | Present-before-apply; operator picks source/breadth; author via the audited path; reconcile+capture; propose the flip. |
| **🔧 Operational — directed** | May **execute** the well-defined change via the audited path **iff** low-risk + mechanically verifiable (read-modify-write; reconcile+capture); record "applied + verified". Not cleanly verifiable → **stage**. | Execute + verify + propose the flip. |

**The load-bearing rule:** in the autonomous column, **nothing ever flips to ✅ Done and nothing
records a definitive verdict** — not even a directed Operational change it successfully applied
(that records *"applied + verified, pending operator confirmation"*). Status-flips and verdicts
are **always** interactive. This lets a "run-only-from-known-good-state" backfill actually run
unattended while still keeping a human on every close.

## Disciplines

### Universal — every run, every mode

- **Read-only diagnosis before any write.** Never mutate to learn what you can read.
- **The sanctioned read surface is the default — use it freely, no permission needed.** The
  analyst MCP + the `/ops` HTTP read endpoints are the normal read path; reach for them without
  asking the operator. **"Read by value" almost always means these**, not raw SQL. Ad-hoc
  read-only SQL through the project's read-only role (direct PG) is a lighter, still-sanctioned
  fallback for what the endpoints don't cover; only a **write** (or the write DSN) is break-glass.
- **Never force blocked or prod-risky actions** (deploys, fleet/DB restarts, dumping live
  credentials, instrumented prod deploys). Document, hand to the operator, move on. One blocker
  never stalls the run.
- **Incidents: freeze → capture → classify → file → don't loop.** A live prod incident gets the
  **incident sub-protocol** — see `reference/incident.md`. The one rule to remember without
  opening it: **capture volatile evidence (a stack dump, `pg_stat_activity`, thread states)
  BEFORE any restart — a restart destroys it.** Risky recovery (a fleet/daemon restart, a
  pgbouncer bounce) is the **operator's call** — but **"operator's call" = their *decision*, your
  *execution* under phase auth.** In a co-hosted interactive session the operator often has **no
  server access**; **never hand a command back to an operator who can't run it** — get the decision,
  then you run it. And **don't recover-in-circles:** killing a stuck session/backend to clear a lock
  is pointless while the **root code bug is still live** — it recurs and leaves the fleet in an
  unknown state. Capture + **file the fix**; don't loop on restarts.
- **Drill-budget / conversion tripwire — it caps *fixing*, never *understanding*.** Diagnostic
  depth has **no budget**: an Investigation digs until the root cause is *proven* (see § 🔎
  Investigation). What the budget stops is **open-ended *doing* solo** — implementing a fix, building
  a module, excavating a large change. The moment the work turns from *diagnosing* to *implementing*,
  **stop — file a Code task carrying the proven root cause, capture the state, and surface it.**
  Don't build solo. Concretely:
  - An **Operational** task that can't be completed via a sanctioned surface without new code is
    **blocked-pending-Code** (or was mis-declared Investigation). Stop, file, surface — don't
    excavate a code change solo.
  - An **Investigation** keeps *diagnosing* to root cause; it stops only to file (a Code / Operational
    task carrying the proven cause) when the remaining work is *doing*, not *understanding*. One that
    turns out to be a well-defined change dressed as a question → downgrade to **Operational** and do
    it (within the autonomous ceiling).

### 🔧 Operational

- **Writes only through the project's audited path** (its config-CRUD / ops affordance), **never
  raw SQL / hand-edits.** Verify each write; prefer reversible, greppable-for-rollback changes.
- **Read-modify-write any replace-semantics shared state** (a binding/linkage/config row the CRUD
  *replaces wholesale*) — read current, merge, write the full set. Blindly creating wipes siblings.
- **Verify the daemon reconciled AND actually captured** — it heard the config change, built the
  actor, and a post/signal/record landed. Authoring a row is not ingesting.
- **"Done ≠ deployed ≠ seeded ≠ working."** A merged task may be un-deployed; a deployed code path
  may have **no operational seed applied** (a recurring silent-degradation trap). Confirm the seed
  is present on prod, then that the behavior actually runs. When the task at hand *is* the
  milestone's config-seed task, work it via **§ Milestone config-seed** below, not by reading its
  task body as the worklist.
- **No accepted gaps — every step closes or is filed.** A multi-step Operational task is Done only
  when **every** step is completed or filed as a follow-on that closes the gap. **"Accept the gap"
  is never an option to present** — silently dropping the price side of a backfill and shipping
  trades-only is the exact failure this prevents. If a step can't be done now, file the follow-on
  that will and say so; never narrow the deliverable to what happened to work.
- **Research-first: present before applying.** Pull authoritative per-entity data (the source's
  own page), verify each item exists the project's way, lay out **what the task assumed vs. what
  you found**, recommend, and get the operator's call on source/scope/breadth *before* the write.
- **Writes and the write-DSN are break-glass** — deliberate, logged, not the default. (Reads are
  *not* — see the sanctioned-read-surface rule under Universal.) Never run session-level read-only
  GUCs over a pooled connection (they leak to other clients); for ad-hoc read SQL use the project's
  read-only role over the direct/unpooled path, and route every *write* through the audited CRUD.
- **Operational execution is a *phase*, not per-action break-glass.** The break-glass framing above
  is for *one-off* actions; a task's *execution* is a sustained burst of them (one run: a price
  backfill + 8 per-market trade backfills + a re-match ≈ 10 prod actions). Metered one
  approval-prompt at a time, that's death-by-a-thousand-prompts — an operator had to abandon a run,
  flip to auto mode, and resume. So at the **phase boundary**, state the shape and request
  **phase-level authorization once**: *"this phase is ~N prod actions via the audited path (writes /
  daemon restarts / secret-DSN reads); recommend auto/accept for the duration — I'll narrate each
  and stop at any real decision point."* That converts N prompts into one decision + running
  narration. It's safe **because** Operational writes are already required to be **reversible +
  greppable-for-rollback** (above) — and you still **stop at any genuine decision point** (a
  present-before-apply choice, an unexpected result, anything irreversible).

### 🔎 Investigation

- **The buck stops here — dig to the *proven* root cause.** An Investigation's job is to *find the
  mechanism* — demonstrated **by value + the exact code path/line** (or config row / state), not
  hypothesized. Keep asking "why, really?" until the cause is proven, not plausible. **Stopping short
  is legitimate only at a genuine external/access blocker** (no read access to the evidence). Never
  discharge the undug question into a "next fix" — a `lead_lag` family got "fixed" while the real
  `align()` root cause sat unfound for a whole milestone precisely because the investigation stopped
  at "a fix was filed."
- **A filed follow-on carries a *proven* root cause — never another investigation of the same
  question.** *If your follow-on title starts with "Investigate…", you haven't finished
  investigating* — you punted. File a **Code / Operational** task that names the proven cause and the
  fix, not a re-run of the diagnosis.
- **Falsify every "it's fine / no bug / will self-heal / the numbers say X".** For any such
  conclusion, run an explicit falsification: **"what would I observe if this were false, and did I
  look?"** Ask "why, really?" and "would that actually fix it?" one level deeper than feels
  necessary — in practice this flips the answer more often than not.
- **Treat a registered number as a claim to re-derive, never a fact.** A prior task's stated
  figures, a "known" count — re-derive it from live data before you build on it.
- **Read outputs by *value*, not by row-count/existence, and check provenance.** N rows of
  zero/degenerate output looks identical to real work; a row's presence never proves it's current
  or correct (version + timestamp vs the relevant deploy). **Before concluding 0 / dark / broken,
  run the false-negative checklist:** (a) does your **filter value equal what the *producer* actually
  writes** — the exact `source` string, enum member, id-space? (two premise-inversions this way this
  run: a `livestats` filter vs the actual `source='lol'`; an esports `tournament_id` false-negative);
  (b) is the **scoping key a known false-negative** (documented in `context.md` / the retrospective)?;
  (c) is **provenance/version** current? A "0" that's really a filter mismatch is the single most
  common wrong conclusion.
- **Verify a source the *project's own way.*** A browser/WebFetch success ≠ the daemon's success —
  fetch with the project's actual client/UA/auth; confirm a walled surface clears via the client
  the daemon uses.
- **Consult the authoritative source-of-truth doc first — not optional.** Before interpreting any
  zero, anomaly, or "this looks broken," read the relevant findings / retrospective / architecture
  page (surfaced by the loader / Flow step 2). It very often documents the exact case and the
  interpretation trap — **skipping it flips real findings** (it inverted a seed-verification finding
  this session). Do this *at the moment of interpretation*, before you record even a candidate.
- **Output is filed tasks, not code.** File 🔲 Backlog tasks (Code / Operational / Investigation)
  for what you find. **Accurate-the-first-time beats file-then-correct** — run the one-level-deeper
  check *before* filing, and set priority from the verified severity, not the first impression.
  **Interactive: present a prescriptive follow-on *before* filing it** — especially a Code task that
  dictates a fix; the operator may reframe, defer, or reject it (a wrong `8148` framing had to be
  retracted this run). Present-before-apply covers *filing*, not just writes.
- **Milestone routing for filed follow-ons:** critical / **blocks the current milestone** → the
  **current** milestone; non-critical / needs-a-migration / a next-theme concern → the **next**
  milestone. (This run: the lock fix + windowing → M12; index-sargability + catchup-daemon → M13.)

## The staging journal

Long ops runs must not discard expensive research, but must not persist unverified decisions
either. Those reconcile only if research and verdicts live in **different places with different
durability rules**.

The **staging journal** lives in the backend's `ops_journal` DB table — one row per
**eligible** task, **pre-seeded and reconciled server-side by `GET /api/ops-context`**
(Flow step 2; same reconcile job `loadOpsContext` always did, now the only path to it).
Read it with `node ~/.claude/scripts/ops-client.mjs journal --milestone <M>` (wraps
`GET /api/ops-journal?milestone=<M>`). Documented shape (one entry per task id):

- `mode` (`operational`|`investigation`), `flavor` (`directed`|`research-first`|`null`),
  `worked_in` (`autonomous`|`interactive`)
- **`evidence[]`** — the durable, expensive part: probes/queries run, **values observed with
  provenance** (version + timestamp vs deploy). This is what survives context exhaustion.
- `finding_or_proposal` — the candidate finding (Investigation) or staged authoring proposal
  (Operational)
- `falsification` — Investigation: *"what I'd observe if false, and did I look."*
- `state` — the provisional marker: **`pending`** (loader-seeded, not yet worked — the first-pass
  must advance every entry off this) | `candidate` | `staged-proposal` | `applied-pending-confirm`
  | `blocked` | `incident-frozen` | `resolved`
- `filed_followons[]`, `needs_from_operator`
- `resolution` — **null until interactive**; on operator confirmation, `{ decision, by, at,
  persisted_to }` (task page / follow-on / arch page)
- `disposition` — **🧪 Testing variant only:** `pass` | `blocked-pending-fix` | `pass-with-caveat`
  | `null` (loader-seeded null; **no "fail"** — a surfaced issue → `blocked-pending-fix` + a filed
  fix + a `Depends On`). Set with `ops-client.mjs set-state … --disposition <value>`.

Rules that make it safe:
- **Research persists** in `evidence[]`, always tagged provisional by `state`. A fresh interactive
  session (new process) reloads the journal and resumes without re-excavating.
- **Verdicts don't leak.** The autonomous pass writes **only** to the journal — **never** to the
  Notion task page. A decision reaches the task page only at `state: resolved` (after interactive
  operator confirmation).
- **Multi-session durability.** If even the interactive review runs long, unreached tasks stay
  staged for the next session. A task becomes `resolved` only when the operator confirms and its
  residue is persisted to its proper home.
- **Trimming — the journal holds *open* work, not history.** Once an entry reaches `resolved` and
  its residue is persisted to its proper home, that home (the task page / follow-on / arch page) is
  the audit trail — so **drop the entry**. Trimming happens **server-side**, on every
  `GET /api/ops-context` call: any `ops_journal` row whose task is now ✅ Done or no longer on the
  open board is deleted as part of that request's reconcile (the DB-backed twin of the old loader's
  job 3 — see `reconcileJournal` in `packages/backend/src/ops/opsJournal.ts`). **Never hand-edit the
  DB.** On resolve, set `state: resolved` + `resolution` with **`ops-client.mjs set-state --task <id>
  --state resolved [--resolution '<json>']`** (wraps `POST /api/ops-journal/:taskId/state` —
  deterministic field write, validated against the allowed state-transition graph server-side); the
  next `ops-context` call trims it: **deletion is the fragile part, not the write, and it's no longer
  yours to get wrong.**
- **Interactive-throughout is a lighter path.** The full `pending` → `candidate` /
  `staged-proposal` / `applied-pending-confirm` → `resolved` vocabulary exists to protect the
  **autonomous→interactive handoff**. When a run is interactive from minute one (no autonomous pass
  to hand off), the journal is a live scratchpad, not a handoff artifact — you may collapse the
  provisional states to just `pending` → `resolved`, still recording `resolution` per task. Here
  **`evidence[]` can stay in-conversation and land on the task page** (that's what worked) — by
  design `ops-client.mjs set-state` writes only `state` / `resolution` / `disposition`, **not**
  evidence: a fragile evidence append isn't worth it when the operator is present and the task page
  is the durable home. Don't carry the full staging ceremony when there's no handoff to protect.
- This is ops-native and **distinct from `/wrap`** (which sweeps broad session residue).

## Milestone config-seed — driven by the seed-state API

The milestone's one accreted **config-seed** task (`config-template/task-writing.md` §
Milestone config-seed) is orchestrator-tracked state, not a task-body checklist to read
top to bottom. Every seed a Code task contributed at grooming time lives as a `seed_item`
row — applyable once its `min_deployed_commit` is an ancestor of the target project's
current deploy SHA. Every apply attempt is a `seed_item_event` — that log **is** the
durable record, the operational twin of the gate's `gate_item_event`. **Do not read the
config-seed task's body as the seed worklist** — the live worklist is `seed_item` rows,
never a bulk load of the whole applyable set.

This is a thin human-driven loop over the seed-state API
(`packages/backend/src/routes/seedState.ts`, business logic in
`packages/backend/src/seed/seedService.ts`), called through the sanctioned node client:

```bash
node ~/.claude/scripts/seed-state-client.mjs <command> ...
```

`seed-state-client.mjs` is the vendored sanctioned node client (see
`packages/backend/scripts/seed-state-client.mjs` and
`scripts/deploy-grooming.mjs`), using `$ORCHESTRATOR_DEVICE_TOKEN` (host/port
default to `127.0.0.1:3000`, overridable via `$ORCHESTRATOR_BACKEND_HOST` /
`$ORCHESTRATOR_BACKEND_PORT`) the same way the other sanctioned session
clients (`ops-client.mjs`, `gate-state-client.mjs`) do.

1. **Readiness** — `node ~/.claude/scripts/seed-state-client.mjs readiness --milestone <M>` →
   `{status: 'green'|'blocked', blocking}`. `green` — nothing left to apply this
   milestone; report and stop. `blocked` — every unconfirmed seed with its
   project/state, as a worklist **map only** — pull the actual batch via `next`, never
   disposition straight off this summary.
2. **Pull one applyable batch at a time** —
   `node ~/.claude/scripts/seed-state-client.mjs next --milestone <M> --deploySha <sha> [--limit <N>]`
   (default limit 1). `deploySha` is the **target project's** currently-deployed commit —
   resolve it the project's own way (its `context.md` documents the deploy-tracking
   surface); never guess it. Applyability = deploy-included (the seed's
   `min_deployed_commit` is an ancestor of `deploySha`) AND not yet `confirmed`. Never
   bulk-load the milestone's full seed set.
3. **Apply through the target project's own audited config-CRUD, then record the
   outcome.** For each pulled item: read `item.spec` (`node
   ~/.claude/scripts/seed-state-client.mjs detail <id>` for sources + prior events
   before re-attempting one). **The operator
   applies the seed via the target project's audited config-CRUD / ops affordance —
   never raw SQL, and the orchestrator never applies another project's config on its
   behalf** (that's why `next` requires a `deploySha` the caller supplies rather than
   applying anything itself). Batch consent is fine here — one up-front "these N seeds,
   go" per pulled batch, the same phase-level authorization an Operational execution
   phase gets, not a prompt per seed. Then verify reconcile + capture the ops-native way
   ("Done ≠ deployed ≠ seeded ≠ working" — confirm the row landed AND the consuming
   worker picked it up AND the mechanism actually emits) and record every attempt, not
   just resolving ones:

   ```bash
   node ~/.claude/scripts/seed-state-client.mjs event <seedItemId> \
     '{"outcome":"applied","evidence":"<what was authored + how verified>"}'
   ```

   `outcome` is `applied` (authored, reconcile/capture not yet fully confirmed),
   `confirmed` (reconcile + capture verified — resolves the item), or `blocked` (could
   not apply — **must** carry `filedFollowon`, the id of the follow-on filed for the
   blocker; the server rejects a `blocked` event without one). Include `evidence`
   (freeform) and `operator` when known.
4. **Loop** — repeat 2–3 until `readiness` reports `green`, or the operator stops for the
   session; remaining seeds stay `pending`/`applied` and nothing is lost, state persists
   server-side.

**What this replaces:** it does not fetch or parse the config-seed task's body as the seed
worklist, and it does not bulk-load a milestone's full seed set.

**Built, not activated.** This ships in the skill now, and `seed-state-client.mjs` is
vendored to `~/.claude/scripts` (via `deploy-grooming.mjs`), but the seed-activation
task still owns confirming it runs live end-to-end for a real milestone — do not fold
that actuation here.

## Flow

1. **Invoke → detect context** (autonomous vs interactive) and state which you're in. **If
   interactive and the run will enter an *operational execution phase*** — a sustained burst of
   audited-path prod actions — get **phase-level authorization up front, not per-action** (see § 🔧
   Operational → *operational execution phase*). **It isn't only writes that trip the auto-mode
   classifier — break-glass reads (fetching a DSN from `/etc/…` secrets) and daemon restarts do
   too**; scope the up-front authorization to all three.
2. **Load context deterministically — call the ops-context backend route.** It is the sanctioned
   Flow-2 load, now served in-process by the backend instead of a vendored shell-out:
   `node ~/.claude/scripts/ops-client.mjs context --milestone <M> --project <dir>` (wraps
   `GET /api/ops-context?milestone=<M>&project=<dir>`; loopback + device-authed — set
   `ORCHESTRATOR_DEVICE_TOKEN` in the session env first). It deterministically (a) loads the fixed
   context pages — the **master Project Context page + the source-of-truth docs** (findings /
   retrospective / architecture / guidelines), returned in the response's `contextPages`; (b)
   enumerates the 🔧 Operational / 🔎 Investigation tasks — **plus observational / E2E 🧪 Testing
   folded in as an Investigation variant** (mode `investigation`, flavor `testing`), while
   **excluding test-authoring** Testing to the `worklist.test_authoring` triage list (reclassify →
   💻 Code) — into `worklist.executable` / `dep_blocked` / `needs_grooming` / `closed_not_done`; and
   (c) pre-seeds + reconciles the `ops_journal` DB table server-side — one row per **eligible**
   (Ready / In-Progress) task at `state:"pending"`, preserving prior worked fields and **trimming**
   rows whose task is now Done / off-board (same job the old loader did to its on-disk journal, now
   done to the DB on every call — see `reconcileJournal` in
   `packages/backend/src/ops/opsLoad.ts` / `opsJournal.ts`). Then also `Read` the project's
   `context.md` (write paths, prod/deploy, operator read-surface & break-glass). **Do not hand-load a
   partial subset** — skipping the master page / source-of-truth docs is the #1 load failure this
   route exists to prevent. (If the route is truly unreachable, load all of the above by hand — and
   record what you loaded as a `context_loaded: [...]` note for the run.) **This load is a
   precondition: a successful `ops-context` response — or a hand-load with `context_loaded` recorded
   — MUST exist before you interpret any zero/anomaly.** A failed call must never silently become a
   skipped load; that is exactly how the master Project Context + source-of-truth docs get skipped.
3. **First-pass — work every eligible task. Mandatory in every context, before resolving any one.**
   Order doesn't matter *here*. Respect `Depends On` (only ✅ Done
   satisfies a dep; where it gates *deployed* behavior, confirm it's actually deployed). For each:
   **re-derive the task's premise and blocker before working *or* blocking it** — (a) is the
   deliverable already settled elsewhere (a sibling task / prior resolution)? (b) is the stated
   blocker actually the only path? The loader's Ready/blocked and a task's stated dependency are
   *claims to check, not facts* (`81f3` was already settled by `81c7`; `81e4`'s Liquipedia wasn't
   the only source — Twitch was). Then read-only diagnose the premise **the project's way, by
   value, checking provenance** — and
   **consult the source-of-truth doc before interpreting any zero/anomaly** (Investigation
   discipline); then work it to its **mode's autonomous ceiling** (matrix above); journal the
   evidence + `state`. File Backlog tasks for gaps; freeze+capture incidents. Never let one blocker
   stall the run.

   > **GATE — do not start step 5 (resolving) until step 3 has advanced _every_ journal entry off
   > `pending`.** The ops-context load seeds one `ops_journal` row per eligible task at `pending`;
   > the first-pass must move each to a worked state (`candidate` / `staged-proposal` /
   > `applied-pending-confirm` / `blocked` / `incident-frozen`) via `ops-client.mjs set-state`. The
   > dominant failure is grabbing the first interesting task and resolving it before the rest are
   > diagnosed — resist it; the cost is an uninformed order and missed cross-task context. **Any
   > `pending` entry means the first-pass isn't done.**
4. **Present the overview + a suggested review order.** Open with the **coverage line — "N eligible ·
   N advanced off `pending`"** (they must match; any entry still `pending` in
   `ops-client.mjs journal --milestone <M>`'s output means step 3 isn't finished — go back). Summarize: what's staged, what's blocked
   and on what, what was filed, incidents frozen. Then propose a review order (like `design`),
   favoring in this priority:
   1. **Incidents / blockers** — safety, first eyes.
   2. **High-confidence items** — cheap, mechanically-verified directed-Operational completions
      and clear-cut resolutions; bank the certain value before a long session risks not finishing.
   3. **Thematic clusters** — grouped by theme; **within a cluster, Investigation before
      Operational** (a diagnosis often gates whether the authoring change is even right).
   Get the operator's sign-off on the order.
5. **Walk each task in order for in-depth operator review.** Don't accept the staged premise —
   verify it authoritatively with the operator (falsify Investigation findings; present-before-
   apply for Operational). On confirmation: author via the audited path / lock the decision; verify
   reconcile + capture; persist the resolved outcome to its proper home; mark `resolved` in the
   journal; propose the status flip (**the operator confirms Done**). File follow-ons for anything
   surfaced. **Don't assume status changes** — run step 5 per the **Interactive walk protocol** below.

## Interactive walk protocol

Step 5 is where this skill is most often mishandled. Codified:

- **The walk starts only after the first-pass (step 3) and the order sign-off (step 4).** Never
  walk from a cold board. **For 🔎 Investigation, step 5 *verifies with the operator, it does not
  discover*** — the diagnosis must be complete up front; a fresh query / DB read to answer a walk
  question means step 3 was incomplete. **For 🔧 Operational this is different — execution-time
  discovery is normal and expected:** *applying* the change is exactly what surfaces the real bugs
  (a precision bug, a `/trades` truncation, a `config.entities` vs `config.entity` hot-reload
  mismatch all appear *during execution*, not in the first-pass). That's a legitimate **output** of
  Operational work, not a first-pass failure — capture it, file follow-ons, keep going.
- **Never walk a dep-blocked task.** The loader excludes any task whose hard dep isn't ✅ Done from
  the walkable set (it lands in `dep_blocked`, surfaced for **re-groom** — fix the `Depends On` or
  wait for the dep, only ✅ Done satisfies). Do **not** resurrect one into the walk because it "looks
  ready"; a 🗂️ Ready **or** ⏭️ Deferred dep still blocks.
- **One task, fully closed, before the next.** Advance only after the current task's status is
  resolved by the operator, and introduce the next task in its **own message**. Never tack
  "and also X" or "next up is Y" onto the turn that closes the current one. This is the review
  unit: **one task per closing message** — sub-decisions inside a research-first Operational task
  happen *within* that task's close, not as separate advancing steps.
- **Open each task with context — never cold.** Lead with (a) what the task is *for* and (b) what
  the read-only diagnosis *found*; then the decision / recommendation. The operator should be able
  to engage from your message alone, without re-reading the task body.
- **One handle per task.** Name a task by its short name + Notion ID once, then use that handle
  consistently. Don't interchange IDs, ordering numbers, and paraphrased names across turns. An
  ad-hoc grouping label ("cluster", "the sidecar batch") is a device for the review-order overview
  **only** — never refer to it as if it were a task or a unit of work.

## Status handling

**The operator owns every status transition — including reopening or reverting.** You *propose*;
the operator *disposes*. Never change a task's status on your own reasoning — not to ✅ Done, and
just as importantly **never reopen or revert a status either** (reverting a task unprompted on a
re-reading is the same violation as self-closing one).

- **Autonomous: change no task's status.** Staging is neither "in progress" (it awaits review) nor
  "in review" in the vocab's sense. The journal is the record; the board stays truthful.
- **Interactive: set 🔄 In Progress when you actively open a task to resolve it**, cleared on
  resolution. On operator confirmation, propose the terminal move — **never self-mark ✅ Done**.
- **Skip 👀 In Review for these Types.** Its meaning ("PR open / Notion changes formally proposed,
  awaiting merge-or-lock") doesn't fit an ops task whose resolution is usually filed follow-ons +
  a task-page note. Keep staged-ness in the journal.

**Keep the explicit close turn — do not collapse it.** The final *"here's the outcome + filed
follow-ups; propose Done"* turn, **and the operator's confirmation of it**, is a deliberate **review
checkpoint** — the last place the result and the follow-ons surface before the task is buried. Even
when the operator's prior reply was a terse "LGTM" / "good," do **not** fast-forward it into "task
done, on to the next": present the close, let them confirm. The operator wants that turn.
**The close turn contains ONLY the current task's outcome + its filed follow-ons — never the next
task, never a run-level summary.** Bundling the next task or a summary onto the close buries the
review; the next task opens in its own message *after* this one is confirmed.

**When is a task Done? (propose it — the operator confirms.)**
- **🔎 Investigation** is Done only when the **root cause is proven** — the mechanism demonstrated
  **by value + the exact code path/line** (or config row / state), not merely hypothesized — with
  any inline fixes made and follow-on tasks **filed** (each carrying that proven cause, never another
  "investigate…" task). It does **not** wait on those follow-ons landing; filing them *is* the
  deliverable. The **only** excuse to stop short of a proven root cause is a **genuine
  external/access blocker** (e.g. no read access to the evidence) — recorded as such, not as Done.
- **🔧 Operational** is Done when the change is applied and **reconcile + capture** is verified on
  prod — not gated on anything downstream — **and no step was silently dropped** (every part of a
  multi-step task is closed or filed as a gap-closing follow-on; "accept the gap" is never offered).
- **🧪 Testing (observational/E2E variant)** reaches a **`disposition`, not a Done/fail verdict.**
  `pass` (verified *by value*, not a degenerate/zero that looks green) or `pass-with-caveat` → the
  task is Done. **`blocked-pending-fix` is NOT Done** — file the fix task and set this task to
  🗂️ Ready + `Depends On` the fix (it re-runs after). There is no "fail": a surfaced issue becomes a
  filed fix + a dependency, never a dead end.

**Dispositions land on the board, not only the journal.** The journal is **evidence**; the board is
**truth**. Any disposition that changes how a task should be groomed, worked, or run — *supersede,
re-scope, defer, "don't run as-is"* — must be written to the **task page** (body / Notes + the
proposed status) once confirmed. Recording it only in `ops_journal` is a **silent loss**: /groom
and future workers never read the journal. *(Autonomous stages the disposition as a candidate in the
journal; the interactive pass lands it on the board.)*
