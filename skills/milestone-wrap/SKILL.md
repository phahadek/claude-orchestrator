---
name: milestone-wrap
description: >-
  Close out a completed milestone: confirm all its tasks are terminal and the
  Manual Verification Gate is green, mark the milestone done + the next one
  active across every place that tracks it, advance main to dev, and cut the
  release tag. Use when the user says "wrap up milestone X", "close M11",
  "let's close out the milestone", or "cut the release for milestone X". A
  confirm-gated procedure, never improvised — pauses before the outward-facing
  tag/release. Distinct from /wrap (which closes a SESSION, not a milestone).
---

# Milestone Wrap

Closing a milestone is **orchestrator + Notion + git state spread across several
homes**, run once when a milestone's work is done. This skill is a human-driven,
confirm-gated loop over those homes — it does not improvise steps, and it **pauses
before the one outward-facing, hard-to-reverse action** (the release tag, which
auto-updaters pick up within ~24h).

> **Not `/wrap`.** `/wrap` sweeps a *session* for unpersisted residue. This closes a
> *milestone*. Don't conflate them.

## Doctrine (same spine as /gate and /ops)

- **Verify by reading, act via sanctioned surfaces.** Read the actual state (task
  board, gate readiness, DB, git) before asserting a step is done or needed; make every
  change through the project's sanctioned surface (the `/api/projects` route, the
  device-authed clients, `gh`), **never a raw DB write** and **never a mutation of the
  prod checkout's branches**.
- **Confirm before the irreversible/outward-facing.** Marking done + flipping the active
  milestone is reversible (do it, report it). Advancing `main` is reversible-ish. The
  **release tag + GitHub release is the point of no return** — pause for explicit
  go-ahead before it.
- **Don't hand the work back.** Find the "several places" yourself (they're enumerated
  below); don't ask the operator where they are.

## Step 0 — Resolve the milestone + load project context

Determine the milestone being closed and the next one. `Read
config/projects/<dir>/context.md` for the board IDs, the master Notion page, the
project id-space, and the deploy/release specifics. Project-specific values live there;
this skill is the universal shape.

## Step 1 — All tasks terminal

Query the milestone board (`notion-query.mjs <boardDbId> --env <backend>/.env --json`).
**Terminal = `✅ Done` or `⏭️ Deferred`.** Anything in `🔲 Backlog` / `🗂️ Ready` /
`🔄 In Progress` / `👀 In Review` / `🚫 Blocked` blocks the wrap — resolve or move it
first. Archive/terminalize any leftover scratch/synthetic tasks (e.g. from a gate run).

## Step 2 — Gate green (and seed green)

`node ~/.claude/scripts/gate-state-client.mjs readiness --milestone <M>` → must be
`green`. If blocked, run `/gate` first — do not wrap over a blocked gate. Also check
`seed-state-client.mjs readiness` — the dashboard's composite "Milestone complete"
badge is `gateGreen && seedGreen` (`GateReadinessPanel.tsx`); both must be green.

## Step 3 — Carry deferred gate items forward to the next milestone

**Green is not "all verified."** `readiness` counts `deferred` as resolved
(`RESOLVED_STATES = {pass, deferred}` in `gateService.ts`), so a milestone with
deferred gate items reads **green** and wraps clean — but `deferred` means
*postponed / not-yet-verified*, **not** *resolved*. Left untouched, those items **die
under the closed milestone**: nothing ever surfaces them again. Every deferral was a
promise to verify later — this step keeps it. *(Gate-only: seed's sole resolved state
is `confirmed` — there is no deferred-green seed state, so seed-green already implies no
postponed seeds. Nothing to carry on the seed side.)*

1. **Enumerate the deferred items — `readiness` won't show them** (it lists only
   *blocking* items, and deferred doesn't block). Read them directly; **reads** of the
   live DB are sanctioned (only *writes* are barred):

   ```
   SELECT gi.id, gi.classification, gi.text, s.source_task_id, s.source_task_title
   FROM gate_item gi JOIN gate_item_source s ON s.gate_item_id = gi.id
   WHERE gi.project='<projectId>' AND gi.milestone='<closingM>' AND gi.state='deferred'
   ```

2. **Triage each with the operator.** A deferred item is either **(a)** genuinely
   won't-verify / obsolete → **leave it** (deferred is correct closed-milestone history),
   or **(b)** a real postponement → **carry it forward**. Don't blanket-carry; don't
   blanket-drop.

3. **Re-home the carry set to the *next* milestone — accrete a fresh copy, don't move.**
   There is **no milestone-level re-home verb** (the only `rehomeItemsBySourceTask` is
   task-move-scoped), and raw-DB moves are barred — so accrete-duplicate is the sanctioned
   path, and it is *correct by design*: the original stays `deferred` (closed-milestone
   history) while a fresh `open` copy lives in the next milestone for a **fresh gate run**.
   Group the carry set by `(source_task_id, classification)` — `accrete` takes one
   classification per call and mints one `gate_item` per `items[]` entry, sourced to that
   task (classification, incl. `needs-triage`, is preserved):

   ```
   node ~/.claude/scripts/gate-state-client.mjs accrete \
     '{"project":"<projectId>","taskId":"<source_task_id>","title":"<source_task_title>",
       "milestone":"<nextM>","classification":"<classification>","items":[{"text":"…"}, …]}'
   ```

   The 60s gate reconciler promotes them `open → runnable` within a cycle (the source
   tasks are long-merged and deployed). `<nextM>` is the **display name** (e.g. `M12`),
   never the milestone UUID — same id-space rule as the rest of the gate client.

