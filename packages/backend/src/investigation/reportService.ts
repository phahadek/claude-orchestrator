import {
  insertReport,
  getReport,
  listReportsFiltered,
  countReportsFiltered,
  updateReportFields,
  updateReportState,
  isInFlight,
  isResolveEligible,
  blocksMilestoneConvergence,
} from './reportStore';
import type { InvestigationReportRow, ReportFilter } from './reportStore';

/**
 * Business logic for investigation_report — the state-machine guards and
 * the derived-field reads routes/reportState.ts exposes. Mirrors
 * gateService.ts's split: routes only parse the request and translate
 * errors to status codes, this module owns the rules.
 */

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

export interface InvestigationReportWithDerived extends InvestigationReportRow {
  inFlight: boolean;
  resolveEligible: boolean;
}

function withDerived(
  row: InvestigationReportRow,
): InvestigationReportWithDerived {
  return {
    ...row,
    inFlight: isInFlight(row.id),
    resolveEligible: isResolveEligible(row.id),
  };
}

export interface CreateReportInput {
  projectId: string;
  milestoneId?: string;
  title: string;
  symptomText: string;
  evidenceText?: string;
  source?: 'operator' | 'session';
  originSessionId?: string;
  originTaskId?: string;
}

/**
 * Creates a draft report. milestone_id is NOT required at draft time —
 * it defaults to '' (the NOT NULL column still has a value) and must be
 * set (via updateDraftReport or at create) before commitReport succeeds.
 */
export function createReport(
  input: CreateReportInput,
): InvestigationReportWithDerived {
  if (!input.projectId || !input.projectId.trim()) {
    throw new Error('projectId is required');
  }
  if (!input.title || !input.title.trim()) {
    throw new Error('title is required');
  }
  if (!input.symptomText || !input.symptomText.trim()) {
    throw new Error('symptomText is required');
  }
  const row = insertReport({
    projectId: input.projectId,
    milestoneId: input.milestoneId ?? '',
    title: input.title,
    symptomText: input.symptomText,
    evidenceText: input.evidenceText,
    source: input.source,
    originSessionId: input.originSessionId,
    originTaskId: input.originTaskId,
    createdAt: new Date().toISOString(),
  });
  return withDerived(row);
}

export interface UpdateDraftReportInput {
  title?: string;
  symptomText?: string;
  evidenceText?: string | null;
  milestoneId?: string;
}

/** Updates a report's content fields — only while it is still a draft. */
export function updateDraftReport(
  id: string,
  fields: UpdateDraftReportInput,
): InvestigationReportWithDerived {
  const existing = getReport(id);
  if (!existing) {
    throw new Error(`no investigation report ${id}`);
  }
  if (existing.state !== 'draft') {
    throw new Error(
      `investigation report ${id} is ${existing.state}, not draft — cannot update`,
    );
  }
  const row = updateReportFields(id, fields, new Date().toISOString());
  return withDerived(row);
}

/** Draft → committed. Requires milestone_id to be set (non-empty) and the report to still be a draft. */
export function commitReport(id: string): InvestigationReportWithDerived {
  const existing = getReport(id);
  if (!existing) {
    throw new Error(`no investigation report ${id}`);
  }
  if (existing.state !== 'draft') {
    throw new Error(
      `investigation report ${id} is ${existing.state}, not draft — cannot commit`,
    );
  }
  if (!existing.milestone_id || !existing.milestone_id.trim()) {
    throw new Error(
      `investigation report ${id} has no milestone_id set — required to commit`,
    );
  }
  const row = updateReportState(id, 'committed', new Date().toISOString());
  return withDerived(row);
}

/** Abandons a report from any non-terminal state (draft or committed). */
export function abandonReport(id: string): InvestigationReportWithDerived {
  const existing = getReport(id);
  if (!existing) {
    throw new Error(`no investigation report ${id}`);
  }
  if (!blocksMilestoneConvergence(existing.state)) {
    throw new Error(
      `investigation report ${id} is already ${existing.state} — cannot abandon`,
    );
  }
  const row = updateReportState(id, 'abandoned', new Date().toISOString());
  return withDerived(row);
}

export function getReportWithDerived(
  id: string,
): InvestigationReportWithDerived | undefined {
  const row = getReport(id);
  return row ? withDerived(row) : undefined;
}

export interface ListReportsOptions {
  project?: string;
  milestone?: string;
  state?: string;
  page?: number;
  limit?: number;
}

export interface ListReportsResult {
  items: InvestigationReportWithDerived[];
  total: number;
  page: number;
}

/** Paginated, filtered read over investigation_report — never an unbounded load. */
export function listReports(
  options: ListReportsOptions = {},
): ListReportsResult {
  const page =
    options.page !== undefined && options.page > 0
      ? Math.floor(options.page)
      : 1;
  const limit = Math.min(
    options.limit !== undefined && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
  );
  const offset = (page - 1) * limit;
  const filter: ReportFilter = {
    projectId: options.project,
    milestoneId: options.milestone,
    state: options.state,
  };
  const items = listReportsFiltered(filter, limit, offset).map(withDerived);
  const total = countReportsFiltered(filter);
  return { items, total, page };
}
