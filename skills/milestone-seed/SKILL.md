---
name: milestone-seed
description: >-
  Stand up a NEW milestone: ground in the prior milestone's real state and the
  live dispatch switches, audit the Future Scope deferral list, frame and lock a
  charter with the operator, create the milestone board, and seed it with
  decision-shaped 📐 Design (and 🔎 Investigation) tasks grounded in real code.
  Use when the user says "let's start planning milestone X", "seed milestone X",
  "let's seed M15", or opens a session to stand up the next milestone. Ends with
  the board SEEDED AND INERT — registering and activating it belongs to
  /milestone-wrap. Distinct from /groom and /design, which work an EXISTING
  milestone's backlog.
---

# Milestone Seed

Standing up a milestone is **framing work with a persistence tail**. The framing —
what this milestone is *for*, and what it deliberately is not — is the hard part
and the part that decays if it lives only in chat. The tail is mechanical: a board,
a charter, a seed set, four homes updated.

```
/milestone-seed ──▶ board + charter + seed tasks (INERT)
                          │
                          ├──▶ /design  (works the 📐 Design tasks)
                          ├──▶ /groom   (brings 🔲 Backlog to 🗂️ Ready)
                          └──▶ /milestone-wrap  (registers + activates it, when the prior one closes)
```

> **You do not activate the milestone.** `/milestone-wrap` Steps 4–5 own marking the
> next milestone active — repointing `projects.auto_launch_milestone_id`, the Notion
> "Active Task Board" callout, the phase line. This skill stops at *seeded*. That
> boundary is what makes it safe to seed while the prior milestone is still running.

> **Not `/groom` or `/design`.** Those work an existing milestone's backlog. This
> creates the milestone. Don't conflate them.

## Doctrine

- **Ground in the record, never in memory.** Read the actual prior board, the actual
  charter, the actual code. An "obvious gap" is very often a doc imprecision — falsify
  before you file.
- **Frame before you build.** Nothing is created until the operator has signed off on a
  charter in prose. A board created before the framing lands is a board you will fight.
- **The live switches outrank the docs.** `context.md` describes intent; the DB
  describes reality. Read both, and when they disagree, say so.
- **Two gates, not one.** Approving the *seed set* and approving the *task bodies* are
  separate operator decisions. See Step 5.
- **Don't hand the work back.** Find the prior charter, the deferral list, the live arm
  state yourself. Ask the operator for decisions, not for locations.

---

## Step 0 — Resolve the project and establish the live switches

`Read config/projects/<dir>/context.md` for the board IDs, master Notion page, project
id-space, and per-project conventions. Then read the **live** state — not the doc's
description of it:

Open the orchestrator DB **read-only** with the bundled `better-sqlite3` and read three
tables. **The DB path and the runtime directory to run from are host facts — take them from
the project's `context.md`** (§ Inspecting live state), or `$ORCHESTRATOR_DB_PATH` where it
is set; this skill deliberately does not hardcode either.

```js
// run from the runtime backend dir named in context.md; { readonly: true }, never a write
const db = require('better-sqlite3')(process.env.ORCHESTRATOR_DB_PATH, { readonly: true });
db.prepare('SELECT id,name,canonical_short_id,wrapped_at FROM milestones WHERE project_id=? ORDER BY display_order DESC LIMIT 4').all('<projectId>');
db.prepare('SELECT id,auto_launch_enabled,auto_launch_milestone_id FROM projects').all();
db.prepare('SELECT * FROM flow_arm').all();
```

> Put a non-trivial query in a `.cjs` file rather than a `node -e` one-liner: in `node -e` a
> **double-quoted** SQL literal is parsed by SQLite as an *identifier*, so it silently becomes
> a column reference. Single-quote SQL literals, as above.

**Report any disagreement between `context.md` and the DB to the operator.** On the M15
seed, `context.md` said `auto_launch_milestone_id` pointed at M13 and described the
switch as deliberately unflipped; it had since been repointed to M14 with the `groom`
arm `armed=1`. That changes whether filing anything is live.

**Three things you must know before filing anything:**

