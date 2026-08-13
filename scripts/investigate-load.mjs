#!/usr/bin/env node
/**
 * investigate-load.mjs — Deterministic Step-1 loader for the /investigate skill.
 *
 * WHAT THIS IS. A **read-only live-health snapshot** of the orchestrator, pulled up front
 * so an ad-hoc, operator-pointed investigation starts *grounded in operational reality* —
 * not in the checkout's HEAD or in memory. It is the /investigate analogue of
 * `ops-client.mjs context` / `groom-context-client.mjs` / `design-load.mjs`: the sanctioned
 * deterministic load that must precede any judgment step (see
 * `skills/_shared/reference/hard-rules.md` — "Deterministic load, not hand-fetch").
 *
 * WHY A STANDALONE READ-ONLY SCRIPT (not a backend route). The whole discipline of
 * /investigate is **hard read-only over other sessions' git/PR/worktree/DB state**
 * (`config/procedures.md` § Hard rule). The project's own `context.md` § Inspecting live
 * state sanctions exactly one inspection method — a `better-sqlite3` handle opened
 * `{ readonly: true }` against `/srv/orchestrator/data/dashboard.db`. This loader *is* that
 * method, packaged: it can never mutate, needs no device token, no network for the DB half,
 * and cannot fail a whole investigation on a missing credential. (The board half shells to
 * the already-sanctioned paginating enumerator `notion-query.mjs`, and degrades to printing
 * the exact command if a key/script is absent — it never throws the snapshot away.)
 *
 * THE SNAPSHOT CONTRACT (stable field shape; see reference/snapshot.md in the skill):
 *   {
 *     generatedAt, db:{path},
 *     project:{ id, name, projectDir },              // registry id, e.g. claude-dashboard
 *     deployed:{ sha, shortSha, recordedAt },        // project_deployed_sha — the TRUE LIVE sha,
 *                                                     //   NOT the checkout HEAD
 *     activeMilestone:{ id, name, shortId, boardId }, // projects.auto_launch_milestone_id →
 *                                                     //   milestones (source_id = Notion board id)
 *     deployHint,                                     // "live sha is still <x>; a later attempt did
 *                                                     //   not complete" etc. — deployed ≠ HEAD ≠ attempted
 *     health:{
 *       erroredSessions[]  — recent status='error' sessions + each one's on-disk prompt file
 *       recentPlanningSessions[] — recent NON-DONE groom/design/ops sessions (idle/killed/error),
 *                                  the "looks fine but bungled the task" class; + prompt file
 *       recentDeploys[]    — deploy_run attempts (status!=='succeeded' flagged) + last failing step/detail
 *       needsAttentionPRs[] — open / paused PRs (pause_reason parsed) + `repo` + GitHub-verified
 *                             state (`github`, `verification`, `stale`) so stale beliefs are flagged
 *       recentAuditEvents[] — curated incident-shaped audit_log events, newest first
 *     },
 *     board:{ boardId, source:'notion-query'|'unavailable', notDone[], command, error }
 *   }
 *
 * ID-SPACE TRAPS baked into the resolution (see context.md; do not re-derive by hand):
 *   - `--project` is the orchestrator **registry id** `claude-dashboard`, NEVER the config-dir
 *     name `claude-orchestrator`. The DB, deploy report-in, and gate/seed keys all use the
 *     registry id.
 *   - task ids in the DB are **`notion:`-prefixed** (`task_cache`, `audit_log.task_id`) — the
 *     board's own ids are the bare Notion uuids. Every surfaced task id carries a pre-normalized
 *     `taskIdForms:{ raw, bare, notion }` (board rows: `idForms`) so a correlation query can't miss
 *     a row on the wrong shape. Match on the FULL id (these ids share long structured prefixes — a
 *     truncated match hits the wrong row).
 *   - PR numbers are PER-REPO and `pull_requests` mixes repos, so each needs-attention PR carries
 *     its own `repo` and a `verifyCommand` scoped with `-R <repo>` — never verify with a bare number.
 *
 * Usage:
 *   node investigate-load.mjs [options]
 *
 * Options:
 *   --project <id>     Orchestrator registry id (default: claude-dashboard).
 *   --db <path>        SQLite DB (default: $ORCHESTRATOR_DB_PATH or
 *                      /srv/orchestrator/data/dashboard.db).
 *   --env <path>       .env holding NOTION_API_KEY for the board fetch (default: try
 *                      <projectDir>/packages/backend/.env, else $NOTION_API_KEY).
 *   --no-board         Skip the Notion board fetch (DB snapshot only).
 *   --hours <n>        recentPlanningSessions look-back window (default 48).
 *   --no-verify-prs    Skip GitHub verification of needs-attention PRs (they degrade to
 *                      verification:'unverified' + the exact `gh -R <repo>` command to run).
 *   --limit <n>        Per-section row cap (default 8; audit uses 2×).
 *   --json             Emit the raw snapshot JSON (default: human-readable report + a
 *                      trailing `--- SNAPSHOT JSON ---` block the skill can parse).
 *
 * Read-only guarantee: the DB handle is opened `{ readonly: true }`; this script issues no
 * writes, to the orchestrator DB or anywhere else. It is safe to run against live prod.
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- args -----------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(name);
function fail(msg) {
  console.error(`investigate-load: ${msg}`);
  process.exit(1);
}

const PROJECT = arg('--project', 'claude-dashboard');
const DB_PATH =
  arg('--db', process.env.ORCHESTRATOR_DB_PATH) || '/srv/orchestrator/data/dashboard.db';
const LIMIT = Number(arg('--limit', '8')) || 8;
const HOURS = Number(arg('--hours', '48')) || 48; // recentPlanningSessions look-back window
const WANT_JSON = flag('--json');
const WANT_BOARD = !flag('--no-board');
const VERIFY_PRS = !flag('--no-verify-prs'); // verify needs-attention PRs against GitHub via `gh`

// ---- better-sqlite3 (read-only) ------------------------------------------
// The loader is vendored to ~/.claude/scripts, detached from any node_modules, so resolve the
// runtime's better-sqlite3 by absolute path (context.md § Inspecting live state).
function openDb() {
  const candidates = [
    process.env.ORCHESTRATOR_BETTER_SQLITE3,
    '/srv/orchestrator/runtime/node_modules/better-sqlite3',
    '/srv/orchestrator/projects/claude-orchestrator/node_modules/better-sqlite3',
    'better-sqlite3',
  ].filter(Boolean);
  let Database, lastErr;
  for (const c of candidates) {
    try {
      Database = require(c);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!Database)
    fail(
      `could not load better-sqlite3 (tried ${candidates.join(', ')}): ${lastErr?.message}. ` +
        'Set $ORCHESTRATOR_BETTER_SQLITE3 to its module path.',
    );
  if (!existsSync(DB_PATH)) fail(`DB not found at ${DB_PATH} (override with --db).`);
  try {
    return new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    fail(`could not open ${DB_PATH} read-only: ${e.message}`);
  }
}

// ---- helpers --------------------------------------------------------------
const short = (sha) => (sha ? String(sha).slice(0, 10) : null);
function isoOf(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v).toISOString();
  // numeric-looking string → epoch ms; otherwise assume already ISO
  if (/^\d+$/.test(String(v))) return new Date(Number(v)).toISOString();
  return String(v);
}
function trunc(s, n = 200) {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function parsePauseReason(raw) {
  if (raw == null) return null;
  const s = String(raw);
  if (s.startsWith('{')) {
    try {
      return JSON.parse(s);
    } catch {
      return { raw: s };
    }
  }
  return { reason: s }; // bare enum string form (e.g. "auto_merge_failed")
}
// Task ids live in two id-spaces: DB rows (task_cache, audit_log.task_id, sessions.task_id) use
// `notion:<uuid>`; board rows use the bare uuid. Emit BOTH canonical forms so a correlation query
// can't silently miss a row by carrying the wrong shape (context.md § id-space traps).
function normId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const bare = s.replace(/^notion:/, '');
  return { raw: s, bare, notion: `notion:${bare}` };
}
// A2 — pull_requests.state is the orchestrator's BELIEF, not GitHub truth (context.md
// § pull_requests.state): a PR merged/closed on GitHub can still read state='open' here. Verify each
// against GitHub so an investigation doesn't chase an already-merged row. PR numbers are PER-REPO and
// this table mixes repos, so ALWAYS verify with the row's own `repo` in `-R` — never a bare number.
function ghVerifyPr(repo, number) {
  if (!repo || number == null) return null;
  try {
    const out = execFileSync(
      'gh',
      ['-R', repo, 'pr', 'view', String(number), '--json', 'state,mergedAt,closedAt'],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const j = JSON.parse(out);
    return {
      state: String(j.state || '').toLowerCase(),
      mergedAt: j.mergedAt || null,
      closedAt: j.closedAt || null,
    };
  } catch {
    return null; // gh absent / unauthed / PR not found → degrade to unverified + printed command
  }
}

const db = openDb();
const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

// ---- project + deployed sha + active milestone ---------------------------
const project = one(
  'SELECT id, name, project_dir AS projectDir, auto_launch_milestone_id AS mid FROM projects WHERE id = ?',
  PROJECT,
);
if (!project)
  fail(
    `no project '${PROJECT}' in the projects table. Remember: --project is the registry id ` +
      `(claude-dashboard), NOT the config-dir name (claude-orchestrator).`,
  );

const deployedRow = one(
  'SELECT sha, recorded_at AS recordedAt FROM project_deployed_sha WHERE project_id = ?',
  PROJECT,
);
const deployed = deployedRow
  ? { sha: deployedRow.sha, shortSha: short(deployedRow.sha), recordedAt: deployedRow.recordedAt }
  : { sha: null, shortSha: null, recordedAt: null };

let activeMilestone = null;
if (project.mid) {
  const m = one(
    'SELECT id, name, canonical_short_id AS shortId, source_id AS boardId FROM milestones WHERE id = ?',
    project.mid,
  );
  if (m) activeMilestone = { id: m.id, name: m.name, shortId: m.shortId, boardId: m.boardId };
}

// ---- health: errored sessions (+ their on-disk prompt files) --------------
const erroredSessions = q(
  `SELECT session_id AS sessionId, task_id AS taskId, task_name AS taskName, session_type AS sessionType,
          status, ended_at AS endedAt, worktree_path AS worktreePath, pr_url AS prUrl,
          last_error_detail AS lastErrorDetail
     FROM sessions
    WHERE project_id = ? AND status = 'error'
    ORDER BY COALESCE(ended_at, started_at) DESC
    LIMIT ?`,
  PROJECT,
  LIMIT,
).map((s) => {
  const promptFile = join(project.projectDir, '.claude', 'session-prompts', `${s.sessionId}.md`);
  const err = s.lastErrorDetail || '';
  // Pre-assembly fail-loud: the session errored BEFORE its injected prompt was written, so no
  // prompt file exists — the diagnostic is last_error_detail + the launcher's journalctl line
  // ("[OpsSessionLauncher] failed to assemble planning procedure …"), NOT a prompt file.
  const preAssemblyFailure = /injectedProcedureContent|assemble planning procedure/i.test(err);
  return {
    ...s,
    endedAt: isoOf(s.endedAt),
    taskIdForms: normId(s.taskId),
    lastErrorDetail: trunc(s.lastErrorDetail, 240),
    promptFile: existsSync(promptFile) ? promptFile : null,
    preAssemblyFailure,
  };
});

// ---- health: recent NON-DONE planning sessions (groom/design/ops) ---------
// A1 — the highest-yield block for the current bug class. A planning session that bungled its task
// does NOT error: it parks `idle` (or is `killed`) and looks fine on the dashboard, while having
// groomed/designed/opsed the WRONG thing. Those never appear in erroredSessions above. Surface every
// recent non-Done planning session (any status: idle/killed/error) so its prompt-file + transcript
// can be read. This is where most dispatched-session findings actually come from.
const PLANNING_TYPES = ['groom', 'design', 'ops'];
const planningCutoff = Date.now() - HOURS * 3600 * 1000;
const recentPlanningSessions = q(
  `SELECT session_id AS sessionId, task_id AS taskId, task_name AS taskName, session_type AS sessionType,
          status, started_at AS startedAt, ended_at AS endedAt, worktree_path AS worktreePath,
          pause_reason AS pauseReason, last_error_detail AS lastErrorDetail,
          granted_capabilities AS grantedCapabilities
     FROM sessions
    WHERE project_id = ? AND session_type IN (${PLANNING_TYPES.map(() => '?').join(',')})
      AND status != 'done'
      AND COALESCE(ended_at, started_at) >= ?
    ORDER BY COALESCE(ended_at, started_at) DESC
    LIMIT ?`,
  PROJECT,
  ...PLANNING_TYPES,
  planningCutoff,
  LIMIT,
).map((s) => {
  const promptFile = join(project.projectDir, '.claude', 'session-prompts', `${s.sessionId}.md`);
  return {
    ...s,
    startedAt: isoOf(s.startedAt),
    endedAt: isoOf(s.endedAt),
    taskIdForms: normId(s.taskId),
    pauseReason: parsePauseReason(s.pauseReason),
    lastErrorDetail: trunc(s.lastErrorDetail, 200),
    promptFile: existsSync(promptFile) ? promptFile : null,
  };
});

// ---- health: deploy_run attempts -----------------------------------------
const recentDeploys = q(
  `SELECT run_id AS runId, target_sha AS targetSha, current_step AS currentStep, status,
          started_at AS startedAt, completed_at AS completedAt
     FROM deploy_run
    WHERE project = ?
    ORDER BY started_at DESC
    LIMIT ?`,
  PROJECT,
  LIMIT,
).map((r) => {
  const lastEvent = one(
    `SELECT step, event_type AS eventType, disposition, detail, at
       FROM deploy_run_event WHERE run_id = ? ORDER BY at DESC LIMIT 1`,
    r.runId,
  );
  return {
    ...r,
    shortSha: short(r.targetSha),
    startedAt: isoOf(r.startedAt),
    completedAt: isoOf(r.completedAt),
    completed: r.status === 'succeeded',
    lastEvent: lastEvent
      ? { ...lastEvent, at: isoOf(lastEvent.at), detail: trunc(lastEvent.detail, 200) }
      : null,
  };
});

// deployHint — the load-bearing "deployed ≠ HEAD ≠ attempted" reminder, computed from data.
let deployHint;
const latestDeploy = recentDeploys[0];
if (!deployed.sha) {
  deployHint = 'No deployed SHA recorded — cannot assert what is live. Do not diagnose against HEAD.';
} else if (latestDeploy && !latestDeploy.completed && isoOf(latestDeploy.startedAt) > (deployed.recordedAt || '')) {
  deployHint =
    `Live SHA is still ${deployed.shortSha} (recorded ${deployed.recordedAt}). A LATER deploy attempt ` +
    `(${latestDeploy.shortSha}, ${latestDeploy.status} at step '${latestDeploy.currentStep}') did NOT complete — ` +
    `the checkout/HEAD may be ahead of what is actually running. Re-verify current deployed state before asserting a fix landed.`;
} else {
  deployHint =
    `Live SHA is ${deployed.shortSha} (recorded ${deployed.recordedAt}). This is the deployed truth — ` +
    `the checkout HEAD is NOT it. Fixes land fast: re-check this before framing anything as still-broken.`;
}

// ---- health: needs-attention PRs -----------------------------------------
const needsAttentionPRs = q(
  `SELECT pr_number AS prNumber, pr_url AS prUrl, repo, state, merge_state AS mergeState,
          pause_reason AS pauseReason, head_branch AS headBranch, session_id AS sessionId,
          task_id AS taskId, updated_at AS updatedAt
     FROM pull_requests
    WHERE state = 'open'
       OR (pause_reason IS NOT NULL AND state NOT IN ('merged', 'closed'))
    ORDER BY updated_at DESC
    LIMIT ?`,
  LIMIT,
).map((p) => {
  // Always carry the exact per-repo verify command, even when we verify here — so a skipped/failed
  // verification still hands the operator the correct `-R <repo>` incantation (never a bare number).
  const verifyCommand = `gh -R ${p.repo} pr view ${p.prNumber} --json state,mergedAt,closedAt`;
  let github = null;
  let verification = 'unverified';
  let stale = false;
  if (VERIFY_PRS) {
    github = ghVerifyPr(p.repo, p.prNumber);
    if (github) {
      verification = 'verified';
      // DB believes open/paused; GitHub says merged/closed → STALE belief, not a live symptom.
      stale = github.state === 'merged' || github.state === 'closed';
    }
  }
  return {
    ...p,
    pauseReason: parsePauseReason(p.pauseReason),
    taskIdForms: normId(p.taskId),
    verifyCommand,
    github,
    verification,
    stale,
  };
});

// ---- health: recent incident-shaped audit events -------------------------
const INCIDENT_EVENTS = [
  'session_errored',
  'deploy_failed',
  'stalled_pr_reconcile_attempt',
  'stalled_pr_retry_exhausted',
  'task_orphan_nudged',
  'task_orphan_reverted',
  'pr_closed',
  'pipeline_stage_failed',
  'session_marked_done_while_running',
  'process_boot',
];
const placeholders = INCIDENT_EVENTS.map(() => '?').join(',');
const recentAuditEvents = q(
  `SELECT ts, event_type AS eventType, actor_type AS actorType, task_id AS taskId, payload
     FROM audit_log
    WHERE project_id = ? AND event_type IN (${placeholders})
    ORDER BY ts DESC
    LIMIT ?`,
  PROJECT,
  ...INCIDENT_EVENTS,
  LIMIT * 2,
).map((e) => {
  let payloadSummary = null;
  if (e.payload) {
    try {
      const p = JSON.parse(e.payload);
      payloadSummary = trunc(
        Object.entries(p)
          .slice(0, 4)
          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
          .join(' '),
        160,
      );
    } catch {
      payloadSummary = trunc(e.payload, 160);
    }
  }
  return {
    ts: isoOf(e.ts),
    eventType: e.eventType,
    actorType: e.actorType,
    taskId: e.taskId,
    taskIdForms: normId(e.taskId),
    payloadSummary,
  };
});

db.close();

// ---- board (authoritative non-Done, via the sanctioned enumerator) --------
let board = { boardId: activeMilestone?.boardId ?? null, source: 'skipped', notDone: [], command: null, error: null };
if (WANT_BOARD && activeMilestone?.boardId) {
  const boardId = activeMilestone.boardId;
  const notionQuery = [join(HERE, 'notion-query.mjs'), join(process.env.HOME || '', '.claude/scripts/notion-query.mjs')].find(
    existsSync,
  );
  const envPath =
    arg('--env') ||
    (project.projectDir && existsSync(join(project.projectDir, 'packages/backend/.env'))
      ? join(project.projectDir, 'packages/backend/.env')
      : null);
  const cmdArgs = [boardId, '--no-done', '--json'];
  if (envPath) cmdArgs.push('--env', envPath);
  const command = `node ${notionQuery || 'notion-query.mjs'} ${cmdArgs.join(' ')}`;
  board.command = command;
  const haveKey = !!envPath || !!process.env.NOTION_API_KEY;
  if (!notionQuery) {
    board.source = 'unavailable';
    board.error = 'notion-query.mjs not found beside the loader or in ~/.claude/scripts — run the command by hand.';
  } else if (!haveKey) {
    board.source = 'unavailable';
    board.error = 'No NOTION_API_KEY (pass --env <path-to>/packages/backend/.env) — run the command by hand.';
  } else {
    try {
      const out = execFileSync('node', [notionQuery, ...cmdArgs], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: process.env,
      });
      const parsed = JSON.parse(out);
      const rows = Array.isArray(parsed) ? parsed : parsed.tasks || parsed.results || [];
      // notion-query --json emits raw Notion property names ("Task Name", "Status", "Type",
      // "Priority", "Depends On"). Normalize, tolerating the lowercase shape too.
      board.notDone = rows.map((t) => ({
        id: t.id,
        idForms: normId(t.id), // board ids are bare uuids; carry the notion:<uuid> form too
        title: t['Task Name'] || t._title || t.title || t.name,
        status: t.Status || t.status,
        type: t.Type || t.type,
        priority: t.Priority || t.priority,
        dependsOn: t['Depends On'] || t.dependsOn || t.depends_on || '',
        notionUrl: t.url || t.notionUrl,
      }));
      board.source = 'notion-query';
    } catch (e) {
      board.source = 'unavailable';
      board.error = trunc(e.message, 300);
    }
  }
} else if (WANT_BOARD) {
  board.source = 'unavailable';
  board.error = 'No active milestone / board id resolvable from the DB.';
}

// ---- assemble -------------------------------------------------------------
const snapshot = {
  generatedAt: new Date().toISOString(),
  db: { path: DB_PATH, readonly: true },
  project: { id: project.id, name: project.name, projectDir: project.projectDir },
  deployed,
  activeMilestone,
  deployHint,
  health: { erroredSessions, recentPlanningSessions, recentDeploys, needsAttentionPRs, recentAuditEvents },
  board,
};

if (WANT_JSON) {
  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}

// ---- human-readable report (+ trailing JSON block) ------------------------
const L = [];
L.push(`investigate live-health snapshot   ·   ${snapshot.generatedAt}`);
L.push(`  project        : ${project.name}  [${project.id}]   dir=${project.projectDir}`);
L.push(`  DB (read-only) : ${DB_PATH}`);
L.push(
  `  active milestone: ${activeMilestone ? `${activeMilestone.shortId} — ${activeMilestone.name}` : '(none)'}` +
    (activeMilestone?.boardId ? `   board=${activeMilestone.boardId}` : ''),
);
L.push('');
L.push(`▎DEPLOYED (live truth — NOT the checkout HEAD)`);
L.push(`  sha=${deployed.shortSha ?? '—'}   recorded=${deployed.recordedAt ?? '—'}`);
L.push(`  ⚠ ${deployHint}`);
L.push('');
L.push(`▎ERRORED SESSIONS  (${erroredSessions.length})`);
for (const s of erroredSessions) {
  L.push(`  · ${s.sessionId}  [${s.sessionType}]  ${s.endedAt ?? ''}`);
  L.push(`      task: ${s.taskName ?? '—'}${s.taskIdForms ? `   id=${s.taskIdForms.bare} | ${s.taskIdForms.notion}` : ''}`);
  if (s.lastErrorDetail) L.push(`      err : ${s.lastErrorDetail}`);
  if (s.promptFile) L.push(`      prompt-file: ${s.promptFile}`);
  else if (s.preAssemblyFailure)
    L.push(
      `      prompt-file: (none — PRE-ASSEMBLY fail-loud; no prompt was written. Diagnostic = err above +` +
        ` journalctl -u orchestrator.service | grep "failed to assemble planning procedure")`,
    );
  else L.push(`      prompt-file: (none on disk — session never wrote one)`);
  if (s.worktreePath) L.push(`      worktree(read-only): ${s.worktreePath}`);
}
if (!erroredSessions.length) L.push('  (none)');
L.push('');
L.push(`▎NON-DONE PLANNING SESSIONS  (groom/design/ops, last ${HOURS}h)  (${recentPlanningSessions.length})`);
L.push(`  ⚠ idle/killed ≠ ok — a bungled planning session parks 'idle' and looks fine. Read its prompt-file + transcript.`);
for (const s of recentPlanningSessions) {
  L.push(`  · ${s.sessionId}  [${s.sessionType}]  status=${s.status}  ${s.endedAt ?? s.startedAt ?? ''}`);
  L.push(`      task: ${s.taskName ?? '—'}${s.taskIdForms ? `   id=${s.taskIdForms.bare} | ${s.taskIdForms.notion}` : ''}`);
  if (s.pauseReason?.reason) L.push(`      pause: ${s.pauseReason.reason}`);
  if (s.lastErrorDetail) L.push(`      err : ${s.lastErrorDetail}`);
  if (s.promptFile) L.push(`      prompt-file: ${s.promptFile}`);
  else L.push(`      prompt-file: (none on disk)`);
}
if (!recentPlanningSessions.length) L.push('  (none)');
L.push('');
L.push(`▎DEPLOY RUNS  (${recentDeploys.length})`);
for (const r of recentDeploys) {
  L.push(
    `  · ${r.shortSha}  ${r.status}${r.completed ? '' : '  ⚠ did not complete'}  step='${r.currentStep}'  ${r.startedAt}`,
  );
  if (r.lastEvent && r.lastEvent.detail) L.push(`      last: ${r.lastEvent.step} — ${r.lastEvent.detail}`);
}
if (!recentDeploys.length) L.push('  (none)');
L.push('');
L.push(`▎NEEDS-ATTENTION PRs  (${needsAttentionPRs.length})  [gh verification: ${VERIFY_PRS ? 'on' : 'off (--no-verify-prs)'}]`);
L.push(`  ⚠ db state is the orchestrator's BELIEF, not GitHub truth — a 'STALE' row is already merged/closed and is NOT a live symptom.`);
for (const p of needsAttentionPRs) {
  const ghState = p.github
    ? `gh=${p.github.state}${p.stale ? '  ⚠STALE — already merged/closed on GitHub, NOT a live symptom' : ''}`
    : 'gh=unverified';
  L.push(
    `  · #${p.prNumber}  [${p.repo}]  db=${p.state}  merge=${p.mergeState ?? '—'}  ${ghState}  pause=${p.pauseReason?.reason ?? '—'}` +
      (p.pauseReason?.detail ? ` (${trunc(p.pauseReason.detail, 80)})` : ''),
  );
  if (!p.github) L.push(`      verify: ${p.verifyCommand}`);
  if (p.headBranch) L.push(`      branch(read-only): ${p.headBranch}`);
}
if (!needsAttentionPRs.length) L.push('  (none)');
L.push('');
L.push(`▎RECENT INCIDENT-SHAPED AUDIT EVENTS  (${recentAuditEvents.length})`);
for (const e of recentAuditEvents) {
  L.push(`  · ${e.ts}  ${e.eventType}  ${e.taskId ?? ''}${e.payloadSummary ? `  — ${e.payloadSummary}` : ''}`);
}
if (!recentAuditEvents.length) L.push('  (none)');
L.push('');
L.push(`▎ACTIVE BOARD (non-Done)  [${board.source}]  (${board.notDone.length})`);
if (board.source === 'notion-query') {
  for (const t of board.notDone) L.push(`  · ${t.status}  ${t.type ?? ''}  ${t.title}   [${t.id}]`);
} else {
  L.push(`  ${board.error ?? 'not fetched'}`);
  if (board.command) L.push(`  run: ${board.command}`);
}
L.push('');
L.push('--- SNAPSHOT JSON ---');
L.push(JSON.stringify(snapshot));
console.log(L.join('\n'));
