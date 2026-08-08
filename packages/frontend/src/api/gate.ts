import { apiRequest } from './projects';
import type {
  FlowRejectionRateResult,
  TrustPrecisionFlow,
} from '@claude-orchestrator/backend/src/db/queries';

export type { FlowRejectionRateResult, TrustPrecisionFlow };

/** Mirrors the backend's TRUST_PRECISION_FLOWS (routes/gateState.ts) — the flows the /api/gate/trust-rate route accepts. */
export const TRUST_PRECISION_FLOWS: TrustPrecisionFlow[] = [
  'groom',
  'design',
  'ops',
  'gate-verify',
];

export type GateItemClassification =
  | 'Read-Only'
  | 'Prod-Mutating'
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
  /** The disposition on the item's most recent event, whether or not it advanced state — set even for a non-resolving abstain like needs-setup/noted. */
  latestDisposition?: string;
  updatedAt: string;
  sources: GateItemSource[];
  events: GateItemEvent[];
  /** True if this item currently has a non-terminal, unended verify session — set on the list read only. */
  verifyInFlight?: boolean;
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
  /** True when the item's latest event carries a non-resolving disposition (needs-setup/noted) — attempted but inconclusive. */
  nonResolving?: boolean;
}

export interface GateReadiness {
  status: 'green' | 'blocked';
  blocking: GateBlockingItem[];
  /** Items parked at `pending` (backoff-scheduled) — a sibling of `blocking`, never a subset of it, and never counted toward the green/blocked status. */
  parked: GateBlockingItem[];
  /** Subset of `blocking` whose latest disposition is non-resolving (needs-setup/noted). */
  nonResolvingItems: GateBlockingItem[];
  /** The milestone's full per-state item totals, independent of any table filter. */
  counts: Record<string, number>;
  /** Exact count of items whose latest_disposition is needs-setup — matches the awaitingSetup list filter's own semantics, not the wider nonResolvingItems (needs-setup ∪ noted) set. */
  awaitingSetupCount: number;
}

export interface MilestoneReadiness {
  project: string;
  milestone: string;
  status: 'green' | 'blocked';
  blockingCount: number;
  /** Items parked at `pending` — never counted toward blockingCount or the green/blocked status. */
  parkedCount: number;
}

export interface ListGateItemsParams {
  project?: string;
  milestone?: string;
  state?: string;
  classification?: GateItemClassification;
  runnable?: boolean;
  /** True: only items whose latest event is the needs-setup abstain. */
  awaitingSetup?: boolean;
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

export interface RejectGateItemInput {
  reason: string;
  operator?: string;
}

export interface ReclassifyGateItemInput {
  classification: GateItemClassification;
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
  getGateReadiness(project: string, milestone: string): Promise<GateReadiness> {
    return apiRequest<GateReadiness>(
      `/api/gate/readiness${buildQuery({ project, milestone })}`,
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

  /** Rejects a pending-approval (Prod-Mutating) gate item — withheld consent, recorded as a `fail` disposition with a mandatory reason. Leaves the item unresolved in the readiness rollup; reopenItem forms the loop back to re-verification. */
  rejectItem(id: string, input: RejectGateItemInput): Promise<GateItem> {
    return apiRequest<GateItem>(
      `/api/gate/items/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
  },

  /** The Milestone panel's trust-precision read: per-flow rejection/abstain rate. Informative only — no auto-disarm. */
  getFlowRejectionRate(
    project: string,
    milestone: string,
    flow: TrustPrecisionFlow,
  ): Promise<FlowRejectionRateResult> {
    return apiRequest<FlowRejectionRateResult>(
      `/api/gate/trust-rate${buildQuery({ project, milestone, flow })}`,
    );
  },

  /** Changes a gate item's classification tier. */
  reclassifyItem(
    id: string,
    input: ReclassifyGateItemInput,
  ): Promise<GateItem> {
    return apiRequest<GateItem>(
      `/api/gate/items/${encodeURIComponent(id)}/classification`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
  },
};
