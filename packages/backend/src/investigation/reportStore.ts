import crypto from 'crypto';
import { db } from '../db/db';
import { recordEvent } from '../audit/AuditLog';
import { TERMINAL_SESSION_STATUSES } from '../db/queries';

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
 * resolve-eligibility waits on. Locked by the design task; 'withdrawn' is
 * also terminal in staged_intent but is not part of this locked list.
 */
const TERMINAL_STAGED_INTENT_STATES = new Set([
  'committed',
  'rejected',
  'superseded',
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

/**
 * Advances the closed-vocabulary state column. No transition validation is
 * enforced here — callers (the intake surface, resolve-eligibility watcher)
 * own which transitions are legal.
 */
export function updateReportState(
  id: string,
  state: InvestigationReportState,
  updatedAt: string,
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
    payload: { reportId: id, from: row.state, to: state },
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
 * Resolve-eligibility: at least one dispatched session has reached a
 * terminal session status, AND every staged_intent tied to any session ever
 * recorded in investigation_report_dispatch for this report (aggregated
 * across the report's entire dispatch history) is in a terminal disposition
 * state. Vacuously true for a session that stages nothing — a report
 * investigated and found not-actionable still resolves once its session
 * ends. A report with no dispatch history at all is never eligible: clause
 * (a) requires at least one terminal session.
 */
export function isResolveEligible(reportId: string): boolean {
  const sessionIds = listDispatchedSessions(reportId).map((d) => d.session_id);
  if (sessionIds.length === 0) return false;

  const statuses = getSessionStatuses(sessionIds);
  const hasTerminalSession = [...statuses.values()].some((status) =>
    TERMINAL_SESSION_STATUSES.has(status),
  );
  if (!hasTerminalSession) return false;

  const placeholders = sessionIds.map(() => '?').join(', ');
  const intentStates = db
    .prepare(
      `SELECT state FROM staged_intent WHERE session_id IN (${placeholders})`,
    )
    .all(...sessionIds) as { state: string }[];
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
