type PauseSource =
  | 'autofix'
  | 'verify'
  | 'analyze'
  | 'tests'
  | 'ci'
  | 'review'
  | 'merge'
  | 'notion'
  | 'launch'
  | 'session';

type PauseSeverity = 'recoverable' | 'needs_attention' | 'terminal';
type PauseRetryStrategy = 'automatic' | 'manual_action' | 'none';

export type CanonicalPauseReason =
  | 'max_reviews'
  | 'stuck_timeout'
  | 'ci_failing'
  | 'ci_billing_blocked'
  | 'auto_merge_failed'
  | 'pr_closed'
  | 'review_failed'
  | 'api_overloaded'
  | 'merge_conflict'
  | 'awaiting_human_approval'
  | 'human_changes_requested'
  | 'pr_body_invalid'
  | 'attribution_missing'
  | 'audit_findings'
  | 'pr_creation_failed'
  | 'stalled_idle'
  | 'notion_done_update_stuck'
  | 'launch_failed'
  | 'diverged_branch'
  | 'diverged_branch_unresolved'
  | 'analyze_failing'
  | 'rate_limit'
  | 'stalled_reconcile_cap'
  | 'needs_repo'
  | 'autofix_git_infra_failure'
  | 'workflow_scope_denied';

export interface PauseReasonStruct {
  reason: CanonicalPauseReason;
  source: PauseSource;
  severity: PauseSeverity;
  retry_strategy: PauseRetryStrategy;
  detail?: string;
}

type RegistryEntry = {
  source: PauseSource;
  severity: PauseSeverity;
  retry_strategy: PauseRetryStrategy;
};

export const PAUSE_REASON_REGISTRY: Record<
  CanonicalPauseReason,
  RegistryEntry
> = {
  max_reviews: {
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'none',
  },
  stuck_timeout: {
    source: 'session',
    severity: 'recoverable',
    retry_strategy: 'automatic',
  },
  ci_failing: {
    source: 'ci',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  ci_billing_blocked: {
    source: 'ci',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  auto_merge_failed: {
    source: 'merge',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  pr_closed: { source: 'merge', severity: 'terminal', retry_strategy: 'none' },
  review_failed: {
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  api_overloaded: {
    source: 'session',
    severity: 'recoverable',
    retry_strategy: 'automatic',
  },
  merge_conflict: {
    source: 'merge',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  awaiting_human_approval: {
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  human_changes_requested: {
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  pr_body_invalid: {
    source: 'verify',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  attribution_missing: {
    source: 'verify',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  audit_findings: {
    source: 'verify',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  pr_creation_failed: {
    source: 'merge',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  stalled_idle: {
    source: 'session',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  notion_done_update_stuck: {
    source: 'notion',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  launch_failed: {
    source: 'launch',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  diverged_branch: {
    source: 'merge',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  diverged_branch_unresolved: {
    source: 'merge',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  analyze_failing: {
    source: 'analyze',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  rate_limit: {
    source: 'session',
    severity: 'recoverable',
    retry_strategy: 'automatic',
  },
  stalled_reconcile_cap: {
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  needs_repo: {
    source: 'launch',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  autofix_git_infra_failure: {
    source: 'autofix',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  workflow_scope_denied: {
    source: 'merge',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
};

const CANONICAL_SET = new Set<string>(Object.keys(PAUSE_REASON_REGISTRY));

const UNKNOWN_FALLBACK: RegistryEntry = {
  source: 'session',
  severity: 'needs_attention',
  retry_strategy: 'manual_action',
};

export function pauseReasonFromCanonical(
  reason: CanonicalPauseReason,
  detail?: string,
): PauseReasonStruct {
  const entry = PAUSE_REASON_REGISTRY[reason];
  const struct: PauseReasonStruct = { reason, ...entry };
  if (detail !== undefined) struct.detail = detail;
  return struct;
}

export function serializePauseReason(struct: PauseReasonStruct): string {
  return JSON.stringify(struct);
}

export function parsePauseReason(raw: string | null): PauseReasonStruct | null {
  if (raw === null || raw === '') return null;

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof parsed.reason === 'string' &&
        typeof parsed.source === 'string' &&
        typeof parsed.severity === 'string' &&
        typeof parsed.retry_strategy === 'string'
      ) {
        return parsed as unknown as PauseReasonStruct;
      }
    } catch {
      // fall through to legacy handling
    }
  }

  if (CANONICAL_SET.has(raw)) {
    return pauseReasonFromCanonical(raw as CanonicalPauseReason);
  }

  console.warn(
    `[pauseReason] Unknown pause reason: "${raw}", using safe default`,
  );
  return { reason: raw as CanonicalPauseReason, ...UNKNOWN_FALLBACK };
}
