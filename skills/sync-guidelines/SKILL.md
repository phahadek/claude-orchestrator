---
name: sync-guidelines
description: >-
  Re-vendor EVERYTHING this repo deploys into a live tree — the universal guideline docs
  (task-writing.md, procedures.md), the /groom /design /ops /deploy /wrap /sync-guidelines /gate
  skill directories, the sanctioned route-client scripts, and the config-tree hook — via a
  Claude-led three-way merge, never a file overwrite. The repo copy is the upstream source; the
  live copy may carry local edits (a vendored skill refined in place, an emergency script hotfix)
  that must be preserved. Use when the user says "sync guidelines", "re-vendor the skills", "deploy
  the grooming skills", "integrate the guideline updates", "pull the procedures/task-writing
  changes into config", or after merging a PR that changed config-template/, skills/**, scripts/*.mjs,
  or packages/backend/scripts/*.mjs.
---

# Sync Guidelines

Every artifact this repo vendors into a live tree — the guideline docs, the grooming/design/ops
skill directories, and the sanctioned route-client scripts — is **not mechanically deployable**.
Two copies exist with different jobs:

- **Upstream source** (`<repo>/config-template/<doc>`, `<repo>/skills/<name>`,
  `<repo>/scripts/<name>.mjs`, `<repo>/packages/backend/scripts/<name>.mjs`): the
  version-controlled source of truth. Where changes are authored and reviewed.
- **Live copy** (`<config-tree>/<doc>`, `~/.claude/skills/<name>`, `~/.claude/scripts/<name>.mjs`):
  what sessions actually read/run. It may carry content the upstream doesn't have — the guideline
  docs' filled-in **Project index** and concrete **project examples**, or a skill instruction that
  was refined directly on a live host before the change made it back into the repo.

A `cp` fails both directions: overwrite clobbers local content; seed-only never propagates
upstream updates. **There is no re-vendor path in this repo that force-overwrites a live copy.**
(A previous mechanism, `scripts/deploy-grooming.mjs`, did exactly that — a blind
`cpSync(..., { force: true })` — and it silently destroyed vendored-local content in the `/ops`
skill with no backup and no way to detect it after the fact. It has been removed outright.)
Deploying an update to any of these is an **integration**: take what changed upstream since the
last integration and weave it into the live copy — preserving local content, resolving conflicts
with judgment. This skill drives that, confirm-gated, for every vendored artifact.

## Step 1 — Load the plan (deterministic)

Run the loader; it resolves the repo (upstream) + the live targets (central config tree for
guideline docs and the hook; `~/.claude/{skills,scripts}` for skills and route-client scripts),
reads the per-item baseline (the repo commit last integrated), and prints the **upstream delta**
for each item:

```
node ~/.claude/scripts/sync-guidelines-load.mjs
```

(from the projects root, so the config tree + repo resolve; or pass `--config-dir` / `--claude-home`
/ `--repo`).

Each item comes back with a status:

| Status | Meaning | What to do |
| --- | --- | --- |
| `up-to-date` | baseline == HEAD, or no upstream change | nothing |
| `has-upstream-changes` | upstream changed since baseline | integrate the printed **delta** into the live copy |
| `no-baseline` | first integration (no recorded baseline) | **full reconcile**: diff upstream vs live by hand |
| `missing-live` | live copy absent (fresh host) | copy upstream → live verbatim (nothing local to lose) |

**Do not** try to `git apply` the delta — it will not apply cleanly onto a live copy carrying
local content, and that is expected. The delta is *guidance* ("here is what changed upstream");
you apply the **intent** to the live copy by hand.

## Step 2 — Integrate, per item

For each actionable item:

1. **Read both** the upstream copy and the live copy in full (every file, for a skill directory
   or a multi-file script set), plus the printed delta.
2. **Identify local content to preserve** — anything in the live copy that is *not* in upstream
   and looks deliberate: a guideline doc's filled **Project index** or concrete **project
   examples**; a skill instruction, example, or nuance a host refined directly (e.g. "lead with a
   recommendation, not a menu") that never made it into the repo copy; a route-client script
   carrying an emergency hotfix. These stay.
3. **Apply the upstream intent** — for each hunk in the delta: a new/changed rule, section, or
   code path gets ported into the live copy at the matching location, adapting wording/code to
   sit beside the local content. A generic upstream change does **not** overwrite richer local
   content covering the same ground — keep the local version; add only genuinely new guidance or
   behavior.
4. **Conflicts → surface, don't guess.** If upstream reworks something the host has locally
   customized, present both and ask which wins (plain prose — never the AskUserQuestion tool).
5. For a **skill directory**, reconcile file-by-file: a file present only live (not in the repo's
   `skills/<name>/`) is local content unless the delta shows it was deleted upstream deliberately
   — ask if unsure, never delete silently.

## Step 3 — Present the integrated result for sign-off

Show the human, per item: a concise list of what you pulled in (new sections, changed rules or
code), what local content you preserved, and any conflicts you resolved. Write the merged copy to
the **live** path only after they confirm. Never touch the upstream repo source (`config-template/`,
`skills/`, `scripts/`, `packages/backend/scripts/`) from this skill — that's a normal PR.

## Step 4 — Record the baseline

Once the live copies are integrated and confirmed:

```
node ~/.claude/scripts/sync-guidelines-load.mjs --record
```

This bumps `<config-tree>/guidelines-baseline.json` to the current repo HEAD, so the next run
diffs only what changes after this integration. Record only the items you actually integrated
(`--record skill:ops script:ops-client.mjs` for specific ones); default records all.

## Guardrails

- **The live copy is the only write target.** Never edit the repo's upstream sources here (that
  is a repo change → normal PR flow).
- **Preserve local content by default.** When unsure whether a live-only passage is deliberate
  local enrichment or stale drift, keep it and flag it — do not silently drop it.
- **Never force-overwrite.** No step in this skill copies a live path with `force: true` (or
  equivalent) when the live path already exists and differs from upstream — every change to an
  existing live copy goes through the read-both, integrate, confirm flow above.
- **One integration = one confirmation.** No auto-write; the human signs off before a live copy
  changes, and before `--record`.
