import { apiRequest } from './projects';

export type GateItemClassification =
  | 'Read-Only'
  | 'Prod-Mutating'
  | 'Opportunistic'
  | 'Human-Observation'
  | 'needs-triage';

interface GateItemSource {
  sourceTaskId: string;
  sourceTaskTitle: string;
  mergeCommit?: string;
  addedAt: string;
}

/**
 * The common shape seen in practice: a downgrade (e.g. pass -> needs-setup)
 * carries `reason` plus the originally-reported evidence under
 * `reportedEvidence` (or `verifierEvidence` for the max-fix-attempts path);
 * an un-downgraded verify result carries its evidence fields directly
 * (e.g. `basis`, `note`). Kept loose since the verifier's evidence payload
 * is otherwise free-form.
 */
interface GateItemEvidenceObject {
  reason?: string;
  reportedEvidence?: unknown;
  verifierEvidence?: unknown;
  basis?: string | string[];
  note?: string;
  error?: string;
  attempts?: number;
  [key: string]: unknown;
}

/**
 * The verifier's evidence payload can also arrive as a plain string —
 * long-form prose rationale rather than a structured verdict.
 */
export type GateItemEvidence = string | GateItemEvidenceObject;

interface GateItemEvent {
  disposition: string;
  evidence?: GateItemEvidence;
  filedFollowon?: string;
  deploySha?: string;
  operator?: string;
  at: string;
}

export interface GateItem {
  id: string;
  project: string;
  milestone: string;
  text: string;
  classification: GateItemClassification;
  minDeployedCommit?: string;
  state: string;
  currentDisposition?: string;
  updatedAt: string;
  sources: GateItemSource[];
  events: GateItemEvent[];
}

export interface GateItemDetail {
  item: Omit<GateItem, 'sources' | 'events'>;
  sources: GateItemSource[];
  events: GateItemEvent[];
}

interface GateBlockingItem {
  id: string;
  project: string;
  milestone: string;
  text: string;
  classification: GateItemClassification;
  state: string;
}

export interface GateReadiness {
  status: 'green' | 'blocked';
  blocking: GateBlockingItem[];
  /** The milestone's full per-state item totals, independent of any table filter. */
  counts: Record<string, number>;
}

export interface MilestoneReadiness {
  project: string;
  milestone: string;
  status: 'green' | 'blocked';
  blockingCount: number;
}

export interface ListGateItemsParams {
  project?: string;
  milestone?: string;
  state?: string;
  classification?: GateItemClassification;
  runnable?: boolean;
  page?: number;
  limit?: number;
  order?: 'not-done-first';
}

export interface ListGateItemsResult {
  items: GateItem[];
  total: number;
  page: number;
}

export interface GateVerifyDispatchResult {
  dispatched: string[];
  skipped: { itemId: string; reason: string }[];
}

export interface RecordGateItemEventInput {
  disposition: string;
  evidence?: GateItemEvidence;
  filedFollowon?: string;
  deploySha?: string;
  operator?: string;
}

export interface ReopenGateItemInput {
  operator?: string;
  reason?: string;
}

export interface ApproveGateItemInput {
  operator?: string;
}

export interface GateItemVerifySession {
  itemId: string;
  sessionId: string;
  sessionStatus: string;
  startedAt: number;
  endedAt: number | null;
}

function buildQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const gateApi = {
  getGateReadiness(milestone: string): Promise<GateReadiness> {
    return apiRequest<GateReadiness>(
      `/api/gate/readiness${buildQuery({ milestone })}`,
    );
  },

  listMilestoneReadiness(project?: string): Promise<MilestoneReadiness[]> {
    return apiRequest<MilestoneReadiness[]>(
      `/api/gate/milestones/readiness${buildQuery({ project })}`,
    );
  },

  listGateItems(
    params: ListGateItemsParams = {},
  ): Promise<ListGateItemsResult> {
    return apiRequest<ListGateItemsResult>(
      `/api/gate/items${buildQuery(params)}`,
    );
  },

  getGateItemDetail(id: string): Promise<GateItemDetail> {
    return apiRequest<GateItemDetail>(
      `/api/gate/items/${encodeURIComponent(id)}/detail`,
    );
  },

  /** The verify sessions dispatched for a gate item, most recent first. */
  getVerifySessions(id: string): Promise<GateItemVerifySession[]> {
    return apiRequest<GateItemVerifySession[]>(
      `/api/gate/items/${encodeURIComponent(id)}/verify-sessions`,
    );
  },

  /** The manual verify-item/verify-batch dispatch (the Verify(N) launcher). */
  dispatchVerification(itemIds: string[]): Promise<GateVerifyDispatchResult> {
    return apiRequest<GateVerifyDispatchResult>('/api/gate/verify-launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds }),
    });
  },

  /** Records an operator disposition (pass/fail/deferred/…) against a gate item. */
  recordEvent(id: string, input: RecordGateItemEventInput): Promise<GateItem> {
    return apiRequest<GateItem>(
      `/api/gate/items/${encodeURIComponent(id)}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
  },

  /** Reopens a resolved (pass/fail/deferred) gate item back to `open`. */
  reopenItem(id: string, input: ReopenGateItemInput = {}): Promise<GateItem> {
    return apiRequest<GateItem>(
      `/api/gate/items/${encodeURIComponent(id)}/reopen`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
  },

  /** Approves a pending-approval (Prod-Mutating) gate item, releasing it to pass. */
  approveItem(id: string, input: ApproveGateItemInput = {}): Promise<GateItem> {
    return apiRequest<GateItem>(
      `/api/gate/items/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
  },
};
