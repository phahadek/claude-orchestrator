# Task Writing — Universal Authoring Standard

> **What this file is.** The single, project-agnostic standard for the **shape of a
> task page body**: what sections a task carries, how to write them, and the bar a
> task must clear before it is marked 🗂️ Ready. It is read by the `/groom` and
> `/design` skills, and by any **remote-control / planning / debug session** that ends
> up authoring a task. Re-open it at the moment you author or update a task — the
> Type, acceptance-criteria split, and Properties rules are reference content, not a
> skim-once summary.
>
> **What it is *not*.** It does not restate the rules that live elsewhere — consult
> those at their source:
> - **`config/procedures.md`** owns the task **lifecycle** (Backlog → Ready → In
>   Progress → In Review → Done), the **Type → who-executes-it** table, the **PR body
>   template + format**, and the **`Depends On` pipe-delimited convention**.
> - **`config/projects/<dir>/context.md`** (and the project's Coding Guidelines /
>   Technical Architecture pages) own the **project-specific slivers**: the verify
>   commands that acceptance criteria invoke, the load-bearing architectural
>   constraints to surface in Context, migration-ID rules, etc.
>
> When this file and a project's `context.md` disagree on a project specific, the
> project wins. When this file and `procedures.md` disagree on a universal rule,
> `procedures.md` wins and this file gets fixed.

---

## Core principles

1. **A task should be completable in one session.** Code tasks: ~2 hours of
   focused implementation. The **500-LoC default is a split *threshold* — a floor
   that trips a split nomination, not a hard ceiling**: a task estimated over it is
   nominated for splitting, but a **sub-500-LoC task may legitimately split too** (a
   natural seam is reason enough), and there is **no hard file-count ceiling**.
   Design/Planning tasks: a single discussion-and-document session that locks the decision.
   🔧 Operational / 🔎 Investigation tasks: one coherent change set (Operational) or one
   question/anomaly (Investigation) — if it balloons past a handful of investigation steps
   or uncovers a code gap that blocks its own completion, it stops and files follow-ons
   (the `ops` skill's drill-budget). If it doesn't fit, split it.
2. **The implementing session should not need to make any design decisions.** Every
   decision belongs in the task body or in an upstream design page it links to.
   Ambiguity causes scope creep.
3. **The page body is the spec.** Properties (Status, Priority, …) are metadata.
   Everything a session needs to do the work lives in the page body.
4. **Notion is the source of truth for decisions.** Tasks reference architecture /
   coding-guideline pages by link, never by paraphrase. If a task disagrees with an
   architecture page, the architecture page wins and the task gets fixed.
5. **Notes is for human flags only.** One short sentence, only if a human needs to
   see something before the session starts. Leave it blank otherwise.
6. **Each task is exactly one Type — no hybrids.** A task is `📐 Design` *or*
   `💻 Code` *or* `🔧 Operational` *or* `🔎 Investigation`, never two at once. If both
   spec-locking and implementation are needed, that is two tasks: a Design task upstream
   that closes when the spec is locked, then a Code task downstream that implements
   against it. Likewise a code fix that an **Investigation** surfaces is a *separate*
   `💻 Code` task the Investigation files — never folded into the Investigation's own
   acceptance criteria. (See `procedures.md` § Task types for what each Type triggers
   once Ready, and the `🔧 Operational & 🔎 Investigation` section below for those two.)

---

## Required sections (in order)

Every task page carries these sections, in this order. Some vary by Type — noted inline.

### Summary
One sentence: what is being built/decided and why it matters to the system. No
implementation detail — that belongs in Context.

> ✅ *Code:* `Implement PermissionEngine — a stateless evaluator returning allow | deny | escalate for every tool call.`
> ✅ *Design:* `Lock the common ingestion interface — batch vs streaming Protocol shape, payload contract, idempotency layering.`
> ❌ `This task is about the engine which will be used to evaluate tool calls.`

### Dependencies
Bulleted list of the task names this task **directly** depends on (immediate blockers
only, never transitive). Write `*None.*` if there are none. This is the human-readable
mirror; the machine-authoritative dependency list is the **`Depends On`** property
(pipe-delimited page IDs — see `procedures.md`).

**Hard-block vs soft-order — prefer to sequence.** A dependency here is a **hard block**: B
lists A only if B *cannot be correctly implemented*, or would *collide* with A, until A is
✅ Done. The test: *would B produce a wrong/broken result, or race A's worktree (shared code /
migration number / prod state), if both ran at once?* **Yes or unsure → hard-block.** A mere
preference ("nicer after A") is **soft order** — it is *not* a dependency, is not persisted on
the task, and enforces nothing; it lives only in the grooming conversation. Because the
auto-dispatcher launches **every** unblocked Ready Code task in parallel, **under**-declaring is
the dangerous, hard-to-unwind error (conflicting worktrees race) while **over**-declaring is cheap
and reversible (a task just waits). Resolve uncertainty toward the hard block — see
`procedures.md` § Task types.

