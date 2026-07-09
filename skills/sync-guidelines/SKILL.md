---
name: sync-guidelines
description: >-
  Integrate updated universal guideline docs (task-writing.md, procedures.md) from
  the orchestrator repo into the live central config tree — a Claude-led three-way
  merge, never a file overwrite. The repo copy is the upstream guideline source; the
  live copy carries host/project-specific content (the filled Project index, project
  examples) that must be preserved. Use when the user says "sync guidelines", "integrate
  the guideline updates", "pull the procedures/task-writing changes into config", or after
  merging a PR that changed config-template/task-writing.md or config-template/procedures.md.
---

# Sync Guidelines

The universal guideline docs — `task-writing.md` and `procedures.md` — are **not mechanically
deployable**. Two copies exist with different jobs:

- **Upstream source** (`<repo>/config-template/<doc>`): the version-controlled, *portable /
  generic* guideline. Where universal rules are authored and updated.
- **Live integrated copy** (`<config-tree>/<doc>`): what sessions actually read. It carries the
  upstream rules **plus** host/project-specific content — the filled-in **Project index** in
  `procedures.md`, the concrete **project examples** in `task-writing.md`.

A `cp` fails both directions: overwrite clobbers the local content; seed-only never propagates
upstream updates. So deploying an *update* to these docs is an **integration**: take what changed
upstream since the last integration and weave it into the locally-enriched live doc — preserving
local content, resolving conflicts with judgment. This skill drives that, confirm-gated.

> This is the Class-2 counterpart to `deploy-grooming.mjs` (which mechanically copies the
> Class-1 machinery — loaders, hooks, skill definitions — where the repo is the sole source of
> truth). The guideline docs were removed from that script precisely because they are Class-2.

## Step 1 — Load the plan (deterministic)

Run the loader; it resolves the repo (upstream) + config tree (live), reads the per-doc baseline
(the repo commit last integrated), and prints the **upstream delta** for each doc:

```
node ~/.claude/scripts/sync-guidelines-load.mjs
```

(from the projects root, so the config tree + repo resolve; or pass `--config-dir` / `--repo`).

Each doc comes back with a status:

| Status | Meaning | What to do |
| --- | --- | --- |
| `up-to-date` | baseline == HEAD, or no upstream change | nothing |
| `has-upstream-changes` | upstream changed since baseline | integrate the printed **delta** into the live doc |
| `no-baseline` | first integration (no recorded baseline) | **full reconcile**: diff upstream vs live by hand |
| `missing-live` | live copy absent (fresh host) | copy upstream → live, add local content |

**Do not** try to `git apply` the delta — it will not apply cleanly onto the enriched live doc,
and that is expected. The delta is *guidance* ("here is what changed upstream"); you apply the
**intent** to the live doc by hand.

## Step 2 — Integrate, per doc

For each actionable doc:

1. **Read both** the upstream (`config-template/<doc>`) and the live (`<config-tree>/<doc>`) copy
   in full, plus the printed delta.
2. **Identify local content to preserve** — the parts of the live doc that are *not* in upstream
   and are deliberately host/project-specific: the filled **Project index** (procedures.md), the
   concrete **project examples** and task IDs (task-writing.md), any host-specific deploy/debug
   notes. These stay.
3. **Apply the upstream intent** — for each hunk in the delta: a new/changed universal *rule* or
   *section* gets ported into the live doc at the matching location, adapting wording to sit
   beside the local content. A generic upstream *example* does **not** overwrite a richer local
   example covering the same rule — keep the local one; add only genuinely new guidance.
4. **Conflicts → surface, don't guess.** If upstream reworks a section the host has locally
   customized, present both and ask which wins (plain prose — never the AskUserQuestion tool).

## Step 3 — Present the integrated result for sign-off

Show the human, per doc: a concise list of what you pulled in (new sections, changed rules), what
local content you preserved, and any conflicts you resolved. Write the merged doc to the **live**
path only after they confirm. Never touch the upstream `config-template/` source from this skill.

## Step 4 — Record the baseline

Once the live docs are integrated and confirmed:

```
node ~/.claude/scripts/sync-guidelines-load.mjs --record
```

This bumps `<config-tree>/guidelines-baseline.json` to the current repo HEAD, so the next run
diffs only what changes after this integration. Record only the docs you actually integrated
(`--record task-writing.md` for one); default records all.

## Guardrails

- **The live doc is the only write target.** Never edit `config-template/<doc>` here (that is an
  upstream change → normal PR flow).
- **Preserve local content by default.** When unsure whether a live-only passage is deliberate
  local enrichment or stale drift, keep it and flag it — do not silently drop it.
- **One integration = one confirmation.** No auto-write; the human signs off before the live doc
  changes, and before `--record`.
- **Order vs deploy-grooming:** run `deploy-grooming.mjs` for the Class-1 machinery; run this for
  the Class-2 guideline docs. Neither substitutes for the other.
