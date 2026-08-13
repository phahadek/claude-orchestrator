---
name: docs
description: >-
  Run an interactive Docs authoring session for a single 📝 Docs task: load the task,
  read its declared Source domain(s) live over the web, author into its declared Target
  surface (a repo file or a Notion page), and open the never-auto-merge output (a draft
  PR for a repo-file target, or a staged notion.pageEdit intent for a Notion-page target)
  for a human to review and merge/apply. Use when the user says "docs", "docs session",
  "run the docs task", "write the docs for X", or starts an interactive Docs-authoring
  session on a 📝 Docs task. Requires the task to declare a Target surface and Source
  domain(s) in its body (see § Docs task-body convention below) — do not improvise either.
---

# docs — author a single Docs task

Companion to `/groom` (backlog→Ready) and `/design` (locks the spec a Docs task follows):
this skill *executes* one 📝 **Docs** task — an authoring pass against a live external
source, landed as a never-auto-merge output for a human to apply. It is dispatched under
the `docs` session type, whose tool set (`DOCS_ALLOWED_TOOLS`) is the first session profile
in this repo with web egress: `WebFetch`, allowlisted **only** to the task's declared
Source domain(s) — never open `WebSearch`, never an un-allowlisted fetch.

This is the same authoring loop whether a human triggers it interactively (this skill) or
a future autonomous trigger dispatches it — only the trigger differs. The interactive core
built here is what that autonomous wiring will reuse.

## Docs task-body convention

A 📝 Docs task's body must declare, before this skill starts writing anything:

- **Target surface** — where the authored content lands. Either:
  - a **repo path** (e.g. `docs/api/webhooks.md`) — output is a draft PR against that repo, <!-- path-check:ignore -->
    opened by this session (`Bash(gh pr create:*)` / `mcp__github__create_pull_request` —
    see § Output below for why this session, uniquely, carries that capability); or
  - a **Notion page id** — output is a staged `notion.pageEdit` intent (find/replace pairs
    against the page's current body), left for an operator to apply.
- **Source domains** — the domain(s) this task's `WebFetch` allowlist is scoped to (e.g.
  `docs.stripe.com`, `developer.github.com`). This session can reach nothing else over the
  web; it has no `WebSearch` and no fetch to an un-listed domain.

If either is missing or ambiguous, **stop and ask** — do not guess a target surface or
widen the source domains by inference. This is the one place a Docs session's judgment
must defer to what the task explicitly declared, since both are gates the tool set itself
enforces at dispatch time, not something this skill can route around mid-run.

## Flow

1. **Load the task.** Fetch the Docs task by id (the standard task-read surface — same
   mechanism any dispatched session uses to resolve its own task). Read the Target surface
   and Source domains from its body per the convention above. If the task references a
   design task or architecture unit as its spec, read that too — the authored content
   should match what was locked there, not improvise a new shape.
2. **Read the declared source live.** Use `WebFetch` against the declared domain(s) —
   never rely on training-data memory of the source's content, and never fetch outside the
   declared domains even if a link on the page points elsewhere (surface it to the human
   in the PR/staged-intent description instead of following it).
3. **Author into the target surface.**
   - **Repo-file target**: use `Write`/`Edit` in a normal worktree, same as a Code session.
     Keep the diff scoped to the declared Target surface — a Docs task is not a license to
     restructure unrelated docs or code.
   - **Notion-page target**: stage one or more `notion.pageEdit` intents (via the
     `mcp__orchestrator__notion_pageEdit` tool) — each `content_updates` entry is an
     `old_str`/`new_str` find/replace pair against the page's *current* body. Prefer a few
     precise, reviewable pairs over one edit spanning the whole page.
4. **Open the output — never auto-merge.**
   - Repo-file target: open a **draft PR** (see `~/.claude/CLAUDE.md`'s PR Format Standards
     for the body template this session follows, same as a Code session). The PR is gated
     `human_merge_only` — this session must never merge its own PR, and nothing here
     auto-merges a docs PR the way a passing Code-session PR might.
   - Notion-page target: leave the staged `notion.pageEdit` intent(s) for an operator to
     review and apply from the decision inbox — do not attempt to apply them yourself; no
     tool in this session's set can.
5. **Stop.** Report what was authored, where the output landed (PR link, or the staged
   intent ids), and any source content you could not verify (broken link, domain outside
   the allowlist, ambiguous target). A Docs session's job ends at "reviewable output
   opened," not at "merged."

## Why the PR-open exception exists here

Every other planning/dispatched session type is barred from the GitHub `create_pull_request`
verb — PR-opening is normally backend-owned, so a session can't silently open (or worse,
appear to legitimize) writes nobody reviewed. `docs` is a deliberate, narrow exception,
made because a repo-file Docs task has no backend-driven PR-open path the way a Code
session's `<pr-body>` marker does — the session must open its own PR. This does **not**
extend to any other session type, and it does not relax the `human_merge_only` gate: the PR
this session opens is still never auto-merged (see the output-gate dependency this skill's
tool set was built against). See `packages/backend/src/config.ts`'s `ALLOWED_TOOLS` /
`DOCS_ALLOWED_TOOLS` comments for the source-of-truth statement of this precedent.

## What this session cannot do

- No `WebSearch`, ever — only `WebFetch` against the task's declared Source domain(s).
- No fetch outside those declared domains, even mid-task if the source links elsewhere.
- No merging its own PR, no applying its own staged `notion.pageEdit` intents.
- No task-status writes, no `task.*` staging surface beyond what's needed to read its own
  task — a Docs session's job is authored content, not board bookkeeping.

Broader egress (open search, an un-allowlisted fetch) is never in this session's autonomous
base. If a task genuinely needs it, that is a grantable capability via the existing
`session.requestCapability` staging path — parked for an operator to approve, same as any
other capability widening — never something this skill grants itself by improvising around
the allowlist.