### Context
The "why" and the spec.
- **Design/Planning tasks:** the decision space — what is being decided, the options,
  the constraints, what upstream tasks already settled, what downstream tasks consume
  this. Cross-link the architecture page(s) that will be updated.
- **Code tasks:** the implementation spec — type signatures, function/class
  skeletons, configuration values, file paths, event names.
- **🔧 Operational / 🔎 Investigation tasks:** see the dedicated section below — they
  carry a **Mode declaration** and a different Context shape (target surface + audited
  path for Operational; observed anomaly + decision space + falsification for
  Investigation).

**Write code skeletons, not essays.** A typed skeleton with stub bodies beats three
paragraphs describing it. Where exact code isn't needed, be concrete about shapes:
field names, return types, file paths.

**Call out constraints explicitly, inline.** Surface the project's load-bearing
architectural constraints relevant to this task (e.g. layer/purity rules, "no X from
this file", statelessness). The canonical list lives on the project's Coding
Guidelines / Technical Architecture pages — link them; don't paraphrase. If a task
disagrees with one of those constraints, the task is wrong, not the constraint.

### Acceptance criteria
Checkboxes split into two subsections:
- `### 🤖 Automated tests` — items verifiable by the type checker, linter, unit
  tests, or a script, with **no human in the loop**. Use the project's verify
  commands (from its `context.md` / `.claude-orchestrator.yml`). For Design tasks,
  write `*N/A — design task only.*`. Mandatory for every task.
- `### 👁️ Manual verification` — items requiring a running app/pipeline, a browser,
  observed runtime behaviour, or a human read-through of an updated Notion page (for
  Design tasks). Mandatory for every non-Code type. **For 💻 Code tasks it is
  authoring-time-optional** (real runtime items only, see below) and grooming removes
  it post-accretion — a post-groom Code task carries no manual-verification section.

Each item must be independently verifiable — pass/fail obvious without judgment.
Aim for **5–10 items total** across both subsections.

> ✅ *Code:* `SIGTERM handler calls shutdownAll() and exits with code 0`
> ✅ *Design:* `Technical Architecture page has a 'Common Ingestion Interface' section naming both Protocol signatures.`
> ❌ `The server handles shutdowns gracefully`

**Code tasks must not put runtime/launch-and-observe items in their own
acceptance criteria** — those belong to the milestone's **Manual Verification Gate**
(below; orchestrator-tracked state, not a task). A Code task's `### 👁️ Manual
verification` subsection is **authoring-time-optional**: write it only when there are
real runtime items to list (author judgment, not boilerplate). Grooming strips those
items to the gate and then **removes the section entirely** — it is not replaced with
`Covered by the Manual Verification Gate.` boilerplate. A post-groom (🗂️ Ready or
later) Code task therefore carries **no** manual-verification section at all; its
absence *is* the signal that verification is gate-owned. *(🔧 Operational /
🔎 Investigation tasks are the exception — they verify in-session, always carry the
section, and do NOT accrete to the gate; see their section below.)*

### Notion pages affected *(Design/Planning tasks only)*
Bulleted list of every Notion page this task creates or edits, with `*(new)*` or
`*(update — Section name)*`. The acceptance criteria reference these pages.

### Files / paths affected *(Code tasks only)*
Bulleted list of every file the task creates or modifies, with `*(new)*` or
`*(update)*`. Lets the implementing session know exactly where to work and prevents
scope creep into other files.

> 🔧 Operational tasks use **Targets / surfaces affected** and 🔎 Investigation tasks use
> **Deliverables** instead of this section — see the `🔧 Operational & 🔎 Investigation`
> section below.

### Implementation notes
Always present, always created empty: `> To be filled in during/after task completion.`
The implementing session fills it — workarounds, deviations, PR link (Code), final
decision summary (Design).

---

## Properties guidance

`procedures.md` is authoritative for **Type semantics** (which Type auto-dispatches vs
runs interactively) and the **`Depends On`** convention. This is the authoring summary:

| Property | Guidance |
| --- | --- |
| **Task Name** | Verb phrase starting with an action word (*Implement, Scaffold, Add, Fix, Migrate, Lock*). Include the primary file/class/decision. |
| **Type** | One of `💻 Code` / `📐 Design` / `📋 Planning` / `🔧 Operational` / `🔎 Investigation` / `🧪 Testing` / `📝 Docs` / `🎨 Assets`. Exactly one. See `procedures.md` § Task types. *(`🛠️ Tooling` is retired — split into `🔧 Operational` + `🔎 Investigation`; it survives only on grandfathered pre-split tasks, never author a new one. `🚦 Gate` is also retired — the Manual Verification Gate is now orchestrator-tracked state (`gate_item` rows), not a task Type; see § Manual Verification Gate. `🧪 Testing` is observational/E2E only → `ops` as an Investigation variant; **pure test implementation is `💻 Code`**.)* |
| **Priority** | `🔴 High` = blocks others / on the critical path. `🟡 Medium` = important, not blocking. `🟢 Low` = nice-to-have this milestone. |
| **Status** | New tasks always start at `🔲 Backlog`. See Readiness gate below, and `procedures.md` § Status values for the full set (incl. the rare, orchestrator-set `🚫 Blocked`). |
| **Depends On** | Pipe-delimited page IDs of *direct* dependencies, machine-consumed. Blank if none. The body `## Dependencies` section is its human-readable mirror. |
| **Notes** | One short human-facing sentence, or blank. |

---

## Readiness gate — Backlog → Ready

New tasks start at `🔲 Backlog`. A task moves to `🗂️ Ready` only after **all** hold:

1. **Investigation is complete** — design space mapped (or root cause traced for a
   bug), constraints identified, relevant code paths / upstream decisions read.
2. **All open questions are resolved** — no unresolved trade-off remains. If the body
   has an `## Open questions` section (or a `> ⚠️ Open question:` callout), it is by
   definition not Ready.
3. **Acceptance criteria are specific and testable** — not `investigate and decide`.
4. **No deferred decisions in the body.** "Decide at implementation time," "TBD by
   impl session," "implementer chooses" are Backlog-class — this is the operational
   line between Backlog and Ready. *(Carve-out: a 📋 Planning task's job is to produce
   decisions; its readiness is about its own scope/method being clear, not about the
   questions it will answer being pre-resolved.)*
5. **A human has reviewed and confirmed** the scope.

> ⚠️ **Never create a task directly at Ready.** Tasks created by any automated or
> investigation session start at Backlog; only a human review promotes them. Marking
> a 💻 Code task Ready is a live action — the orchestrator auto-dispatches it — so an
> under-investigated Ready task becomes a broken worktree, not a review comment. This
> is enforced by the `check-task-status.mjs` PreToolUse hook.

For the procedure that applies this gate across a milestone's backlog, that is the
**`/groom` skill** — the single source of truth for the grooming procedure (there is
no Notion grooming-procedure page).

### Grooming-time promotion artifacts (size_check · type_check · split/merge)

When `/groom` promotes a task, it records structured **promotion-gate artifacts** the
orchestrator enforces server-side (`groomGate.ts`). Authors don't write these — the groomer
does — but the standard names them so authoring and grooming stay aligned:

- **`size_check`** — the size classification, shape
  `{ loc, loc_method, files, decision, split_into?, reason? }`. `decision` is one of
  `no_split` / `split_now` / `unsplittable` / `n/a` (Design/Planning). `split_into` carries the
  sibling task ids when `split_now`; `reason` the one-line justification when `unsplittable`.
  **Present-and-dispositioned, not a correctness gate**: the promotion gate blocks a Ready-flip
  that omits it, but it enforces that a decision was *recorded* — it does not itself judge the
  LoC number.
- **`type_check`** — the type/content-mismatch scan (does the body's shape match its declared
  Type?). Also **present-and-dispositioned and advisory**: a flagged `type_check` never
  hard-blocks promotion on its own; the groomer must record a disposition, not clear the scan.
- **Split / merge are orchestrator-driven — a grooming session *nominates*, never *performs*.**
  When a task trips the split threshold (or two tasks should merge), the groomer **records a
  nomination**; the **orchestrator confirms and routes the split/merge to a dedicated session**.
  A grooming session never itself edits the task set into N pieces. (Detect → confirm → route;
  a candidate far over the floor may auto-confirm, otherwise it waits for the operator.)

---

## Manual Verification Gate

Runtime/manual checks must **not** be scattered across code tasks. Each milestone gets one
**Manual Verification Gate** acting as a single runtime-verification checkpoint. The gate is
**orchestrator-tracked state, not a Notion task or a Type** — every verification item lives as a
`gate_item` row, and every attempt is a `gate_item_event` (that event log **is** the durable run
record — there is no dated run-note written back into a task body).

- **Why:** checking runtime behaviour after every code task means repeated
  context-switching and re-launching. One focused gate keeps the automated/manual
  split clean inside every code task.
- **In code tasks:** include only what's verifiable without a running app (type
  check, lint, unit tests, build). Strip every "launch and observe" item; after
  accretion, the groomer **removes** the code task's manual-verification section from
  the body — it does not leave a boilerplate line behind. A Code task's manual/runtime
  verification is owned by the gate at that point; sessions must not try to run or
  evaluate it (this default lives in the coding and review session prompts, not in the
  task body).
