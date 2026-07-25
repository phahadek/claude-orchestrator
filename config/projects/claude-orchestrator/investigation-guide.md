# This Project's Operational Record — Dispatched-Session Investigation Guide

Read this when a task asks you to verify something happened, diagnose why it
didn't, or confirm a prior turn's effect by value rather than by memory. It is
injected automatically into `ops` (including gate-verify) and `design`
sessions for this project — see `renderProjectRecordAccess` in
`packages/backend/src/planning/procedureAssembler.ts`. It is never injected
into `groom` sessions.

This is the **sandbox-reachable** half of investigating this orchestrator's
own runtime. The host-operator half — the same surface, reached with real
filesystem/DB access from outside any session sandbox — lives in this
project's `context.md` § "Inspecting live state". Read that section's
counterpart here if you ever operate this project directly on the host; read
this file if you are a dispatched session investigating from inside your
sandbox. The two must stay in sync — if you edit one, check the other.

## 1. The operational surface

Four tables carry the load-bearing operational record for a session's
lifecycle and this orchestrator's own audit trail:

- **`sessions`** — one row per session: `session_id`, `task_id`/`task_url`,
  `status`, `started_at`/`ended_at`, `pr_url`, `worktree_path`, `project_id`,
  `session_type` (`standard` / `ops` / `design` / `groom` / ...), token
  counters, `model`, `review_result`. The canonical answer to "did this
  session run, and what state is it in now."
- **`session_events`** — the turn-by-turn transcript: `session_id`,
  `event_type`, `payload` (JSON), `timestamp`, keyed and indexed by
  `(session_id, id)`. The canonical answer to "what did this session actually
  do/say on a given turn."
- **`audit_log`** — the orchestrator's own event log across every actor
  (`human` / `session` / `system`): `ts`, `event_type`, `actor_type`,
  `actor_id`, `project_id`, `task_id`, `payload`. Filtered by `actor_id` it
  answers "what did this session cause the orchestrator to do" (grants,
  dispositions, status transitions, etc.) — distinct from `session_events`,
  which is the session's own transcript.
- **`pull_requests`** — one row per tracked PR: `pr_number`/`pr_url`,
  `task_id`, `session_id`, `state`, `review_result`, `mergeable`/
  `merge_state`, `pause_reason`, `failing_checks`, CI-remediation and
  session-initiated-close markers. The canonical answer to "what actually
  happened to the PR this session opened."

These four are the ones worth knowing by name; the schema has others
(`permission_events`, `scheduler_audit`, `session_feedback_inbox`, ...) that
matter less often for investigation. Don't restate the generic
`session.requestCapability` / grant mechanics here — see "Capabilities" in
your injected prompt (`renderOpsCapabilities`) for those; this section is
just what the record *is*.

## 2. Sandbox-reachable access method

From inside a dispatched session's sandbox you cannot open the database file
directly and cannot reach the backend's device-authed API — there is no
`Bash(sqlite3 ...)`, no raw DB path, and no `node -e` against the running
orchestrator. The one sanctioned path is a **single target session's own
record**, read through the shipped client:

```
node ~/.claude/scripts/read-session-record.mjs <targetSessionId>
```

This calls `GET /api/session-record-reads/:targetSessionId`
(`packages/backend/src/routes/sessionRecordRead.ts`), authenticated by your
own per-session stage credential (`ORCHESTRATOR_STAGE_TOKEN`), and returns
one JSON object for that target session:

- `session` — its `sessions` row
- `events` — its `session_events`, user-facing events only
- `auditLog` — its `audit_log` rows (filtered by `actor_id` = the target
  session id)

`pull_requests` is not part of this response — reading a session's PR record
today means reading its `session`/`events` for the `pr_url` it recorded, or
(for host-side investigation) the host-operator path in `context.md`. Broader
reads — another session's record, a `pull_requests` row directly, or any
table beyond own-record — are not sandbox-reachable today; that is tracked
as future work by the M13 read-only-MCP-surface design, not something to
work around here.

A 403 with `code: "capability_not_granted"` means the grant below is still
outstanding (or was never requested) — stage the request and wait to be
re-dispatched rather than retrying the read.

## 3. Grant / credential — request, then re-dispatch

The read above only succeeds once an operator has approved a capability
named for your specific target session. Stage it the same way you'd stage
any other capability request (see "Capabilities" in your injected prompt):

```
mcp__orchestrator__session_requestCapability
{"payload":{
  "capability":"read:session-record:<targetSessionId>",
  "plan":"<what this session will do with the record>",
  "evidence":"<why this session needs it>"
}}
```

An operator reviews it; on approval the capability is durably granted to
your session alone and you are re-dispatched with the read now unlocked — run
the `read-session-record.mjs` command from Part 2 on your next turn. On
pushback or rejection you resume with the operator's feedback instead, and
should not retry the same read. There is no write form of this capability —
`read:session-record:<targetSessionId>` can only ever be used to read.

## Keeping this in sync

If the operational surface changes (a table renamed, a new load-bearing
table, the read endpoint's response shape changes), update this file and
this project's `context.md` § "Inspecting live state" together — they
describe the same surface for two different audiences and are expected to
agree on what the tables are and what they mean, even though the access
method differs (sandbox capability grant here, direct host access there).
