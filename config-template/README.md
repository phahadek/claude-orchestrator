# config-template — central config tree bootstrap

Source-of-truth copies of the **central config tree** pieces the orchestrator needs for
human-driven **Remote Control** sessions. The live tree lives **inside the projects root**,
beside the managed repos (dev: `~/IdeaProjects/config/`; prod: `/srv/orchestrator/projects/config/`);
this directory is where those pieces are version-controlled, and `scripts/deploy-grooming.mjs`
copies them into the live tree.

## Contents

| File                        | Deploys to                           | Behaviour                                                                                                   |
| --------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `hooks/load-procedures.mjs` | `<config>/hooks/load-procedures.mjs` | **Overwritten** every deploy (pure mechanism).                                                              |
| `procedures.md`             | `<config>/procedures.md`             | **Seed-only** — copied only if absent, never clobbered (it's deployment-edited; fill in the Project index). |

`<config>` is resolved by the deploy script: `$ORCHESTRATOR_CONFIG_DIR`, else a `config/`
dir inside the projects root, beside each repo (`<repo>/../config` on both hosts now that
config lives inside the projects root; `<repo>/../../config` is probed only as a legacy
fallback), else it defaults to `<repo>/../config` and creates it.

## What the hook does

`load-procedures.mjs` is a **SessionStart** hook. It self-gates on cwd: it injects a short
pointer telling the session to `Read procedures.md` **only** when cwd is the projects root
(the Remote Control server). Orchestrator-launched worktree sessions (cwd under
`<repo>/.claude/worktrees/`) get nothing, so the rulebook never leaks into automated runs.

## Fresh-machine setup

1. `node scripts/deploy-grooming.mjs` — installs the grooming/design skills + scripts into
   `~/.claude`, and seeds the config tree with this hook + a `procedures.md` to fill in.
2. Register the **SessionStart** hook in `~/.claude/settings.json` (one-time, manual — the
   deploy script never edits user-global settings). See the orchestrator README
   § "Grooming & design skills".
3. Edit `<config>/procedures.md` → fill in the **Project index**, and add a
   `config/projects/<dir>/context.md` per managed repo.
4. Launch the durable server from the projects root:
   `claude --permission-mode acceptEdits remote-control`.

> Because config lives **inside** the projects root on every host, the projects root is
> always config's parent — **no `ORCHESTRATOR_PROJECTS_ROOT` override is needed** (the prod
> systemd unit sets none). Both env vars remain optional escape hatches for the unusual case
> of config deployed **outside** the projects root: `ORCHESTRATOR_CONFIG_DIR` (for the deploy
> + loaders) and `ORCHESTRATOR_PROJECTS_ROOT` (for the hook's cwd gate).