4. **Verify the carry.** Re-read the next milestone's `gate_item` rows; confirm each
   carried item is present (`open`/`runnable`) and that **no text duplicates** an item
   already there (guards against a double-carry). The originals must still read `deferred`
   under the closing milestone.

> This is the step whose absence stranded 18 deferred M11 items when M11 closed
> (re-homed to M12 by hand on 2026-07-20). Do it **before** Step 4's active-milestone
> flip so the next milestone is fully populated when it goes live.

## Step 4 + 5 — Mark this milestone done, the next one active

These share **several places** — update **all** of them (they drift independently):

| Place | Change | Sanctioned mechanism |
| --- | --- | --- |
| **DB `projects.auto_launch_milestone_id`** — the *functional* active-milestone pointer that drives auto-dispatch | old milestone id → next milestone id | `PATCH /api/projects/<projectId>` `{"autoLaunchMilestoneId":"<next-uuid>"}` with `Authorization: Bearer $ORCHESTRATOR_DEVICE_TOKEN`. **Never raw-UPDATE the DB.** Verify by reading the row back. |
| **DB `milestones.wrapped_at`** — the audited Done marker that scopes convergence/the milestone list to `wrapped_at IS NULL` (active + in-planning) | null → wrap timestamp | `POST /api/milestones/<closingM-uuid>/wrapped` with `Authorization: Bearer $ORCHESTRATOR_DEVICE_TOKEN` (idempotent — a second call 409s, which is fine to ignore). **Never raw-UPDATE the DB.** Verify by reading the closing milestone back and confirming `wrappedAt` is non-null. |
| **Notion master page — Project Milestones table** | old → `✅ Done (<date>)`; next → `🔄 Active` | `notion-update-page` `update_content` |
| **Notion master page — "Active Task Board" callout** | phase line + board link → next milestone | `notion-update-page` `update_content` |
| **Notion master page — Project Summary** *(if stale)* | refresh Status/Next lines | `notion-update-page` `update_content` |
| **`config/projects/<dir>/context.md`** | "Active Task Board" line + milestone-history list (old → done, add next as active) | `Edit` |

> ⚠️ **The active-milestone flip is LIVE.** On an auto-launch project, pointing it at the
> next milestone means that milestone's `🗂️ Ready` **Code** tasks begin auto-dispatching.
> **Check the next board for `Ready`+`💻 Code` tasks first** — 0 is safe; if there are
> some, confirm the operator wants them to launch now.
>
> ⚠️ **Notion table cells:** match on the **cell's unique text** (e.g. `🔄 Active`), not a
> full pipe row — markdown table rows don't match Notion's serialization. Add a table
> *row* only via a reliable anchor; skip the Key-Decisions-Log row (that log is for
> architectural decisions, not routine completions — the Milestones table records the
> completion).

## Step 6 + 7 — Advance main, cut the release

**Read the project's release process first** (its `RELEASE.md` / `context.md` deploy
section) — the exact commands are project-specific. Two hard constraints hold for
claude-orchestrator (and likely any managed repo):

- **Never commit to `dev`/`main` directly** → land the version bump via a feature branch
  + PR.
- **Never switch branches / commit on the prod checkout** (it's the base repo other
  worktrees branch from) → do all git work in a **throwaway clone** (`/tmp/...`), never
  in `/srv/.../<repo>`.

The claude-orchestrator flow (v1.7.0/v1.8.0 convention), driven entirely via `gh`:

1. **Bump on dev.** Clone dev to `/tmp`; `git checkout -b release/vX.Y.Z`; `node
   scripts/release.mjs X.Y.Z` (bumps the 3 `package.json`s + commits); push; open PR →
   `dev`; **squash-merge** (the repo allows squash only).
2. **Advance main.** In the clone: `git checkout -B main origin/main`; `git merge --no-ff
   origin/dev -m "chore(release): merge dev into main for <M> close (vX.Y.Z)"`; push
   `main` **directly** (main has no branch protection; PRs disallow merge commits, so the
   release merge is a direct push). The result is a **2-parent merge commit** whose tree
   is identical to dev — verify both before pushing.
3. **⏸ PAUSE — get explicit go-ahead** (outward-facing; auto-updaters see it in ~24h).
4. **Tag + release.** Tag `vX.Y.Z` on the **merge commit** (that's where prior tags sit);
   push the tag; `gh release create vX.Y.Z` with M-summary notes. Clean up the clone.

### Gotchas that bit real runs (2026-07-20, M11 → v1.8.0)

- **GitHub email privacy** rejects a push whose commit author is a plain email
  (`push declined due to email privacy restrictions`). Set the account **noreply**
  (`<id>+<login>@users.noreply.github.com`, get `<id>` from `gh api user`) and
  `git commit --amend --reset-author` before pushing.
- **Squash-only repo** — `--merge` fails with "Merge commits are not allowed"; use
  `--squash` for the bump PR. The dev→main merge commit is a **direct push**, not a PR.
- **`gh release create --target <sha>` fails** ("target_commitish is invalid") when the
  tag already exists — omit `--target`; the release attaches to the existing tag.
- **Shallow clone** can't `--no-ff` merge (no merge base) — `git fetch --unshallow` and
  fetch `main:refs/remotes/origin/main` before checking out main.

## Reporting

Report the seven steps as a table with the concrete result of each (the deferred items
carried forward + their new milestone, the pushed `sha` range, the tag's commit, the
verified `auto_launch_milestone_id` and `wrapped_at`). Separate "done" from "already
true." Never claim a place was updated without reading it back.
