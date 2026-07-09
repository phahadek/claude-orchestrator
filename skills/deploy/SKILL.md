---
name: deploy
description: >-
  Deploy a managed project to production, executed strictly from that project's
  structured deploy playbook — confirm-gated, never improvised. Use when the user
  says "deploy", "deploy <project>", "ship <project> to prod", "run the deploy",
  or "push <project> live". Reads the project's context.md + the deploy playbook it
  points to (e.g. a repo README "Deploy" section), presents the full ordered plan,
  then runs it one step at a time, pausing before each production-mutating step.
---

# Deploy

Run a project's **production deploy** by executing its documented, ordered playbook —
confirm-gated and complete. The whole point of this skill is that **nothing important gets
skipped and nothing gets improvised**: the playbook is authoritative; if reality diverges
from it, you stop and ask rather than guess.

> Deploy touches production. Expect `sudo` / `systemctl` steps to raise approval prompts —
> that is correct and desired here (a human is present). Follow § Shell hygiene in
> `procedures.md`: one command per Bash call, `git -C <path>` / `sudo -u <user> …`, never
> `cd <path> && …`.

---

## Step 0 — Identify the project and load its playbook

1. Determine the target project (from the command argument, else ask). `Read
   config/projects/<dir>/context.md`.
2. Locate the **authoritative, ordered deploy playbook**, in this order:
   - the `## Deployment` section of `context.md` (structured per the playbook contract in
     `procedures.md` → *Deployment — the `/deploy` playbook contract*), and
   - the repo document it points to for exact commands (e.g. polimarket-analyser →
     `README.md` § *Deploy a merged `dev`* + *Gotchas*). Read it in full.
3. **If the playbook is missing or an unauthored stub, do not deploy yet:**
   - **No deploy section at all** → STOP. Tell the human the project has no deploy playbook and
     do not improvise one. Point them at the contract in `procedures.md`.
   - **A stub / unauthored placeholder** (marked 🚧, or its parts are `TODO` placeholders) →
     switch to **author-first mode**: draft the playbook to the contract — from the repo's
     build/run docs, host runbooks, and `.claude-orchestrator.yml` — present it for human
     sign-off, and only run the deploy once it is authored and approved. **Never deploy against
     stub placeholders.**

## Step 1 — Preconditions gate

Read every precondition from the playbook and check it: change merged to `dev` + CI green,
clean tree, correct host, correct **runtime user**, required access/keys present, the exact
`<sha>` being deployed. Report the checklist with pass/fail. **If any precondition fails,
stop and report** — do not proceed.

## Step 2 — Present the full plan first

Before running anything, enumerate the **entire ordered step list** to the human: for each
step, the exact command, what it does, and whether it is **conditional** (e.g. "only if the
frontend changed"). This up-front plan is the "nothing gets skipped" checkpoint — the human
sees and okays the whole sequence.

**Companion-deploy check.** If the playbook declares **companion deploys**, compute the diff
from the **currently-deployed SHA** (the prod checkout's `VERSION` / current `/opt` HEAD,
*before* the source-delivery step) to the target `<sha>` — `git -C <checkout> diff --name-only
<deployed>..<sha>`. For any companion whose declared path(s) appear in that diff, **flag the
operator up front** that that component (e.g. a sidecar on another host) likely needs its own
separate deploy. This is advisory only: never deploy or restart the companion yourself, and
don't check its live status. Restate any such flag in the Step 6 report.

## Step 3 — Execute, confirm-gated, in order

Run steps strictly in playbook order, one at a time:

- **Read-only / preview steps** (e.g. `--dry-run`) may run without pausing; always show output.
- **Before every production-mutating step:** echo the exact command and its effect, and get
  explicit confirmation. Never batch multiple mutating steps behind one confirmation.
- **Never skip and never reorder.** If a step is conditional and its condition is not met,
  say so explicitly and move on — don't silently drop it.
- **Honor every hazard** the playbook lists (e.g. run as the runtime user, never `uv` as root
  against `/opt`).
- If any step's real output diverges from what the playbook expects, **stop and ask** — do
  not adapt on the fly.

## Step 4 — Verify

Run the playbook's verification checks (health endpoint, unit/service state, deploy-health).
Report results. **If verification fails, surface it — do not declare success.**

## Step 5 — On failure

If a step fails: stop, report exactly what failed with its output, and surface the playbook's
**rollback / failure-handling** guidance — including any "do NOT roll back, do X instead"
cases (e.g. a post-migration GUC crash-loop that needs a pool recycle, not a rollback). Do
not auto-rollback or improvise a fix without confirmation.

## Step 6 — Report

Summarize: what was deployed (`<sha>`), which steps ran vs. were conditionally skipped,
verification results, and anything left for the human to watch.

---

## Constraints

- **The playbook is authoritative.** Never improvise, reorder, or skip steps. Divergence →
  stop and ask.
- **Confirm before every prod-mutating action.** Reads/previews are free; writes are gated.
- Deploy runs the project's **own documented deploy entrypoint** — that is in-scope. It is not
  a licence to hand-edit any other session's git/worktree/PR (see `procedures.md` § Hard rule).