- **The gate items:** each `gate_item` row carries a **classification** (e.g. `Prod-Mutating`
  vs read-only) and a **state machine** — `open` → `runnable` → `pass` / `fail` / `deferred`,
  with `Prod-Mutating` passes parked at `pending-approval` until a human consents. Items become
  **runnable** when deploy-gated (the source change is deployed). There is no `Depends On` to
  manage and no task body to edit.
- **Running the gate:** a human runs it once at milestone end via the **`/gate` skill** — a thin
  loop over the gate-state API (`readiness` → pull runnable items by tier → human disposition →
  record the `gate_item_event`). `readiness` reports `green` when every item is `pass` or
  `deferred`, `blocked` otherwise (the blocking items are the worklist). Nothing is auto-dispatched.
- **Triage each candidate before transcribing it — accretion is not a wholesale copy.**
  The pre-groom `### 👁️ Manual verification` section's lines are *candidates* for the gate,
  not automatic gate items. Before accreting, the groomer classifies every candidate line as
  one of three outcomes: `runtime-observable` (only knowable by running the system and
  looking — accrete it as a gate item), `config-or-code-determined` (answerable from source,
  settings, or a unit test — never accrete it; relocate the line to the task's
  `### 🤖 Automated tests` section instead of dropping it), or `needs-triage` (genuinely
  unclear — accrete it flagged, as today). **The deciding question:** would a headless
  verifier be able to cite a behavioural trace for this, or only cite the code? If only the
  code, it is a test, not a gate item. **Disposition, don't drop:** the count of candidates in
  must equal the count accreted plus the count relocated to `### 🤖 Automated tests` — this is
  what prevents re-opening the exact silent-coverage leak (below) the mandatory-accretion rule
  exists to close. **Present-and-dispositioned, not a correctness gate:** the promotion gate
  requires a classification to be recorded for every candidate; it never re-judges which
  classification the groomer chose — same posture as `size_check` / `type_check`.
