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
`Read-Only` → `Opportunistic` → `Prod-Mutating` — untriaged items surface
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
2. Perform the check the item describes:
   - **Read-Only / Opportunistic** — mechanical or low-risk checks you can
     run and judge directly (read code, hit a read endpoint, inspect
     output).
   - **Prod-Mutating** — do **not** self-grant a pass. These are
     non-mechanical: surface the exact action to the human, get their
     explicit go-ahead before performing anything that mutates production,
     and never mark one `pass` without a human present for it.
   - **needs-triage** — classification hasn't been resolved yet for this
     item. Read `item.text` and judge which tier it belongs to (mechanical
     read-only check → `Read-Only`; on-demand/low-risk → `Opportunistic`;
     anything that mutates production → `Prod-Mutating`). When you're
     confident, reclassify before dispositioning:

     ```bash
     node ~/.claude/scripts/gate-state-client.mjs reclassify <gateItemId> <classification> [operator]
     ```

     `classification` must be one of `Read-Only`, `Prod-Mutating`,
     `Opportunistic` — the server rejects anything else, including
     `needs-triage` itself. Once reclassified, the item is picked up by its
     new tier on the next `next` pull (and by the continuous reconciler's
     auto-run path for `Read-Only`/`Prod-Mutating`). If you're genuinely
     unsure which tier fits, don't guess — flag it to the human instead of
     reclassifying blind.
3. Record the attempt as an event — this is what makes the log durable, do
   this for every attempt, not just resolving ones:

   ```bash
   node ~/.claude/scripts/gate-state-client.mjs event <gateItemId> \
     '{"disposition":"pass","evidence":"<what you observed>"}'
   ```

   `disposition` is one of `pass`, `fail`, `deferred` (or another
   project-specific value the item calls for — the server does not enforce
   an enum, but the readiness rollup only treats `pass` and `deferred` as
   resolved). Include `evidence` (freeform — text, a link, a transcript
   excerpt) and, when relevant, `filedFollowon` (a task id if a fix got
   filed instead of fixed in place) and `deploySha`.

   **Disposition semantics — `pass` vs `deferred` (get this right):**

   - **`pass`** — the behavior is verified. Either you observed it directly (ran
     the check, read the record *by value*), **or** it is already validated by a
     ✅ Done 🧪 Testing task or a sibling gate item — **covered-elsewhere**.
     Covered-elsewhere is a **`pass`, not a deferral**: the behavior is done, just
     done by another task. Record `pass` with `evidence` citing the covering task,
     e.g. `{"disposition":"pass","evidence":"covered-elsewhere: <taskId> — …"}`.
   - **`deferred` is rare.** Reserved for a behavior genuinely **too rare to have
     hit the record _and_ too hard or unsafe to run/stage**, that will be executed
     and verified in a **later milestone**. It is **never** "I couldn't verify it
     from history." Deferral is not a dumping ground for un-observed items — used
     that way it manufactures false-green readiness.
   - **Run-don't-defer.** If history can't show the behavior, the first move is to
     make the item **runnable and observe it live** — that is what the runnable
     tiers exist for (`Read-Only` directly; `Prod-Mutating` with consent) — not to
     reach for `deferred`. Staging the observation is the fallback; deferral is the
     last resort, not the first.

   For a `Read-Only` / `Opportunistic` item this resolves the item directly.
   For a `Prod-Mutating` item, a `pass` event parks the item at
   `pending-approval` — it does **not** resolve yet.

4. **Prod-Mutating consent step** — after a `Prod-Mutating` item reaches
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
