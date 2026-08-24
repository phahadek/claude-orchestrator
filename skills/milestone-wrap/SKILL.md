---
name: milestone-wrap
description: >-
  The interactive half of closing a milestone — the two steps the wrap
  playbook can't do for you: triage deferred/pending gate items with the
  operator (which ones carry forward vs. stay closed), then update the
  Notion master page + context.md bookkeeping. Everything else (terminal
  check, gate/seed green check, DB wrapped_at, auto-launch repoint, advance
  dev->main, cut the release tag) is the automated `wrap` playbook, run via
  its dashboard button. Use when the user says "wrap up milestone X", "close
  M11", "let's close out the milestone", or "triage the deferred items for
  the wrap". Distinct from /wrap (which closes a SESSION, not a milestone).
---

# Milestone Wrap

Closing a milestone is now mostly the automated `wrap` playbook (terminal check,
gate/seed green check, `wrapped_at`, auto-launch repoint, advance `dev`->`main`, cut
the release tag) — trigger it from the dashboard. This skill covers the **two things
that stay human-driven** because they need operator judgment or live outside the
playbook's sanctioned surfaces:

1. **Triage deferred + pending gate items** — deciding which ones are genuinely
   resolved (leave them) vs. real postponements (carry forward) is a judgment call,
   not something the playbook can safely automate.
2. **Notion master-page row + `context.md` edits** — the master page's Project
   Milestones table / Active Task Board callout / Project Summary, plus
   `config/projects/<dir>/context.md`'s Active Task Board line and milestone-history
   list.

> **Not `/wrap`.** `/wrap` sweeps a *session* for unpersisted residue. This closes a
> *milestone*. Don't conflate them.

## Doctrine (same spine as /gate and /ops)

- **Verify by reading, act via sanctioned surfaces.** Read the actual state (gate
  items, Notion pages) before asserting a step is done or needed; make every change
  through the project's sanctioned surface (`notion-update-page`, `Edit` on
  `context.md`, the gate-state client), **never a raw DB write**.
- **Don't hand the work back.** Find the "several places" yourself (they're enumerated
  below); don't ask the operator where they are.

## Step 0 — Resolve the milestone + load project context

Determine the milestone being closed and the next one. `Read
config/projects/<dir>/context.md` for the board IDs, the master Notion page, and the
project id-space. Project-specific values live there; this skill is the universal
shape.

## Step 1 — Carry deferred + pending gate items forward to the next milestone

**Green is not "all verified."** `readiness` counts `deferred` (and, for an item
awaiting its not-yet-triggerable condition, `pending`) as resolved
(`RESOLVED_STATES = {pass, deferred}` in `gateService.ts`, `pending` non-blocking by
its own backoff semantics), so a milestone with deferred or pending gate items reads
**green** and wraps clean — but neither state means *resolved*. `deferred` means
*postponed / not-yet-verified*; `pending` means *the item's trigger genuinely
hasn't happened yet and the item is backing off, waiting for another look*. Left
untouched, those items **die under the closed milestone**: nothing ever surfaces them
again. Every deferral (and every still-waiting `pending` item) was a promise to verify
later — this step keeps it. *(Gate-only: seed's sole resolved state is `confirmed` —
there is no deferred-or-pending-green seed state, so seed-green already implies no
postponed seeds. Nothing to carry on the seed side.)*

1. **Enumerate the deferred and pending items — `readiness` won't show them** (it
   lists only *blocking* items, and neither `deferred` nor `pending` blocks). Read
   them directly (LEFT JOIN — a sourceless item has zero `gate_item_source` rows and
   must not be dropped by the query); **reads** of the live DB are sanctioned (only
   *writes* are barred):

   ```
   SELECT gi.id, gi.classification, gi.state, gi.text, s.source_task_id, s.source_task_title
   FROM gate_item gi LEFT JOIN gate_item_source s ON s.gate_item_id = gi.id
   WHERE gi.project='<projectId>' AND gi.milestone='<closingM>' AND gi.state IN ('deferred', 'pending')
   ```

2. **Triage each with the operator.** A deferred or pending item is either **(a)**
   genuinely won't-verify / obsolete → **leave it** (its current state is correct
   closed-milestone history), or **(b)** a real postponement → **carry it forward**.
   Don't blanket-carry; don't blanket-drop.

