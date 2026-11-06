import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '../db/db';
import { recordEvent } from '../audit/AuditLog';
import { TERMINAL_SESSION_STATUSES } from '../db/queries';
import { getDataDir } from '../config/dataDir';

/**
 * Closed vocabulary for investigation_report.state. There is no persisted
 * 'dispatched' state — in-flight status is a derived live read (see
 * isInFlight) over investigation_report_dispatch, mirroring gate_item's
 * verifyInFlight.
 */
export type InvestigationReportState =
  | 'draft'
  | 'committed'
  | 'resolved'
  | 'abandoned';

type InvestigationReportSource = 'operator' | 'session';

/**
 * staged_intent states that terminate an intent's disposition — the set
 * resolve-eligibility waits on. A withdrawal is itself a disposition
 * (stagedIntents.ts records it with disposition: 'withdrawn'), so it counts
 * as terminal alongside committed/rejected/superseded.
 */
const TERMINAL_STAGED_INTENT_STATES = new Set([
  'committed',
  'rejected',
  'superseded',
  'withdrawn',
]);

const TERMINAL_REPORT_STATES = new Set<InvestigationReportState>([
  'resolved',
  'abandoned',
]);

export interface InvestigationReportRow {
  id: string;
  project_id: string;
  milestone_id: string;
  title: string;
  symptom_text: string;
  evidence_text: string | null;
  state: InvestigationReportState;
  source: InvestigationReportSource;
  origin_session_id: string | null;
  origin_task_id: string | null;
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvestigationReportDispatchRow {
  id: number;
  report_id: string;
  session_id: string;
  dispatched_at: string;
}

export interface NewInvestigationReportInput {
  /** milestones.id (a UUID) — the flow_arm.milestone_id key space, NOT the gate_item/seed_item display-name form. */
  projectId: string;
  milestoneId: string;
  title: string;
  symptomText: string;
  evidenceText?: string;
  source?: InvestigationReportSource;
  originSessionId?: string;
  originTaskId?: string;
  createdAt: string;
}

/** Mints a fresh id at file time; new reports always start in 'draft'. */
export function insertReport(
  input: NewInvestigationReportInput,
): InvestigationReportRow {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO investigation_report
       (id, project_id, milestone_id, title, symptom_text, evidence_text,
        state, source, origin_session_id, origin_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.milestoneId,
    input.title,
    input.symptomText,
    input.evidenceText ?? null,
    input.source ?? 'operator',
    input.originSessionId ?? null,
    input.originTaskId ?? null,
    input.createdAt,
    input.createdAt,
  );
  recordEvent({
    event_type: 'investigation_report_created',
    actor_type: 'system',
    project_id: input.projectId,
    payload: { reportId: id, milestoneId: input.milestoneId },
  });
  const row = getReport(id);
  if (!row) {
    throw new Error(
      `investigation_report: failed to read back report ${id} after insert`,
    );
  }
  return row;
}

export function getReport(id: string): InvestigationReportRow | undefined {
  return db
    .prepare(`SELECT * FROM investigation_report WHERE id = ?`)
    .get(id) as InvestigationReportRow | undefined;
}

/** Every report for a milestone within a project — milestoneId is the milestones.id UUID, not a display name. */
export function listReportsByMilestone(
  projectId: string,
  milestoneId: string,
): InvestigationReportRow[] {
  return db
    .prepare(
      `SELECT * FROM investigation_report
       WHERE project_id = ? AND milestone_id = ?
       ORDER BY created_at DESC`,
    )
    .all(projectId, milestoneId) as InvestigationReportRow[];
}

/** Every report for a project, regardless of milestone. */
export function listReportsByProject(
  projectId: string,
): InvestigationReportRow[] {
  return db
    .prepare(
      `SELECT * FROM investigation_report
       WHERE project_id = ?
       ORDER BY created_at DESC`,
    )
    .all(projectId) as InvestigationReportRow[];
}

export interface ReportFilter {
  projectId?: string;
  milestoneId?: string;
  state?: string;
}

function buildReportWhereClause(filter: ReportFilter): {
  clause: string;
  params: Record<string, string>;
} {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (filter.projectId) {
    conditions.push('project_id = @projectId');
    params.projectId = filter.projectId;
  }
  if (filter.milestoneId) {
    conditions.push('milestone_id = @milestoneId');
    params.milestoneId = filter.milestoneId;
  }
  if (filter.state) {
    conditions.push('state = @state');
    params.state = filter.state;
  }
  return {
    clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/** Paginated, filtered read over investigation_report — never an unbounded load; caller supplies limit/offset. */
export function listReportsFiltered(
  filter: ReportFilter,
  limit: number,
  offset: number,
): InvestigationReportRow[] {
  const { clause, params } = buildReportWhereClause(filter);
  return db
    .prepare(
      `SELECT * FROM investigation_report ${clause} ORDER BY created_at DESC, id ASC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as InvestigationReportRow[];
}

/** Total count matching the same filter as listReportsFiltered — powers the `total` in a paginated response. */
export function countReportsFiltered(filter: ReportFilter): number {
  const { clause, params } = buildReportWhereClause(filter);
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM investigation_report ${clause}`)
    .get(params) as { count: number };
  return row.count;
}

export interface ReportFieldUpdate {
  title?: string;
  symptomText?: string;
  evidenceText?: string | null;
  milestoneId?: string;
}

/** Updates draft-mutable content fields — callers own restricting this to the draft state. */
export function updateReportFields(
  id: string,
  fields: ReportFieldUpdate,
  updatedAt: string,
): InvestigationReportRow {
  const row = getReport(id);
  if (!row) {
    throw new Error(`investigation_report: no report ${id} to update`);
  }
  db.prepare(
    `UPDATE investigation_report
       SET title = ?, symptom_text = ?, evidence_text = ?, milestone_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    fields.title ?? row.title,
    fields.symptomText ?? row.symptom_text,
    fields.evidenceText !== undefined ? fields.evidenceText : row.evidence_text,
    fields.milestoneId ?? row.milestone_id,
    updatedAt,
    id,
  );
  const updated = getReport(id);
  if (!updated) {
    throw new Error(
      `investigation_report: failed to read back report ${id} after field update`,
    );
  }
  return updated;
}

const REPORT_IMAGES_DIRNAME = 'investigation-report-images';

/**
 * Backend-owned filesystem directory holding screenshot attachment bytes —
 * not a SQLite BLOB and not an operator-supplied path reference (see the
 * "Design screenshot attachment for investigation reports" task). Resolved
 * fresh on every call (mirrors logger.ts/dependencyCachePool.ts's own
 * getDataDir() usage) rather than cached, so a test pointing getDataDir()
 * at a tmp dir (e.g. via XDG_DATA_HOME) takes effect without any
 * module-reload dance.
 */
export function getReportImagesDir(): string {
  return path.join(getDataDir(), REPORT_IMAGES_DIRNAME);
}

function reportImageFilePath(reportId: string, extension: string): string {
  return path.join(getReportImagesDir(), `${reportId}${extension}`);
}

/**
 * Writes screenshot bytes to backend-owned storage and records the result
 * on investigation_report.image_path. The directory is created on first
 * write (fs.mkdirSync({recursive:true}), mirroring planningScratchDir.ts's
 * own precedent) rather than assumed to pre-exist.
 *
 * Ordering guards against a report referencing a missing image file: the
 * file is written before the row update commits, and rolled back if the
 * row update then fails — so a crash or disk-full mid-write can never leave
 * a committed row pointing at a file that isn't there.
 */
export function writeReportImage(
  reportId: string,
  imageBytes: Buffer,
  extension: string,
  updatedAt: string,
): InvestigationReportRow {
  const row = getReport(reportId);
  if (!row) {
    throw new Error(
      `investigation_report: no report ${reportId} to attach an image to`,
    );
  }
  fs.mkdirSync(getReportImagesDir(), { recursive: true });
  const filePath = reportImageFilePath(reportId, extension);
  fs.writeFileSync(filePath, imageBytes);
  try {
    db.prepare(
      `UPDATE investigation_report SET image_path = ?, updated_at = ? WHERE id = ?`,
    ).run(filePath, updatedAt, reportId);
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }
  const updated = getReport(reportId);
  if (!updated) {
    fs.rmSync(filePath, { force: true });
    throw new Error(
      `investigation_report: failed to read back report ${reportId} after image update`,
    );
  }
  if (row.image_path && row.image_path !== filePath) {
    fs.rmSync(row.image_path, { force: true });
  }
  return updated;
}

/**
 * Clears a report's screenshot attachment — removes the row's image_path
 * (back to null) and, if a file was actually on disk, removes it too. A
 * no-op file removal (already-clear report) is not an error.
 */
export function clearReportImage(
  reportId: string,
  updatedAt: string,
): InvestigationReportRow {
  const row = getReport(reportId);
  if (!row) {
    throw new Error(
      `investigation_report: no report ${reportId} to clear an image from`,
    );
  }
  db.prepare(
    `UPDATE investigation_report SET image_path = NULL, updated_at = ? WHERE id = ?`,
  ).run(updatedAt, reportId);
  const updated = getReport(reportId);
  if (!updated) {
    throw new Error(
      `investigation_report: failed to read back report ${reportId} after image clear`,
    );
  }
  if (row.image_path) {
    fs.rmSync(row.image_path, { force: true });
  }
  return updated;
}

/**
 * Advances the closed-vocabulary state column. No transition validation is
 * enforced here — callers (the intake surface, resolve-eligibility watcher)
 * own which transitions are legal. `reason`, when supplied, is a session's
 * own stated why (e.g. an investigate session's auto-resolved
 * `planning.noOp`) and is folded into the audit payload; omitted entirely
 * when absent, preserving today's payload shape for callers (the passive
 * resolve watcher, the intake surface) that supply none.
 */
export function updateReportState(
  id: string,
  state: InvestigationReportState,
  updatedAt: string,
  reason?: string,
): InvestigationReportRow {
  const row = getReport(id);
  if (!row) {
    throw new Error(`investigation_report: no report ${id} to advance`);
  }
  db.prepare(
    `UPDATE investigation_report SET state = ?, updated_at = ? WHERE id = ?`,
  ).run(state, updatedAt, id);
  recordEvent({
    event_type: 'investigation_report_state_changed',
    actor_type: 'system',
    project_id: row.project_id,
    payload: {
      reportId: id,
      from: row.state,
      to: state,
      ...(reason ? { reason } : {}),
    },
  });
  const updated = getReport(id);
  if (!updated) {
    throw new Error(
      `investigation_report: failed to read back report ${id} after state advance`,
    );
  }
  return updated;
}

/**
 * Records a report→session dispatch — always-batched, even for a single
 * report (sessions.task_id = 'report-batch:<batchId>'). Callers write this
 * in the same transaction as the session insert; this function issues a
 * plain insert so it composes inside a caller-owned db.transaction().
 */
export function recordDispatch(
  reportId: string,
  sessionId: string,
  dispatchedAt: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO investigation_report_dispatch (report_id, session_id, dispatched_at)
     VALUES (?, ?, ?)`,
  ).run(reportId, sessionId, dispatchedAt);
}

/**
 * Atomically inserts a batch dispatch's session row (via caller-supplied
 * insertSession, e.g. SessionManager's session insert) together with every
 * report's investigation_report_dispatch row, in a single transaction — a
 * session can never commit without its dispatch rows, or vice versa. Callers
 * must not commit the session insert separately; pass it as insertSession.
 */
export function recordBatchDispatch(
  insertSession: () => void,
  reportIds: string[],
  sessionId: string,
  dispatchedAt: string,
): void {
  db.transaction(() => {
    insertSession();
    for (const reportId of reportIds) {
      recordDispatch(reportId, sessionId, dispatchedAt);
    }
  })();
}

interface SessionMetadataWithReportIds {
  reportIds?: string[];
}

/**
 * Reconciler backfill: finds investigate-batch sessions (task_id
 * 'report-batch:<batchId>') whose investigation_report_dispatch rows are
 * missing — e.g. recordBatchDispatch's transaction didn't reach this call
 * site — and backfills them from sessions.metadata.reportIds, which the
 * dispatch call site is required to populate. Idempotent: INSERT OR IGNORE
 * plus the (report_id, session_id) unique index means re-running a tick
 * after a previous backfill (or after recordBatchDispatch itself already
 * wrote the rows) is a no-op. Returns the number of dispatch rows inserted
 * this tick.
 */
export function reconcileOrphanedDispatches(dispatchedAt: string): number {
  const sessions = db
    .prepare(
      `SELECT session_id, metadata FROM sessions WHERE task_id LIKE 'report-batch:%'`,
    )
    .all() as { session_id: string; metadata: string | null }[];

  let backfilled = 0;
  for (const session of sessions) {
    const hasDispatchRow = db
      .prepare(
        `SELECT 1 FROM investigation_report_dispatch WHERE session_id = ? LIMIT 1`,
      )
      .get(session.session_id);
    if (hasDispatchRow || !session.metadata) continue;

    let reportIds: string[];
    try {
      const parsed = JSON.parse(
        session.metadata,
      ) as SessionMetadataWithReportIds;
      reportIds = Array.isArray(parsed.reportIds) ? parsed.reportIds : [];
    } catch {
      continue;
    }
    for (const reportId of reportIds) {
      recordDispatch(reportId, session.session_id, dispatchedAt);
      backfilled++;
    }
  }
  return backfilled;
}

/**
 * Reverse of listDispatchedSessions: the report(s) dispatched to the session
 * identified by an investigate batch's synthetic task_id
 * (`report-batch:<batchId>`) — resolveMilestoneForSessionTask's lookup path
 * for attributing a milestone to that session. Joins through the session row
 * (task_id -> session_id) and investigation_report_dispatch (session_id ->
 * report_id); the batchId itself is never parsed as a key, since dispatch
 * rows are keyed by session_id, not the synthetic batch id. Returns [] — never
 * throws — when no session matches the task_id or it has no dispatch rows.
 */
export function getReportsForBatchTaskId(
  taskId: string,
): InvestigationReportRow[] {
  const session = db
    .prepare(`SELECT session_id FROM sessions WHERE task_id = ?`)
    .get(taskId) as { session_id: string } | undefined;
  if (!session) return [];
  return db
    .prepare(
      `SELECT r.* FROM investigation_report r
       JOIN investigation_report_dispatch d ON d.report_id = r.id
       WHERE d.session_id = ?
       ORDER BY d.id ASC`,
    )
    .all(session.session_id) as InvestigationReportRow[];
}

/** Every session ever dispatched for a report, oldest first — its entire dispatch history. */
export function listDispatchedSessions(
  reportId: string,
): InvestigationReportDispatchRow[] {
  return db
    .prepare(
      `SELECT * FROM investigation_report_dispatch
       WHERE report_id = ?
       ORDER BY id ASC`,
    )
    .all(reportId) as InvestigationReportDispatchRow[];
}

export interface ReportDispatchedSession {
  sessionId: string;
  sessionStatus: string;
  dispatchedAt: string;
}

/**
 * Every session ever dispatched for a report, joined with its live status —
 * the read the report card's session-view affordance is built from. Most
 * recent dispatch first. Mirrors gateService.ts's
 * getVerifySessionsForGateItem(s), keyed on investigation_report_dispatch
 * rather than task_id string-matching.
 */
export function getDispatchedSessionsForReport(
  reportId: string,
): ReportDispatchedSession[] {
  const dispatches = listDispatchedSessions(reportId);
  const statuses = getSessionStatuses(dispatches.map((d) => d.session_id));
  return dispatches
    .slice()
    .reverse()
    .map((d) => ({
      sessionId: d.session_id,
      sessionStatus: statuses.get(d.session_id) ?? 'unknown',
      dispatchedAt: d.dispatched_at,
    }));
}

function getSessionStatuses(sessionIds: string[]): Map<string, string> {
  if (sessionIds.length === 0) return new Map();
  const placeholders = sessionIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT session_id, status FROM sessions WHERE session_id IN (${placeholders})`,
    )
    .all(...sessionIds) as { session_id: string; status: string }[];
  return new Map(rows.map((r) => [r.session_id, r.status]));
}

/**
 * Derived live in-flight status: true if any session ever recorded in
 * investigation_report_dispatch for this report is currently non-terminal.
 * Mirrors gate_item's verifyInFlight (getLiveVerifySessionItemIds) but keyed
 * on the dispatch join table rather than task_id string-matching.
 */
export function isInFlight(reportId: string): boolean {
  const sessionIds = listDispatchedSessions(reportId).map((d) => d.session_id);
  const statuses = getSessionStatuses(sessionIds);
  for (const status of statuses.values()) {
    if (!TERMINAL_SESSION_STATUSES.has(status)) return true;
  }
  return false;
}

/**
 * Resolve-eligibility: every session ever dispatched for this report
 * (across its full dispatch history, via investigation_report_dispatch) has
 * reached a terminal session status — equivalent to !isInFlight(reportId) —
 * AND every staged_intent tied to any of those sessions is in a terminal
 * disposition state. A report with no dispatch history at all is never
 * eligible.
 *
 * When no staged_intent rows exist at all (the vacuous case), resolving
 * requires at least one dispatched session to have concluded cleanly
 * (status 'done') — a report investigated to completion and found
 * not-actionable still resolves once its session ends. A session that was
 * killed or crashed ('error') before staging anything never ran the
 * investigation, so it cannot vacuously satisfy this on its own; it blocks
 * nothing, though — a later redispatch that concludes 'done' with nothing
 * to stage still resolves the report.
 *
 * Requiring the *whole* dispatch history to be terminal (not merely one
 * session) matters for a batched dispatch — a report sharing a session with
 * others, later re-dispatched on its own while a sibling's session is still
 * live, must not resolve on the strength of an already-terminal sibling
 * session alone.
 */
export function isResolveEligible(reportId: string): boolean {
  const sessionIds = listDispatchedSessions(reportId).map((d) => d.session_id);
  if (sessionIds.length === 0) return false;

  const statuses = getSessionStatuses(sessionIds);
  const allSessionsTerminal = [...statuses.values()].every((status) =>
    TERMINAL_SESSION_STATUSES.has(status),
  );
  if (!allSessionsTerminal) return false;

  const placeholders = sessionIds.map(() => '?').join(', ');
  const intentStates = db
    .prepare(
      `SELECT state FROM staged_intent WHERE session_id IN (${placeholders})`,
    )
    .all(...sessionIds) as { state: string }[];

  if (intentStates.length === 0) {
    return [...statuses.values()].some((status) => status === 'done');
  }

  return intentStates.every((row) =>
    TERMINAL_STAGED_INTENT_STATES.has(row.state),
  );
}

/**
 * Dispatch eligibility: state === 'committed' AND no live non-terminal
 * session already recorded for this report (isInFlight). This is the
 * predicate a scan builds candidates from, and — mirroring
 * DispatchTriggerEvaluator.dispatchUpTo's revalidate-before-dispatch
 * pattern — the same predicate re-run immediately before each launch below.
 */
export function isDispatchEligible(reportId: string): boolean {
  const report = getReport(reportId);
  if (!report) return false;
  return report.state === 'committed' && !isInFlight(reportId);
}

/**
 * Dispatches candidate report-id batches (always-batched, even a batch of
 * one) FIFO, re-validating isDispatchEligible for every report in a batch
 * immediately before that batch's launch — against freshly-read state, not
 * the scan-time snapshot. This closes the race between candidate selection
 * and the dispatch call: a report that passed the scan but had another
 * dispatch land (or was abandoned) before its turn is skipped rather than
 * double-dispatched. dispatchFn is expected to perform the actual session
 * creation + recordBatchDispatch write and return whether it launched.
 */
export function dispatchReportBatchesUpTo(
  candidateBatches: string[][],
  dispatchFn: (reportIds: string[]) => boolean,
): number {
  let dispatched = 0;
  for (const batch of candidateBatches) {
    if (!batch.every((reportId) => isDispatchEligible(reportId))) continue;
    if (dispatchFn(batch)) dispatched++;
  }
  return dispatched;
}

/**
 * Whether this report's persisted state blocks milestone convergence — an
 * unresolved report (state not in {resolved, abandoned}) blocks, the same
 * way an open gate_item does. Wiring this into convergenceService.ts's
 * blocking-item rollup is a sibling task; this is only the predicate.
 */
export function blocksMilestoneConvergence(
  state: InvestigationReportState,
): boolean {
  return !TERMINAL_REPORT_STATES.has(state);
}
