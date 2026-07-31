import { apiRequest } from './projects';

/**
 * A pending staged intent produced by a general command/stage surface (e.g.
 * Groom(N), Ops(N)). `kind` discriminates how `payload` is rendered and how
 * apply is dispatched server-side through TaskWriteCommands — the frontend
 * never interprets payload itself, it only displays and forwards it.
 */
interface StagedIntentViolation {
  tier: 'structural' | 'lexical';
  detail: string;
  location: string;
}

interface StagedIntentAdvisory {
  tier: 'semantic';
  status: 'pending' | 'clean' | 'flagged' | 'errored';
  confidence: number;
  findings: { detail: string; location?: string; quote?: string }[];
  model: string;
  checkedAt: number;
}

/**
 * The /groom skill's structured per-task proposal (presentation.md's 4/5-point
 * summary), carried by a dispatched groom session's Ready-flip decision in
 * place of a free-prose `decisionProposal`.
 */
export interface GroomProposalFields {
  achieves: string;
  openQuestions: string;
  automatedTests: string;
  manualVerification: string;
  operationalSeed: string;
}

type StagedIntentState =
  | 'staged'
  | 'pending_verification'
  | 'needs_revision'
  | 'approved'
  | 'committed'
  | 'rejected'
  | 'superseded'
  /** The staging session itself withdrew this intent before an operator disposed of it — see `dispositionReason` for why. */
  | 'withdrawn';

export interface StagedIntent {
  id: string;
  kind: string;
  payload: unknown;
  projectId: string;
  createdAt: number;
  /** The originating session, for panel correlation + pushback routing. Null for human-staged intents. */
  sessionId?: string | null;
  /**
   * Whether the originating session has signaled its proposal set for the
   * current turn is complete. False while the session may still stage more
   * intents this turn — disposition controls must stay disabled and the
   * milestone inbox must suppress the card until this flips true. Undefined/
   * null (human-staged intents, or rows predating this signal) is treated as
   * complete.
   */
  sessionComplete?: boolean | null;
  /** Current lifecycle state. */
  state?: StagedIntentState;
  /** Pointer to the intent this one replaces, if any. */
  supersedes?: string | null;
  /** Correlates intents that form one structural-change unit (e.g. a split). */
  groupId?: string | null;
  /** The milestone (canonical_short_id) this intent's target task belongs to. Null = unattributed (legacy row or unresolvable task) — the milestone decision-inbox lens's UNATTRIBUTED_MILESTONE_BUCKET. */
  milestone?: string | null;
  /** The human-facing rationale/summary the decision surface renders beside the payload. */
  decisionProposal?: string | null;
  /** The /groom skill's structured proposal fields — see `GroomProposalFields`. */
  groomProposal?: GroomProposalFields | null;
  /**
   * Set when the last apply attempt was hard-blocked by the readiness gate
   * (violations) or the grooming promotion gate (reasons) — the blocking
   * register. Structurally distinct from `advisory` (the caution register).
   */
  annotation?:
    | { blocked: true; violations: StagedIntentViolation[] }
    | { blocked: true; reasons: string[] }
    | null;
  /**
   * Tier-3 semantic readiness advisory — a caution signal (confidence +
   * findings) distinct from `annotation`'s deterministic hard-block channel.
   * Never rendered as a hard block.
   */
  advisory?: StagedIntentAdvisory | null;
  /** Operator-supplied rationale for a reject disposition (pushback | decline), or the staging session's own rationale for a withdrawal. Null until rejected or withdrawn. */
  dispositionReason?: string | null;
  /** The operator's answer to a decision.pickOne question-intent. Null until answered. */
  answer?: StagedIntentAnswer | null;
  /**
   * Derived per-session completeness: true once the owning session has
   * staged something since its last stop and its turn has ended. False
   * while a turn is in flight or a wake reverted the session to incomplete
   * — apply/reject/commit are refused server-side while false. Null for
   * human-staged intents (no owning session to gate on).
   */
  sessionComplete?: boolean | null;
}