- **Accretion is mandatory and promotion-gated — not best-effort.** Because a
  💻 Code task's body is *required* to strip its runtime items (above),
  those items live nowhere else — if the groomer doesn't accrete them to the gate, they
  are lost from the body **and** the gate (a silent coverage leak; e.g. a launch-only manual
  check was stripped from a task body but never landed on the gate — found only by a later
  coverage audit). So **before** any 💻 Code
  task is marked `🗂️ Ready`, the groomer MUST either (a) accrete its stripped
  runtime / launch-and-observe items to the milestone's gate via `accreteGateContribution`
  (which writes the `gate_item` rows, keyed by milestone display name, grouped by source task),
  or (b) confirm it has none — and record the outcome as a `gate_contribution`
  artifact in `grooming-state.json`: `{ "items": [...], "accreted_at": "…" }`
  or `{ "decision": "none" }`, with each item in `items` carrying its recorded classification.
  This is symmetric with `size_check` / `hard_block_deps` /
  `signoff` — same shape, same load-bearing weight. A Ready-flip that strips manual items
  from the body without accreting them to the gate is the same class of failure as locking
  sequencing in the task body instead of the `Depends On` property: the downstream artifact
  (here, the `gate_item` store) is the only place the information survives.
- **Follow-up tasks** that depend on confirmed runtime behaviour cannot list a gate *task* in
  `Depends On` (there is none) — sequence them after the milestone's gate run, or on the specific
  Code task whose behaviour they need.

