# The live-health snapshot — loader output contract

`investigate-load.mjs` is the deterministic Step-2 loader for `/investigate`. It opens the
orchestrator DB **read-only** (`{ readonly: true }` against the `--db` path — see the option
table below) and emits one snapshot of *live operational reality*,
so the investigation starts grounded in what is actually deployed and failing — never in the
checkout HEAD or from memory. It can never mutate; it needs no device token; the DB half needs
no network.

## Invocation

```bash
node ~/.claude/scripts/investigate-load.mjs --project claude-dashboard
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--project <id>` | `claude-dashboard` | Orchestrator **registry id** — NOT the config-dir `claude-orchestrator`. |
| `--db <path>` | `$ORCHESTRATOR_DB_PATH` or `/srv/orchestrator/data/dashboard.db` | The SQLite DB, opened read-only. |
| `--env <path>` | `<projectDir>/packages/backend/.env` | `.env` holding `NOTION_API_KEY` for the board fetch. |
| `--no-board` | (board on) | DB snapshot only; skip the Notion board fetch. |
| `--hours <n>` | `48` | `recentPlanningSessions` look-back window. |
| `--no-verify-prs` | (verify on) | Skip GitHub verification of needs-attention PRs (each degrades to `verification:'unverified'` + its exact `gh -R <repo>` command). |
| `--limit <n>` | `8` | Per-section row cap (audit uses 2×). |
| `--json` | (human report) | Emit raw snapshot JSON only. |

Default output is a human-readable report **plus** a trailing `--- SNAPSHOT JSON ---` block
carrying the full object (parse that if you want the structured form).

## The contract (JSON shape)

```
{
  generatedAt, db:{ path, readonly:true },
  project:{ id, name, projectDir },              // registry id, name, absolute checkout path
  deployed:{ sha, shortSha, recordedAt },        // project_deployed_sha — THE LIVE SHA
  activeMilestone:{ id, name, shortId, boardId }, // via projects.auto_launch_milestone_id;
                                                  //   boardId = milestones.source_id (Notion db id)
  deployHint,                                     // computed "deployed ≠ HEAD ≠ attempted" reminder
  health:{
    erroredSessions:[ { sessionId, taskId, taskIdForms:{raw,bare,notion}, taskName, sessionType,
                        status, endedAt, worktreePath, prUrl, lastErrorDetail, promptFile,
                        preAssemblyFailure } ],
    recentPlanningSessions:[ { sessionId, taskId, taskIdForms, taskName, sessionType, status,
                        startedAt, endedAt, worktreePath, pauseReason:{…}, lastErrorDetail,
                        grantedCapabilities, promptFile } ],   // NON-DONE groom/design/ops, last --hours
    recentDeploys:[ { runId, targetSha, shortSha, currentStep, status, completed,
                      startedAt, completedAt, lastEvent:{ step, eventType, disposition, detail, at } } ],
    needsAttentionPRs:[ { prNumber, prUrl, repo, state, mergeState, pauseReason:{…}, headBranch,
                          sessionId, taskId, taskIdForms, updatedAt,
                          verifyCommand, github:{state,mergedAt,closedAt}|null,
                          verification:'verified'|'unverified', stale } ],
    recentAuditEvents:[ { ts, eventType, actorType, taskId, taskIdForms, payloadSummary } ]
  },
  board:{ boardId, source:'notion-query'|'unavailable'|'skipped',
          notDone:[ { id, idForms:{raw,bare,notion}, title, status, type, priority, dependsOn, notionUrl } ],
          command, error }
}
```

## How to read each section

- **`deployed` + `deployHint` — read this first.** `deployed.sha` is the **live truth**
  (`project_deployed_sha`), distinct from the checkout HEAD *and* from the most-recent
  `deploy_run` target. `deployHint` is computed: if the latest `deploy_run` did **not**
  succeed and started *after* the recorded deploy, it warns the live SHA is still the older
  one and the checkout may be ahead of what's running. **Re-verify current deployed state
  before framing anything as still-broken** — fixes land fast on this box.
