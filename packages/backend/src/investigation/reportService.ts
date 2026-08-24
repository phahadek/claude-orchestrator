import {
  insertReport,
  getReport,
  listReportsFiltered,
  countReportsFiltered,
  updateReportFields,
  updateReportState,
  writeReportImage,
  clearReportImage,
  isInFlight,
  isResolveEligible,
  blocksMilestoneConvergence,
  getDispatchedSessionsForReport,
} from './reportStore';
import type {
  InvestigationReportRow,
  ReportFilter,
  ReportDispatchedSession,
} from './reportStore';
import {
  resolveMilestoneRowForProject,
  resolveMilestoneRowAnyProject,
} from '../projects/milestoneResolver';

/**
 * Business logic for investigation_report — the state-machine guards and
 * the derived-field reads routes/reportState.ts exposes. Mirrors
 * gateService.ts's split: routes only parse the request and translate
 * errors to status codes, this module owns the rules.
 */

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/** Decoded-image size cap — enforced here, independent of the request body's JSON size limit. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_DATA_URL_RE =
  /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.+)$/i;

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * Decodes a screenshot field into image bytes + a file extension. Accepts
 * either a bare base64 string (assumed image/png, the common screenshot
 * case) or a `data:<mime>;base64,<data>` URL, the shape browsers produce
 * from canvas.toDataURL()/FileReader — carrying its own mime type alongside
 * the bytes rather than requiring a second request field. Throws naming the
 * 8 MB cap explicitly when the decoded payload exceeds it, so the caller's
 * error message is never a generic body-parser rejection.
 */
function decodeImageField(raw: string): { bytes: Buffer; extension: string } {
  const match = IMAGE_DATA_URL_RE.exec(raw);
  const base64Data = match ? match[2] : raw;
  const mimeType = match ? match[1].toLowerCase() : 'image/png';
  const bytes = Buffer.from(base64Data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `image exceeds the 8 MB size cap (decoded image is ${bytes.length} bytes)`,
    );
  }
  return { bytes, extension: IMAGE_EXTENSION_BY_MIME_TYPE[mimeType] ?? '.png' };
}

export interface InvestigationReportWithDerived extends InvestigationReportRow {
  inFlight: boolean;
  resolveEligible: boolean;
  /** Every session ever dispatched for this report, most recent first — powers the report card's session-view affordance. */
  dispatchedSessions: ReportDispatchedSession[];
}

/**
 * Resolves an inbound milestone reference (display name, board name, or
 * already-canonical UUID) to the milestones.id UUID key space that
 * investigation_report.milestone_id is stored in — matching
 * flow_arm.milestone_id, per the design's write-path lock. Throws
 * UnknownMilestoneError for anything unresolvable rather than persisting an
 * unresolved value; an empty/blank input is left as-is (the "no milestone
 * yet" draft-time sentinel).
 */
function resolveMilestoneIdForWrite(
  projectId: string,
  milestoneId: string,
): string {
  if (!milestoneId.trim()) {
    return milestoneId;
  }
  return resolveMilestoneRowForProject(projectId, milestoneId).id;
}

function withDerived(
  row: InvestigationReportRow,
): InvestigationReportWithDerived {
  return {
    ...row,
    inFlight: isInFlight(row.id),
    resolveEligible: isResolveEligible(row.id),
    dispatchedSessions: getDispatchedSessionsForReport(row.id),
  };
}

export interface CreateReportInput {
  projectId: string;
  milestoneId?: string;
  title: string;
  /** Optional at draft time — defaults to '' (the NOT NULL column still has a value). */
  symptomText?: string;
  evidenceText?: string;
  source?: 'operator' | 'session';
  originSessionId?: string;
  originTaskId?: string;
  /** Base64 screenshot — bare base64 (assumed PNG) or a data:<mime>;base64,<data> URL. Decoded and size-capped at 8 MB. */
  image?: string;
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
  const decodedImage =
    input.image !== undefined ? decodeImageField(input.image) : undefined;
  const now = new Date().toISOString();
  let row = insertReport({
    projectId: input.projectId,
    milestoneId: resolveMilestoneIdForWrite(
      input.projectId,
      input.milestoneId ?? '',
    ),
    title: input.title,
    symptomText: input.symptomText ?? '',
    evidenceText: input.evidenceText,
    source: input.source,
    originSessionId: input.originSessionId,
    originTaskId: input.originTaskId,
    createdAt: now,
  });
  if (decodedImage) {
    row = writeReportImage(row.id, decodedImage.bytes, decodedImage.extension, now);
  }
  return withDerived(row);
}

export interface UpdateDraftReportInput {
  title?: string;
  symptomText?: string;
  evidenceText?: string | null;
  milestoneId?: string;
  /** Base64 screenshot to replace the current one, or null to clear it. Undefined leaves it untouched. */
  image?: string | null;
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
  const decodedImage =
    typeof fields.image === 'string' ? decodeImageField(fields.image) : undefined;
  const { image: _image, ...textFields } = fields;
  const resolvedFields: UpdateDraftReportInput = { ...textFields };
  if (fields.milestoneId !== undefined) {
    resolvedFields.milestoneId = resolveMilestoneIdForWrite(
      existing.project_id,
      fields.milestoneId,
    );
  }
  const now = new Date().toISOString();
  let row = updateReportFields(id, resolvedFields, now);
  if (decodedImage) {
    row = writeReportImage(id, decodedImage.bytes, decodedImage.extension, now);
  } else if (fields.image === null) {
    row = clearReportImage(id, now);
  }
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
  const resolvedMilestoneId = options.milestone
    ? options.project
      ? resolveMilestoneRowForProject(options.project, options.milestone).id
      : resolveMilestoneRowAnyProject(options.milestone).id
    : undefined;
  const filter: ReportFilter = {
    projectId: options.project,
    milestoneId: resolvedMilestoneId,
    state: options.state,
  };
  const items = listReportsFiltered(filter, limit, offset).map(withDerived);
  const total = countReportsFiltered(filter);
  return { items, total, page };
}
