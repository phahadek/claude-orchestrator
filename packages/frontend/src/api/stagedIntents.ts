import { apiRequest } from './projects';

/**
 * A pending staged intent produced by a general command/stage surface (e.g.
 * Groom(N), Ops(N)). `kind` discriminates how `payload` is rendered and how
 * apply is dispatched server-side through TaskWriteCommands — the frontend
 * never interprets payload itself, it only displays and forwards it.
 */
export interface StagedIntentViolation {
  tier: 'structural' | 'lexical';
  detail: string;
  location: string;
}

export interface StagedIntentAdvisory {
  tier: 'semantic';
  status: 'pending' | 'clean' | 'flagged' | 'errored';
  confidence: number;
  findings: { detail: string; location?: string; quote?: string }[];
  model: string;
  checkedAt: number;
}

export type StagedIntentState =
  | 'staged'
  | 'approved'
  | 'committed'
  | 'rejected'
  | 'superseded';

export interface StagedIntent {
  id: string;
  kind: string;
  payload: unknown;
  projectId: string;
  createdAt: number;
  /** The originating session, for panel correlation + pushback routing. Null for human-staged intents. */
  sessionId?: string | null;
  /** Current lifecycle state. */
  state?: StagedIntentState;
  /** Pointer to the intent this one replaces, if any. */
  supersedes?: string | null;
  /** Correlates intents that form one structural-change unit (e.g. a split). */
  groupId?: string | null;
  /** The human-facing rationale/summary the decision surface renders beside the payload. */
  decisionProposal?: string | null;
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
}

export interface ApplyOptions {
  /** Overrides a blocked-with-reason intent — requires a non-empty reason. */
  override?: boolean;
  reason?: string;
}

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

  /** A non-empty `feedback` is a pushback (the session revises and re-stages); empty is a plain reject. */
  reject(id: string, feedback?: string): Promise<{ ok: boolean }> {
    return apiRequest<{ ok: boolean }>(
      `/api/staged-intents/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: feedback ?? '' }),
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