3. **Re-home the carry set to the *next* milestone — a fresh copy, never a move.**
   Raw-DB moves are barred, so every carry is a fresh-copy insert into the next
   milestone; the original stays `deferred` / `pending` under the closing milestone
   (immutable closed-milestone history) while the copy lands `open` for a **fresh gate
   run**. Which verb mints the copy depends on whether the item has a source:

   - **Has a source (`source_task_id` is non-null).** Group the carry set by
     `(source_task_id, classification)` and use `accrete` — it takes one
     classification per call and mints one `gate_item` per `items[]` entry, sourced to
     that task (classification, incl. `needs-triage`, is preserved):

     ```
     node ~/.claude/scripts/gate-state-client.mjs accrete \
       '{"project":"<projectId>","taskId":"<source_task_id>","title":"<source_task_title>",
         "milestone":"<nextM>","classification":"<classification>","items":[{"text":"…"}, …]}'
     ```

   - **No source (`source_task_id` is null) — the item was itself hand-carried from an
     earlier milestone and has no single owning task left to cite.** Use
     `carry-forward` instead: an item-level re-home, one call per item, that copies the
     item's own text/classification/full sources array (empty, here) straight to the
     target milestone. **Never invent a placeholder taskId** and force it through
     `accrete` — it validates the id against the task board and 400s on anything
     synthetic, and a truncated/prose-embedded id you resolve by hand risks a silent
     mis-attribution (a short id prefix can collide across unrelated tasks). If you
     really can trace a sourceless item's prose back to one exact, full task id and want
     provenance restored, that is a manual accrete-with-caution; otherwise default to
     `carry-forward` and accept the item stays sourceless in the next milestone too —
     correct, not a downgrade:

     ```
     node ~/.claude/scripts/gate-state-client.mjs carry-forward <gateItemId> <nextM>
     ```

   Either way, `<nextM>` is the **display name** (e.g. `M12`), never the milestone UUID
   — same id-space rule as the rest of the gate client. A carried `pending` item lands
   as a fresh `open` item like any other carry — its backoff clock is **not** preserved
   across the carry; it starts fresh once the new copy cycles through
   `not-yet-triggerable` again in the next milestone's gate run. `carry-forward` is
   idempotent by (project, milestone, text) — re-running it for the same item and
   target milestone returns the copy already carried there rather than duplicating it,
   so a retried call is safe.

4. **Verify the carry.** Re-read the next milestone's `gate_item` rows; confirm each
   carried item is present (`open`/`runnable`) and that **no text duplicates** an item
   already there (guards against a double-carry). The originals must still read
   `deferred` / `pending` under the closing milestone.

> This is the step whose absence stranded 18 deferred M11 items when M11 closed
> (re-homed to M12 by hand on 2026-07-20). Do it before (or independently of) the
> automated wrap playbook run, so the next milestone is fully populated when it goes
> live.

## Step 2 — Notion master-page row + context.md edits

The playbook handles `milestones.wrapped_at` and the auto-launch repoint; **the
Notion master page and `context.md` bookkeeping stay manual**. Update **all** of the
following (they drift independently) — reversible bookkeeping, unconditional, do it
and report it:

| Place | Change | Sanctioned mechanism |
| --- | --- | --- |
| **Notion master page — Project Milestones table** | old → `✅ Done (<date>)`; next → `🔄 Active` | `notion-update-page` `update_content` |
| **Notion master page — "Active Task Board" callout** | phase line + board link → next milestone | `notion-update-page` `update_content` |
| **Notion master page — Project Summary** *(if stale)* | refresh Status/Next lines | `notion-update-page` `update_content` |
| **`config/projects/<dir>/context.md`** | "Active Task Board" line + milestone-history list (old → done, add next as active) | `Edit` |

> ⚠️ **Notion table cells:** match on the **cell's unique text** (e.g. `🔄 Active`), not a
> full pipe row — markdown table rows don't match Notion's serialization. Add a table
> *row* only via a reliable anchor; skip the Key-Decisions-Log row (that log is for
> architectural decisions, not routine completions — the Milestones table records the
> completion).

## Reporting

Report both steps as a table with the concrete result of each (the deferred and
pending items carried forward + their new milestone, the Notion sections updated,
the `context.md` diff). Separate "done" from "already true." Never claim a place was
updated without reading it back.
