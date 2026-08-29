import type { FlowId } from '@claude-orchestrator/backend/src/orchestration/flowArm';
import { apiRequest } from './projects';

/** Effective per-flow arm state for a milestone, keyed by FlowId. */
export type FlowArmState = Record<
  FlowId,
  { armed: boolean; source: 'row' | 'default' }
>;

export const flowArmApi = {
  /** GET /api/milestones/:milestoneId/arm — effective per-flow state. */
  get(milestoneId: string): Promise<FlowArmState> {
    return apiRequest<FlowArmState>(
      `/api/milestones/${encodeURIComponent(milestoneId)}/arm`,
    );
  },

  /** PUT /api/milestones/:milestoneId/arm/:flow — set the arm state for one flow. */
  set(
    milestoneId: string,
    flow: FlowId,
    armed: boolean,
  ): Promise<{ milestoneId: string; flow: FlowId; armed: boolean }> {
    return apiRequest<{ milestoneId: string; flow: FlowId; armed: boolean }>(
      `/api/milestones/${encodeURIComponent(milestoneId)}/arm/${encodeURIComponent(flow)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed }),
      },
    );
  },
};

/** Gate-verify auto-commit policy state, keyed by disposition-class — the key set is server-defined, never hardcoded on the frontend. */
export type GateVerifyPolicyState = Record<string, { armed: boolean }>;

export const gateVerifyPolicyApi = {
  /** GET /api/milestones/:milestoneId/auto-commit-policy — effective per-disposition-class policy. */
  get(milestoneId: string): Promise<GateVerifyPolicyState> {
    return apiRequest<GateVerifyPolicyState>(
      `/api/milestones/${encodeURIComponent(milestoneId)}/auto-commit-policy`,
    );
  },

  /** PUT /api/milestones/:milestoneId/auto-commit-policy/:dispositionClass — set the auto-commit policy for one disposition class. */
  set(
    milestoneId: string,
    dispositionClass: string,
    armed: boolean,
  ): Promise<{
    milestoneId: string;
    dispositionClass: string;
    armed: boolean;
  }> {
    return apiRequest<{
      milestoneId: string;
      dispositionClass: string;
      armed: boolean;
    }>(
      `/api/milestones/${encodeURIComponent(milestoneId)}/auto-commit-policy/${encodeURIComponent(dispositionClass)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed }),
      },
    );
  },
};