1. **Is the prior milestone's `groom` arm armed?** If yes, filing a 🔲 Backlog task on
   *that* board is a live action — it consumes a dispatch slot and a groom session's
   tokens, and adds a decision to the operator's queue.
2. **Where does `auto_launch_milestone_id` point?** That is the only milestone
   `AutoLauncher` polls.
3. **A brand-new board is inert.** It has no `milestones` row (those come from
   `ProjectService.insertMilestone`, an explicit API action — there is no
   auto-discovery from Notion), so nothing on it can be groomed or dispatched.
   `DEFAULT_ARM` is `false` for every flow. **State this to the operator** — it is the
   safety property that makes seeding during an active milestone fine, and it should
   not be nervously re-derived every time.

---

## Step 1 — Ground in the prior milestone

Never reason from memory about what the last milestone did.

- **Enumerate its board fully** — `node ~/.claude/scripts/notion-query.mjs <db-id> --env
  <repo>/packages/backend/.env --json`. Summarize by Status × Type. What is still open
  tells you what is about to spill into the new milestone.
- **Read its charter** (the board's own description) and the master Project Context page.
- **Read the code** any candidate theme touches, before asserting a gap exists.

> ⚠️ `notion-query.mjs --json` keys the title under `Task Name` / `_title`, **never**
> `title`. A scan written as `r.title` reads `undefined` on every row and reports a
> clean "no match" rather than erroring.

**Look at what the prior board's leftovers are made of.** If its open tail is mostly
small bugs and polish unrelated to its charter, that is evidence about what the next
milestone should be — the board is telling you what it is actually producing.

---

## Step 2 — Audit the Future Scope deferral list (mandatory)

Deferrals are the raw material for the next milestone. **Do this before framing the
charter, not after** — on the M15 seed, one entry became the entire feature track.

Read the project's Future Scope page in full. For **every** entry, reach one of:

| Disposition | When |
| --- | --- |
| **Retire** | Superseded by shipped code, or its stated premise is falsified |
| **Reframe** | The need is real but its stated blocker or rationale is stale |
| **Consolidate** | Several entries share one trigger — collapse them into one |
| **Promote** | It becomes a track or a task in the new milestone |
| **Keep** | Still valid — but only with a *checkable* promotion condition |

Four rules that make this worth doing:

1. **Falsify by measurement, not memory.** An entry's argument is a claim. On the M15
   seed, one entry justified itself with "421 firings in 14 days"; the live count was
   **6 in 14 days** against a *higher* session count — a ~70× collapse that killed the
   entry. Two more died because the code they asked for had shipped.
2. **Every keep states a condition you can check.** "Revisit if it becomes a problem" is
   malformed. "Promote when a rate-limit 403 is observed under sustained load" is not.
   Without this the page rots into an un-triageable list nobody can act on.
3. **Consolidate entries that share one bet.** Six distribution deferrals on the M15
   audit were a single "if this goes outward-facing" decision — a third of the page's
   length, and one choice, not six.
4. **The audit is a discovery channel, not cleanup.** Measuring to test one entry is how
   the M15 seed found a 220-message/month session re-drive loop that nobody had ever
   looked at. Two seed tasks came out of it. Expect this; leave room for it.

**Writing the result back.** The page is a flat list, so a `notion.pageEdit` staged
intent is the audited path — it fails closed on a stale base and leaves an audit trail:

- Reconstruct the page's **exact** current serialization first. `old_str` is matched
  against `blocks.map(blockToLine).join('\n')`, where `blockToLine` joins `plain_text`
  — which **strips bold, inline code and link URLs**. The `notion-page.mjs` export does
  *not* match this (it preserves them). Rebuild it by replicating `blockToLine`, or the
  match fails.
- `page_id` must be **`notion:`-prefixed**. A bare uuid dies at apply time with
  `Invalid task ID (no colon)` — `applyPageEdit` runs it through `toExternalId`.
- The apply rewrites the whole page through `markdownToBlocks`, which does **no** inline
  markdown parsing. `**bold**` renders as literal asterisks. **Write plain text** (emoji
  anchors work well) and tell the operator the pass flattens inline formatting.
- Verify by re-reading and diffing against your intended body. Do not trust the 200.

---

## Step 3 — Frame the charter, and get sign-off before creating anything

This is the step that matters. Do it as **dialogue**, not a document drop.

- **Name the gap.** Classically the *substrate-vs-agency* gap: what the prior milestone
  *built* versus what this one must *run*. Reflect your understanding back so the
  operator can reframe it — they will, and that is the point.
- **A loose or rolling milestone is a legitimate shape.** Not every milestone is a
  tightly-themed build-out. "Mostly bug-fixing and small changes" has direct precedent
  (M8 *Ongoing Maintenance*, M9) and both closed cleanly. **But it still needs a premise
  and non-goals** — convergence is machine-tracked (gate readiness, config-seed, the
  convergence panel), and a milestone with no boundary cannot converge. Bound it by
  **kind of work** rather than by a task list.
- **Non-goals are as load-bearing as goals.** Write them as things a future session can
  check itself against. The most useful ones name a temptation and refuse it.
- **Lock it as prose, and get explicit sign-off.** Only then create anything.

**Persist it in the right home:**

| Content | Home |
| --- | --- |
| The charter (premise, principle, tracks, non-goals) | **The milestone board's own description** |
| One concise sentence | The master page's 🏁 Project Milestones table |
| Deferrals | 🔭 Future Scope |
| Universal procedure | `config/procedures.md` |

There is **no** Key Decisions Log on the master page — it was retired 2026-07-26. Do not
re-add one.

---

## Step 4 — Create the board

A milestone board is a Notion **database child of the master Project Context page**.

**The schema must mirror the prior board's Status / Type / Priority options exactly** —
same option names, same colors — or the orchestrator's board reader breaks. Fetch the
prior board first and copy its option set rather than retyping it.

```
Task Name  TITLE
Type       SELECT(💻 Code:purple, 📐 Design:pink, 📋 Planning:blue, 🔧 Operational:orange,
                  🔎 Investigation:yellow, 🧪 Testing:green, 🚦 Gate:red, 📝 Docs:gray,
                  🎨 Assets:brown, 🛠️ Tooling:default)
Status     SELECT(🔲 Backlog:gray, 🗂️ Ready:gray, 🔄 In Progress:yellow, 👀 In Review:orange,
                  ✅ Done:green, 🚫 Blocked:red, ⏭️ Deferred:gray)
Notes      RICH_TEXT
Priority   SELECT(🔴 High:red, 🟡 Medium:yellow, 🟢 Low:green, P2:brown)
Depends On RICH_TEXT
```

> **Verify the mirror functionally, not visually.** Read the new board back through
> `notion-query.mjs` and confirm the property keys match the prior board's
> (`Task Name`, `Status`, `Type`, `Priority`, `Depends On`, `Notes`). Eyeballing the
> creation response is not the same check — the reader is what has to work.

Record the new **data-source id** (`collection://…`) in the project's `context.md`
alongside the prior boards; `notion-create-pages` needs it, and the database id will not
do.

---

## Step 5 — Seed the tasks (two gates)

Seed **📐 Design tasks with decision-shaped Open Questions grounded in real code**, plus
🔎 Investigation tasks for live symptoms the grounding surfaced. Read
`config/task-writing.md` at the moment you author — it is reference content, not a
skim-once summary.

**Two separate operator gates. Do not collapse them:**

1. **The seed set** — how many tasks, what each covers, what its open questions are.
2. **The task bodies** — the drafted content. `procedures.md` § Task authoring: *"Draft
   in conversation first; publishing to Notion is a separate, human-approved step.
   'Write a task' authorizes the intent, not the draft."*

If you judge gate 2 satisfied by a detailed gate-1 approval, **say so explicitly** so
the operator can cheaply disagree. Filing on an unregistered board is inert and fully
reversible — that is the mitigation, not a reason to skip the gate.

**Authoring rules specific to seeding:**

- **Every Open Question is a decision between named, real options** with `file:line`
  anchors — so `/groom` can validate-and-promote and `/design` invents nothing. Add a
  *Code anchors* note to each Context so the grounding travels with the task.
- **Open-question count is a diagnostic, not a target.** Fewer than ~2 → fold the task
  into a sibling. More than ~6 → **split it**. Never drop a genuine question to hit a
  tidy count — split, don't trim; disposition, don't drop.
- **Hard-block generously.** Under-declaring races worktrees; over-declaring costs a
  wait. `Depends On` is pipe-delimited page IDs, so create the blocker first and wire
  the dependents after.
- **New tasks always start at `🔲 Backlog`.** Never create one at Ready. (Enforced by
  the `check-task-status.mjs` hook.)
- **Do not create milestone scaffolding.** The Manual Verification Gate, the config-seed
  task, testing and docs tasks are **deliberately deferred to grooming**. Creating them
  at seed time is premature.
- **State the milestone key space at every call site.** `gate_item.milestone` /
  `seed_item.milestone` store the **display name**; `ops_journal.milestone` /
  `flow_arm.milestone_id` store the **UUID**. Two shipped bugs came from resolving one
  and querying the other — neither errored; both matched zero rows.

---

## Step 6 — Run a completeness critic on the milestone

Ask: *"what would an implementer of this milestone hit that no task owns?"* File the
gaps.

Distinguish a genuine **design gap** (file it) from **milestone scaffolding** (the gate,
config-seed, testing, docs, migration ops — deferred to grooming, see above). And when a
verified "gap" turns out to be a doc imprecision, **clarify the doc — do not file
hardening work** or mutate code to force a distinction the design deliberately keeps
separate.

---

## Step 7 — Update the homes, then stop

- **The project's `context.md`** — board link, data-source id, and a short note that the
  milestone is seeded but **not registered**, so a future session knows filing on it is
  inert. Include the charter's most load-bearing non-goal.
- **The master Project Context page** — add one row to 🏁 Project Milestones (one concise
  sentence). **Do not** change the "Active Task Board" callout or the phase line; the
  prior milestone is still active and `/milestone-wrap` owns that flip.

> Anchor a `update_content` edit on **plain prose or a heading**, never a markdown table
> row — Notion's own serialization differs from the export (bare domains auto-linkify,
> straight quotes may curl, tildes escape). On a match failure, re-fetch and copy the
> exact serialized text.