- **`erroredSessions`** — recent `sessions.status='error'` for the project, newest first. Each
  carries its **`promptFile`** path (`<checkout>/.claude/session-prompts/<id>.md`, existence-
  checked) — `Read` it to see verbatim what the session was told; and `lastErrorDetail`
  (truncated — read the full row for the whole message). `taskName` is a free-text label OR a
  bare task id depending on session type. Reconstruct the timeline from `session_events`.
  **`preAssemblyFailure: true`** marks the pre-assembly fail-loud class — the session died
  *before* its prompt was assembled, so **`promptFile` is null and no file will ever exist**.
  Don't chase the missing file: the diagnostic is `lastErrorDetail` (`… no
  injectedProcedureContent — refusing to fall back …`) plus `journalctl -u orchestrator.service
  | grep "failed to assemble planning procedure"` (the launcher logs the real `<err>` there).
- **`recentPlanningSessions` — the highest-yield block for the current bug class.** Recent
  **non-Done** `groom`/`design`/`ops` sessions (any status: `idle`/`killed`/`error`), within the
  `--hours` window (default 48). The point: a planning session that bungled its task does **not**
  error — it parks **`idle`** (or is `killed`) and looks fine on the dashboard, while having
  groomed/designed/opsed the *wrong* thing. Those never show in `erroredSessions`. Each carries its
  `promptFile` (what it was told) and `taskIdForms` — `Read` the prompt file **and** reconstruct its
  `session_events` transcript to see what it actually did. This is where most dispatched-session
  findings come from.
- **`recentDeploys`** — `deploy_run` attempts, newest first. `completed` is true only for
  `status='succeeded'`; anything else (`failed`/`running`) is flagged and did **not** advance
  the live SHA. `lastEvent.detail` is the failing step's message — the first thread for a
  deploy-failure investigation.
- **`needsAttentionPRs`** — PRs that are `state='open'` OR paused (`pause_reason` set) and not
  terminal. `pauseReason` is parsed to an object whether the row stored JSON
  (`{reason, source, severity, retry_strategy, detail}`) or a bare enum string
  (`{reason: 'auto_merge_failed'}`). **`state` is the orchestrator's *belief*, not GitHub truth** —
  a PR merged/closed on GitHub can still read `state='open'` here. So each row is **verified against
  GitHub** (unless `--no-verify-prs`): `github:{state,mergedAt,closedAt}` is the live truth,
  `verification` is `verified`/`unverified`, and **`stale: true`** means GitHub says merged/closed —
  it is **NOT a live symptom; don't chase it**. PR numbers are **per-repo** and this table mixes
  repos, so each row carries its own `repo` and a `verifyCommand` scoped `-R <repo>` — verify/act
  with *that*, never a bare number. These are **read-only** — never touch the branch/PR.
- **`recentAuditEvents`** — a curated incident-shaped slice of `audit_log`
  (`session_errored`, `stalled_pr_reconcile_attempt`, `task_orphan_*`, `pipeline_stage_failed`,
  `process_boot`, …), newest first, with a short `payloadSummary`. Correlate `process_boot` +
  deploy timing to place a failure relative to a restart. `taskId` is **`notion:`-prefixed**
  (`taskIdForms` carries the bare + notion forms).
- **id forms — carried everywhere.** Every task id in the snapshot ships pre-normalized:
  `taskIdForms:{ raw, bare, notion }` on session/PR/audit rows, `idForms` on board rows. DB rows use
  `notion:<uuid>`; board rows use the bare uuid — join/correlate on the **full** id in the shape the
  target surface expects, never a truncated prefix.
- **`board`** — the authoritative **non-Done** active-milestone board, fetched via
  `notion-query.mjs` (full pagination, never the 25-capped MCP search). This is the **dedupe +
  placement** surface: before filing, check whether the finding is already owned here (match on
  the **full** id — these ids share long prefixes). If `source` is `unavailable`, `command`
  holds the exact `notion-query.mjs` invocation to run by hand (usually a missing
  `NOTION_API_KEY` — pass `--env`).

## Guarantees & degradation

- **Read-only, always.** The DB handle is `{ readonly: true, fileMustExist: true }`; the script
  issues no writes anywhere. Safe against live prod.
- **The DB half never needs the network or a key.** Only the board fetch shells out (to
  `notion-query.mjs`); if the key/script is absent it degrades to `board.source:'unavailable'`
  + the command to run — it never throws the whole snapshot away.
- **`better-sqlite3` resolution.** The loader `require`s the driver by absolute path
  (runtime `node_modules` first), so it works vendored to `~/.claude/scripts` with no local
  `node_modules`. Override with `$ORCHESTRATOR_BETTER_SQLITE3` if the runtime moves.
