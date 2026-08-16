import { apiRequest } from './projects';

/** Mirrors reportStore.ts's InvestigationReportState — no persisted 'dispatched' state; in-flight status is derived (see `inFlight` below). */
export type InvestigationReportState =
  | 'draft'
  | 'committed'
  | 'resolved'
  | 'abandoned';

export interface ReportDispatchedSession {
  sessionId: string;
  sessionStatus: string;
  dispatchedAt: string;
}

export interface InvestigationReport {
  id: string;
  project_id: string;
  milestone_id: string;
  title: string;
  symptom_text: string;
  evidence_text: string | null;
  state: InvestigationReportState;
  source: 'operator' | 'session';
  origin_session_id: string | null;
  origin_task_id: string | null;
  created_at: string;
  updated_at: string;
  /** True if any session ever dispatched for this report is currently non-terminal. */
  inFlight: boolean;
  /** True once at least one dispatched session has ended and every staged_intent it produced has reached a terminal disposition. */
  resolveEligible: boolean;
  /** Every session ever dispatched for this report, most recent first. */
  dispatchedSessions: ReportDispatchedSession[];
}

export interface ListReportsResult {
  items: InvestigationReport[];
  total: number;
  page: number;
}

export interface CreateReportInput {
  projectId: string;
  milestoneId?: string;
  title: string;
  symptomText: string;
  evidenceText?: string;
  source?: 'operator' | 'session';
}

export interface UpdateReportInput {
  title?: string;
  symptomText?: string;
  evidenceText?: string | null;
  milestoneId?: string;
}

/** Thin client over routes/reportState.ts — mirrors the api/gate.ts and api/stagedIntents.ts conventions. */
export const reportsApi = {
  list(params: {
    project?: string;
    milestone?: string;
    state?: string;
    page?: number;
    limit?: number;
  }): Promise<ListReportsResult> {
    const query = new URLSearchParams();
    if (params.project) query.set('project', params.project);
    if (params.milestone) query.set('milestone', params.milestone);
    if (params.state) query.set('state', params.state);
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    return apiRequest<ListReportsResult>(`/api/reports?${query.toString()}`);
  },

  create(input: CreateReportInput): Promise<InvestigationReport> {
    return apiRequest<InvestigationReport>('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  update(id: string, patch: UpdateReportInput): Promise<InvestigationReport> {
    return apiRequest<InvestigationReport>(
      `/api/reports/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
  },

  commit(id: string): Promise<InvestigationReport> {
    return apiRequest<InvestigationReport>(
      `/api/reports/${encodeURIComponent(id)}/commit`,
      { method: 'POST' },
    );
  },

  abandon(id: string): Promise<InvestigationReport> {
    return apiRequest<InvestigationReport>(
      `/api/reports/${encodeURIComponent(id)}/abandon`,
      { method: 'POST' },
    );
  },
};