Then **report and stop.** Do not offer to register, activate, or arm the milestone.

---

## Rules (hard)

1. **Nothing is created before the charter is signed off.** Not the board, not a task.
2. **Never activate the milestone.** No `milestones` row, no `auto_launch_milestone_id`
   repoint, no arming. That is `/milestone-wrap`.
3. **Never create a task at `🗂️ Ready`.**
4. **Never file on the *prior* milestone's board** to park an idea without telling the
   operator its groom arm state — on an armed milestone that is a live dispatch.
5. **Falsify before you file.** An apparent defect is often a doc imprecision. Read the
   code.
6. **Verify every write by reading it back**, through a different path than the one you
   wrote it with where possible.
7. **Plain-text questions to the operator, never `AskUserQuestion`** — it is denied by a
   PreToolUse hook in this environment.
8. **Inspect repos with `git -C <path>`, never `cd <path> && git`** — the latter trips a
   built-in hook-safety prompt that allowlisting cannot suppress. One command per Bash
   call.

---

## Provenance

Graduated from `config/procedures.md` § Milestone-seed sessions on 2026-08-08, after the
procedure had been exercised on M12 (2026-07-18), M13, M14 (2026-07-26) and M15
(2026-08-07). Steps 0, 2, and the two-gate rule in Step 5 are the M15 run's additions;
the rest is the procedures.md text, reorganized.

**Promoted to the repo** — this skill now has its source at `skills/milestone-seed/` and
is in the `SKILLS` vendoring list in `scripts/sync-guidelines-load.mjs`, so
`/sync-guidelines` both updates and backs it up. It was local-only (one copy, one disk,
unversioned) from 2026-08-08 until that promotion.

It was **not** split into `reference/` files at promotion time, though the original plan
in `procedures.md` called for it: at 334 lines this file is smaller than
`skills/gate/SKILL.md` (348) which carries no `reference/` directory, so the repo's own
convention does not call for a split at this size. Reconsider if it grows past ~450 lines,
the point where `/groom` and `/design` split.