---

## Milestone config-seed (the operational twin of the Manual Verification Gate)

Operational **data/config seeds must not be scattered across code tasks** as un-owned inline
notes. A 💻 Code task frequently ships pure dispatchable code (a new worker + its registration
with a pipeline runner, an alias/cohort mechanism, a new config category) **plus** a prod-data
seed that is *correctly* not in the auto-dispatched PR — a config-defaults table row, a config
category's default values, alias/cohort flags, etc. Left as an
inline "applied operationally on prod" note, that seed is owned by no one, and after merge the code
sits **dark until someone hand-seeds it** — the "Done ≠ deployed ≠ seeded ≠ working" / silent-0
failure class, un-owned. So each milestone gets one dedicated **config-seed** task that
accretes every code task's operational seed — the exact operational mirror of the Manual
Verification Gate.

> **Moving to a sibling state store.** Like the gate (now `gate_item` rows), the config-seed's
> accretion target moves from a task body to a sibling **`seed_item`** state store — each seed a
> `seed_item` row (accreted via `stageSeedContribution`, deploy-gated for applyability), applied at
> milestone end through the audited config-CRUD and recorded as a `seed_item_event`, driven by the
> `/ops` skill's § Milestone config-seed loop. The mechanics below (what accretes, reconcile +
> capture) carry over unchanged; only the storage moved off the task body. Detail lives in the
> config-seed-as-state model.

- **Schema vs data — the load-bearing split.** *Schema / DDL* → a **migration in the Code task's
  own PR** (auto-dispatched, forward-only). *Data / config seed* (rows, defaults, flags) → the
  **milestone config-seed task**, applied operationally on prod (**prod is the source of truth for
  seeded data**; it does not belong in `migrations/`). A task with both ships the migration in its
  PR and accretes the seed. *(This is the universal form of the project-specific "data-only seeds
  are operational" rule that also lives in a project's `context.md`.)*
- **The config-seed task:** Type `🔧 Operational` — `Mode: 🔧 Operational · directed`, **or
  `· research-first`** if any seed's values still need gathering/confirmation (e.g. when the concrete
  config values and their defaults must be gathered and confirmed before authoring). One per milestone;
  **rests at `🔲 Backlog` / `🗂️ Ready` and accretes** — `/groom` appends each code task's seed as
  it's groomed (the accumulator lifecycle, like the Gate — not a modify-a-Ready-task exception).
  Never auto-dispatched; a human runs it **at milestone end, after the code is merged and
  deployed**, through the **audited config-CRUD + change-signal** path, never raw SQL. It **does not
  itself accrete to the Manual Verification Gate** (it is operational, not runtime-manual).