/** The two explicit operator-chosen outcomes for a reject disposition. */
export type StagedIntentRejectOutcome = 'pushback' | 'decline';

/** A single candidate the operator can pick for a decision.pickOne question-intent. */
interface DecisionPickOneOption {
  label: string;
  description: string;
}

/** Payload for the decision.pickOne question-intent kind. */
export interface DecisionPickOnePayload {
  prompt: string;
  options: DecisionPickOneOption[];
  allowFreeForm: boolean;
}

/** The operator's response to a decision.pickOne question-intent. At least one of chosenLabel or freeForm is present. */
interface StagedIntentAnswer {
  chosenLabel: string | null;
  freeForm: string | null;
}

export interface ApplyOptions {
  /** Overrides a blocked-with-reason intent — requires a non-empty reason. */
  override?: boolean;
  reason?: string;
}

/** Mirrors the backend's UNATTRIBUTED_MILESTONE_BUCKET (db/queries.ts) — the ?milestone lens value for legacy/unresolvable rows. */
export const UNATTRIBUTED_MILESTONE_BUCKET = 'unattributed';

export const stagedIntentsApi = {
  list(projectId?: string): Promise<StagedIntent[]> {
    const query = projectId
      ? `?projectId=${encodeURIComponent(projectId)}`
      : '';
    return apiRequest<{ intents: StagedIntent[] }>(
      `/api/staged-intents${query}`,
    ).then((res) => res.intents);
  },

  /** Proposals correlated to the originating session — the SessionPanel decision panel's lens. */
  listBySession(sessionId: string): Promise<StagedIntent[]> {
    return apiRequest<{ intents: StagedIntent[] }>(
      `/api/staged-intents?sessionId=${encodeURIComponent(sessionId)}`,
    ).then((res) => res.intents);
  },

  /**
   * The milestone decision-inbox lens: every staged decision attributed to
   * the milestone (or the UNATTRIBUTED_MILESTONE_BUCKET), ordered by the
   * backend's unblock-impact convergence-ranking (see decisionRanking.ts) —
   * the frontend renders this order as-is rather than re-sorting.
   */
  listByMilestone(
    projectId: string,
    milestone: string,
  ): Promise<StagedIntent[]> {
    return apiRequest<{ intents: StagedIntent[] }>(
      `/api/staged-intents?projectId=${encodeURIComponent(projectId)}&milestone=${encodeURIComponent(milestone)}`,
    ).then((res) => res.intents);
  },

  stage(
    kind: string,
    payload: unknown,
    projectId: string,
    groupId?: string,
  ): Promise<StagedIntent> {
    return apiRequest<StagedIntent>('/api/staged-intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, payload, projectId, groupId }),
    });
  },

  apply(
    id: string,
    options?: ApplyOptions,
  ): Promise<{ ok: boolean; result: unknown }> {
    return apiRequest<{ ok: boolean; result: unknown }>(
      `/api/staged-intents/${encodeURIComponent(id)}/apply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          override: options?.override ?? false,
          reason: options?.reason ?? '',
        }),
      },
    );
  },

  approve(id: string): Promise<StagedIntent> {
    return apiRequest<StagedIntent>(
      `/api/staged-intents/${encodeURIComponent(id)}/approve`,
      { method: 'POST' },
    );
  },

  /**
   * planning.noOp's sole disposition: commits the marker straight to
   * `committed` with no applyIntent call (there is nothing to apply) — the
   * operator's "understood" for an informational no-op notice.
   */
  acknowledge(id: string): Promise<StagedIntent> {
    return apiRequest<StagedIntent>(
      `/api/staged-intents/${encodeURIComponent(id)}/acknowledge`,
      { method: 'POST' },
    );
  },

  /** Atomic, dependency-ordered commit of every live intent in the group. */
  commitGroup(
    groupId: string,
    options?: ApplyOptions,
  ): Promise<{ ok: boolean; committed: string[] }> {
    return apiRequest<{ ok: boolean; committed: string[] }>(
      `/api/staged-intents/group/${encodeURIComponent(groupId)}/commit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          override: options?.override ?? false,
          reason: options?.reason ?? '',
        }),
      },
    );
  },

  /**
   * The single atomic-approval-unit surface: approves and commits every live
   * intent in the group in one operator action — no per-item approve needed
   * first. A grooming outcome is one decision, not N independently-committing
   * writes; a group whose arming Ready intent fails its gate commits none of
   * its members.
   */
  approveGroup(
    groupId: string,
    options?: ApplyOptions,
  ): Promise<{ ok: boolean; committed: string[] }> {
    return apiRequest<{ ok: boolean; committed: string[] }>(
      `/api/staged-intents/group/${encodeURIComponent(groupId)}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          override: options?.override ?? false,
          reason: options?.reason ?? '',
        }),
      },
    );
  },

  /**
   * Diagnostic full-group read: every intent ever staged for the group,
   * regardless of state — including already-committed siblings and any
   * blocked (needs_revision/pending_verification) member — so a
   * partially-applied group can be rendered as such instead of reading as
   * an orphaned status-only intent.
   */
  listGroup(
    groupId: string,
  ): Promise<{ groupId: string; intents: StagedIntent[]; wedged: boolean }> {
    return apiRequest<{
      groupId: string;
      intents: StagedIntent[];
      wedged: boolean;
    }>(`/api/staged-intents/group/${encodeURIComponent(groupId)}`);
  },

  /**
   * The group-level twin of `approveGroup`: pushback | decline the whole
   * grooming decision as one unit — every live intent in the group is
   * rejected with the same outcome + reason, none of them committed.
   */
  rejectGroup(
    groupId: string,
    disposition: { outcome: StagedIntentRejectOutcome; reason: string },
  ): Promise<{ ok: boolean; rejected: string[] }> {
    return apiRequest<{ ok: boolean; rejected: string[] }>(
      `/api/staged-intents/group/${encodeURIComponent(groupId)}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(disposition),
      },
    );
  },

  /**
   * The approve-by-standard decision surface: commits a default-approved
   * clean set spanning multiple task groups from one triaged interactive-type
   * batch, on a single operator disposition. Each named group still commits
   * individually server-side (its own per-task readiness_override + audit
   * event) — a group whose apply fails its server-side gate is reported back
   * as an exception rather than aborting the rest.
   */
  commitBatch(
    groupIds: string[],
    milestoneLabel?: string,
  ): Promise<{
    ok: boolean;
    committed: string[];
    exceptions: { groupId: string; status: number; error: string }[];
  }> {
    return apiRequest<{
      ok: boolean;
      committed: string[];
      exceptions: { groupId: string; status: number; error: string }[];
    }>('/api/staged-intents/batch/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds, milestoneLabel }),
    });
  },

  /**
   * `pushback` re-turns the originating session to revise and re-emit;
   * `decline` is terminal. Both require a non-empty reason.
   */
  reject(
    id: string,
    disposition: { outcome: StagedIntentRejectOutcome; reason: string },
  ): Promise<{ ok: boolean }> {
    return apiRequest<{ ok: boolean }>(
      `/api/staged-intents/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(disposition),
      },
    );
  },

  /** Resolves a decision.pickOne question-intent with the operator's choice. */
  answer(
    id: string,
    response: { chosenLabel: string | null; freeForm?: string },
  ): Promise<{ ok: boolean; intent: StagedIntent }> {
    return apiRequest<{ ok: boolean; intent: StagedIntent }>(
      `/api/staged-intents/${encodeURIComponent(id)}/answer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chosenLabel: response.chosenLabel,
          freeForm: response.freeForm ?? '',
        }),
      },
    );
  },

  /** Read-only fetch of a task's stored spec body, used to diff against a proposed task.updateBody. */
  fetchTaskPage(taskId: string, projectId: string): Promise<string> {
    return apiRequest<{ markdown: string }>(
      `/api/tasks/${encodeURIComponent(taskId)}/page?projectId=${encodeURIComponent(projectId)}`,
    ).then((res) => res.markdown);
  },
};
