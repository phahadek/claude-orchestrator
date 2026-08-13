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
  | 'autofix_tool_infra_failure'
  | 'workflow_scope_denied'
  | 'resume_failed'
  | 'review_rules_escalation'
  | 'baseline_escalation_floor'
  | 'depth_review_escalation'
  | 'depth_review_pending'
  | 'planning_crashed'
  | 'planning_first_turn_empty'
  | 'planning_terminal_no_decision'
  | 'planning_terminal_blocked_members'
  | 'ops_terminal_group_incomplete'
  | 'ops_journal_terminal_incomplete'
  | 'usage_limit_deferred'
  | 'api_overloaded_exhausted'
  | 'manual_verification_pending'
  | 'test_request_cycle_exceeded'
  | 'test_report_acquisition_failed';

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
    // Recovery is session-driven: a verified-flaky disposition from the
    // session actuates a same-commit gate re-run via the orchestrator
    // (rerunFailedJobs / F2 test-result invalidation) without human input.
    severity: 'needs_attention',
    retry_strategy: 'automatic',
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
    // Recovery is session-driven: a verified-flaky disposition from the
    // session actuates a same-commit analyze-stage re-run via the
    // orchestrator (rerunFlakyAnalyze) without human input, mirroring
    // ci_failing's automatic recovery path.
    severity: 'needs_attention',
    retry_strategy: 'automatic',
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
  autofix_tool_infra_failure: {
    source: 'autofix',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  workflow_scope_denied: {
    source: 'merge',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  resume_failed: {
    source: 'session',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  review_rules_escalation: {
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  // Code-enforced baseline floor (CI/workflow config, migrations, auth,
  // secrets) — always requires human sign-off regardless of review_rules, so
  // it is deliberately not marked automatic/none like other review reasons.
  baseline_escalation_floor: {
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  // The depth review pass's own escalation — distinct from
  // review_rules_escalation (the conformance pass's project-review_rules
  // escalation) and from the code-enforced baseline_escalation_floor
  // escalation above. Session-routing (enqueueFeedback), not this reason, is
  // the default outcome for a depth finding — including a
  // security/concurrency/reliability/data-integrity one — so the
  // implementing session gets a shot at fixing it. This reason is raised
  // only for the cases a human must adjudicate: the finding touches a
  // baseline-floor path (CI/workflow config, migrations, auth, secrets), the
  // PR has no linked session to route to, or the same finding has already
  // been routed MAX_DEPTH_REVIEW_ROUTE_ATTEMPTS times on an unchanged head
  // SHA without a fix landing. `detail` names which of these applied. A
  // floor finding on a PR that does have a session both escalates AND
  // routes (see ReviewOrchestrator's dispatchDepthReview) — this reason
  // doesn't mean the session was left uninformed, only that an operator was
  // also looped in.
  depth_review_escalation: {
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  // Holds auto-merge while the depth review pass is in flight, so a depth
  // finding can still gate the merge instead of only annotating an
  // already-merged PR. An in-flight pass is not an operator action item —
  // it clears itself (escalation, feedback-enqueue, or fail-open) within
  // dispatchDepthReview's timeout ceiling — so this is 'recoverable', not
  // 'needs_attention' like depth_review_escalation above.
  depth_review_pending: {
    source: 'review',
    severity: 'recoverable',
    retry_strategy: 'automatic',
  },
  planning_crashed: {
    source: 'session',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  planning_first_turn_empty: {
    source: 'session',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  planning_terminal_no_decision: {
    source: 'session',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  planning_terminal_blocked_members: {
    source: 'session',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  ops_terminal_group_incomplete: {
    source: 'session',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  ops_journal_terminal_incomplete: {
    source: 'session',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  // Distinct death reasons for the two external-roadblock conditions the
  // orchestrator now recognizes: a usage-limit deferral (five_hour/seven_day
  // exhausted — auto-recovers at the recorded resets_at) and an exhausted
  // 529/500 retry budget (transient but didn't recover within the bounded
  // backoff — needs a human to look). Both are clean parks, not crashes, so
  // they must be distinguishable from stalled_idle/a normal terminal park —
  // that's what made the pre-fix relaunch loop invisible.
  usage_limit_deferred: {
    source: 'session',
    severity: 'recoverable',
    retry_strategy: 'automatic',
  },
  api_overloaded_exhausted: {
    source: 'session',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  // Holds auto-merge on an AI-approved PR whose task's cached Type is not
  // 💻 Code, until an operator signs off on the manual-verification items.
  // No entry in RECOVERY_ACTION_MAP — cleared only via the dedicated
  // verify-manual-items route, matching awaiting_human_approval/max_reviews.
  manual_verification_pending: {
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  // The test.request lane's iterate-on-red bound (mirrors
  // flake_recovery_max_retries): a session's staged test.request count within
  // one session exceeded test_request_cycle_limit — the mechanical auto-grant
  // stops auto-running further requests and leaves this for an operator to
  // look at, rather than looping indefinitely. No RECOVERY_ACTION_MAP entry —
  // same as awaiting_human_approval/max_reviews, this needs a human look, not
  // a one-click redispatch/resume that would just resume the same loop.
  test_request_cycle_exceeded: {
    source: 'session',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  // The project declared test_report_glob but the test.request lane's
  // JUnit-XML acquisition/parser/normalizer left structured_result null —
  // a missing/malformed report or a run killed before teardown. This is a
  // manifest/config problem a human must fix (bad glob, harness not writing
  // the report, etc.); nothing auto-recovers it. Deliberately independent
  // of ci_failing: it never blocks mergeability when the underlying test
  // exit code passed — see PRMergeWatcher's own-branch handling.
  test_report_acquisition_failed: {
    source: 'tests',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
};

// ── Recovery descriptor ──────────────────────────────────────────────────────

type RecoveryAction = 'redispatch' | 'rerun' | 'resume';

export interface RecoveryDescriptor {
  available: boolean;
  action?: RecoveryAction;
  label?: string;
}

const RECOVERY_ACTION_MAP: Partial<
  Record<CanonicalPauseReason, RecoveryAction>
> = {
  // redispatch: clear pause + reset crash count + set Ready
  launch_failed: 'redispatch',
  needs_repo: 'redispatch',
  stalled_idle: 'redispatch',
  resume_failed: 'redispatch',
  // rerun: clear pause + re-run the pre-review pipeline
  autofix_git_infra_failure: 'rerun',
  autofix_tool_infra_failure: 'rerun',
  ci_billing_blocked: 'rerun',
  stalled_reconcile_cap: 'rerun',
  auto_merge_failed: 'rerun',
  // resume: sendOrResume + nudge
  review_failed: 'resume',
  human_changes_requested: 'resume',
  ci_failing: 'resume',
  analyze_failing: 'resume',
  merge_conflict: 'resume',
  diverged_branch: 'resume',
  pr_body_invalid: 'resume',
  attribution_missing: 'resume',
  audit_findings: 'resume',
  // awaiting_human_approval, max_reviews → available: false (omitted from map)
};

const RECOVERY_LABELS: Record<RecoveryAction, string> = {
  redispatch: 'Redispatch',
  rerun: 'Rerun',
  resume: 'Resume',
};

export function deriveRecoveryDescriptor(
  reason: CanonicalPauseReason | null | undefined,
): RecoveryDescriptor {
  if (reason == null) return { available: false };
  const action = RECOVERY_ACTION_MAP[reason];
  if (action == null) return { available: false };
  return { available: true, action, label: RECOVERY_LABELS[action] };
}

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

/**
 * True while a 'needs_attention' + 'automatic' pause (ci_failing, analyze_failing
 * today) is still within its bounded automatic-recovery budget — the caller should
 * surface it as a lower-weight in-flight status instead of escalating to a human.
 * Does not touch 'recoverable' + 'automatic' reasons (stuck_timeout, api_overloaded,
 * rate_limit) — those keep surfacing as 'needs_attention' immediately, unchanged.
 */
export function isAutomaticRecoveryPending(
  parsed:
    | Pick<PauseReasonStruct, 'severity' | 'retry_strategy'>
    | null
    | undefined,
  flakeRecoveryAttempts: number,
  flakeRecoveryMaxRetries: number,
): boolean {
  if (!parsed) return false;
  return (
    parsed.severity === 'needs_attention' &&
    parsed.retry_strategy === 'automatic' &&
    flakeRecoveryAttempts < flakeRecoveryMaxRetries
  );
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