- **Reconcile + capture is the acceptance** — and it catches the specific prod gotcha: a
  long-running worker that reloads config on a change signal must **pick up the change via the
  CRUD-fired change signal, without a restart** (config hot-reload; if
  it doesn't, restart the runner), **and** the seeded mechanism must **actually emit**. Authoring a
  row is not seeding; a change signal that the runner's stale config-cache ignores is not seeding.
  (This hot-reload caveat is documented in the project's `context.md`.)
- **Bidirectional cross-reference.** The config-seed task body lists **every seed + its source-task
  ID**, grouped by source task; **each contributing Code task points back at the config-seed task**
  (a one-line "operational seed: applied via the milestone config-seed task `<task-id>`" in its body,
  in place of a free-floating inline note).
- **Accretion is mandatory and promotion-gated — not best-effort.** Because the seed is deliberately
  kept out of the Code task's PR, the config-seed task is the **only** place it survives. So
  **before** any 💻 Code task carrying an operational seed is marked `🗂️ Ready`, the groomer MUST
  either (a) append that seed to the milestone's config-seed task body (grouped by source task,
  creating the config-seed task if absent) **and** add the back-reference to the Code task, or
  (b) confirm the task has **no** operational seed — recording the outcome as a `seed_contribution`
  artifact in `grooming-state.json`: `{ "seed_task_id": "…", "seeds": [...], "appended_at": "…" }`
  or `{ "decision": "none" }`. Symmetric with `gate_contribution` — same shape, same load-bearing
  weight. Dropping a seed into an inline note without accreting it is the same silent-coverage-leak
  class as stripping a manual item without accreting it to the Gate. *(Mechanical enforcement —
  `seed_contribution` seeding + a `milestone_seed_task_id` field in `groom-load.mjs`, plus a
  promotion-gate hook check in `groom-gate.mjs`, mirroring the Gate's — is tracked by the Backlog
  task **Enforce milestone config-seed accretion in /groom** on the milestone board (mirroring the
  Gate's enforcement task); until it ships, groomers apply this by hand.)*
- **Acceptance criteria:** two-subsection format — `### 🤖 Automated tests` reads `*N/A —
  operational task; verification is by reconcile + capture.*`; `### 👁️ Manual verification` lists,
  per seed, "applied via audited CRUD + change signal; worker hot-reloaded (or runner restarted); the
  mechanism actually emits (reconcile + capture)".

---

## 🔧 Operational & 🔎 Investigation tasks

These two Types replace the retired `🛠️ Tooling`. Both are **judgment-bound and never
auto-dispatched** — they are executed by the **`ops` skill** (see `procedures.md`
§ Task types). They are distinguished by their **primary deliverable**, and each carries a
**Mode declaration** line at the top of its Context.

> **Two run postures, distinct by whether an operator is in the loop** (see `procedures.md`
> § Task types). An **autonomous** (unattended) ops run **stages only** — provisional
> findings / staged proposals to the journal, never verdicts, never ✅ Done. A **dispatched /
> interactive** ops run is **write-capable**: it earns capabilities on request and **drives
> the `ops_journal` to `applied-pending-confirm`** (change applied, reconciled, evidence
> captured) via the request → grant → apply → reconcile loop, with the operator making only
> the final `applied-pending-confirm` → `resolved` confirmation. "Stages only" describes the
> autonomous posture, not a ceiling on what a dispatched ops session does.

### 🔧 Operational — change prod/environment state through a sanctioned surface
The deliverable is a **verified change** to production or the operating environment
(config/catalog/entity authoring, a backfill/re-derive, alarm config, a dependency install,
wiring a tool/MCP into sessions, a machine migration). The decision is already made; the
uncertainty is **breadth / source / mechanics**, never *whether* or *what*.

- **Mode declaration:** `Mode: 🔧 Operational · directed` (fully-specified change, little/no
  research) **or** `Mode: 🔧 Operational · research-first` (the *what to author* needs research;
  governed by "research → present → author on confirmation; never apply before presenting").
- **Context:** the **target surface** (which config category / catalog / entity set / host),
  the **audited path** to use (the project's config-CRUD / ops affordance — never raw SQL), the
  **read-modify-write** requirement for any replace-semantics shared state, and the
  **reconcile + capture** check that proves the worker heard the change and a record landed.
  For research-first, state the research scope + the source-of-truth to pull from.
- **Acceptance criteria:** `### 🤖 Automated tests` is usually `*N/A — operational task;
  verification is by reconcile + capture.*` `### 👁️ Manual verification` lists the **in-session**
  checks (seed present on prod; worker reconciled; correct breadth authored; "Done ≠ deployed ≠
  seeded ≠ working"). **Operational tasks do NOT accrete to the Manual Verification Gate** — they
  self-verify when run.
- **Milestone config-seed accretion (grooming-time).** A 💻 Code task's *operational data/config
  seed* — a prod-data row/flag/default deliberately kept **out** of its auto-dispatched PR — accretes
  at grooming time to the milestone's one **config-seed** `🔧 Operational` task, the operational twin
  of the Manual Verification Gate (see § Milestone config-seed). Schema/DDL still ships as a migration
  in the Code task's PR; only data/config seeds accrete.
- Use a **Targets / surfaces affected** section (config categories / catalog entries / entities /
  hosts) in place of *Files / paths affected*.

### 🔎 Investigation — produce a defensible decision from live data
The deliverable is a **decision** (diagnosis, disposition, go/no-go spike) plus **filed
follow-on tasks**. The uncertainty is **the conclusion itself**.

- **Mode declaration:** `Mode: 🔎 Investigation` (or `Mode: 🔎 Investigation · spike` for
  verifying an external surface before code depends on it).
- **Context:** the **observed anomaly by value with provenance**, the **authoritative doc** to
  consult first, the **decision space / branches** (a/b/c → what each implies and what gets
  filed), and the **falsification** to run ("what would I observe if this were false, and did I
  look?"). Treat any registered number as a claim to re-derive, not a fact.
- **Acceptance criteria:** `### 🤖 Automated tests` is usually `*N/A — investigation task.*`
  `### 👁️ Manual verification` lists: the decision reached is defensible (falsification run);
  evidence recorded with provenance; follow-on tasks filed with **accurate priority**.
- Use a **Deliverables** section (the decision + the follow-on tasks it will file) in place of
  *Files / paths affected*. **Never** put "implement module X" in an Investigation's acceptance
  criteria — a code fix it surfaces is a *separate* `💻 Code` task it files (an Investigation
  legitimately *produces* Code tasks; it must not *be* one).

### 🧪 Testing — observational/E2E is an Investigation variant; pure test implementation is Code
A 🧪 Testing task is only for **observational / E2E** work — *run the system live and observe*,
reaching a **`disposition`** — `pass` (verified by value), `blocked-pending-fix` (issue surfaced →
file the fix + set this task 🗂️ Ready + `Depends On` it), or `pass-with-caveat` (**there is no
"fail"**). Executed by the **`ops` skill** as an 🔎 Investigation variant (same by-value + falsify +
root-cause bar), and declares **`Mode: 🧪 Testing · observational`** (or `· e2e`).

- **Pure test implementation is 💻 Code, not 🧪 Testing.** Writing unit/integration tests, fixtures,
  or harness code — with **no dependency on data only available at run time** — is dispatchable code;
  author it as a `💻 Code` task so it flows through auto-dispatch. Filing it as 🧪 Testing (or
  `Mode: 🧪 Testing · authoring`) only gets it **excluded** from `/ops` with a "reclassify → Code" flag.
- **Acceptance criteria:** like Investigation — `### 🤖 Automated tests` reads `*N/A — observational
  testing task.*`; `### 👁️ Manual verification` states the **disposition** (`pass` shown *by value*,
  not a green-looking zero; or `blocked-pending-fix` with the filed fix + `Depends On`).

### Classifying at authoring time
Classify by the **primary deliverable**: a verified prod change ⇒ Operational; a decision ⇒
Investigation. Watch the two smuggling shapes: an "Operational" task whose *what* can only be
decided by live-data diagnosis is really **Investigation**; an "Investigation" that bundles a
well-specified code change is two tasks (Investigation + Code). *(At runtime the `ops` skill may
still convert a task between the modes under its drill-budget rule — but author it as its primary
shape, don't pre-hedge.)*

## Common mistakes to avoid

- **Putting the spec in Notes.** Notes is one human-facing sentence. Specs go in Context.
- **Vague acceptance criteria.** "Works correctly" is not a criterion; a concrete
  command-and-expected-output is.
- **Missing file paths (code) / page references (design).** A code task that doesn't
  list the files it touches, or a design task that doesn't name the pages it updates,
  is under-specified.
- **Over-scoping.** If Context runs more than ~3 screens, the task probably needs
  splitting. Each split must still be implementable independently.
- **Under-specifying interfaces.** If a task produces a class/function other tasks
  import, fully specify the signature here — type signatures are load-bearing.
- **Runtime items in code-task acceptance criteria.** They belong in the Manual
  Verification Gate (accreted as `gate_item` rows), not the code task's body.
- **Creating tasks at Ready without investigation.** "Investigate and fix X" is
  Backlog, not Ready — do the root-cause analysis first, then specify the fix.
- **Skipping open-question resolution.** Trade-offs unresolved → stays Backlog.
  Present options with pros/cons, get a human decision, then move to Ready.
- **Deferring investigation to the implementing session.** "Decide during
  implementation" pushes a design decision onto a session with neither the context nor
  the mandate to resolve it. Resolve in grooming.
- **Disagreeing silently with an architecture page.** If a task contradicts a locked
  decision, fix the task — or open a separate Design task to revisit the decision.
  Never quietly diverge.
- **Including an Out-of-Scope section in the body.** Out-of-scope is a grooming-time
  concern. If a constraint must reach the implementing session, fold it into Context
  as an inline constraint; otherwise leave it out.

---

## Per-project additions

A project may extend this standard with slivers that only make sense for it — verify
commands invoked by acceptance criteria, the load-bearing architectural constraints to
surface in Context, migration-ID declaration rules, extra Type conventions. Those live
in the project's **`context.md`** and its Coding Guidelines / Technical Architecture
pages, never copied back into this file.
