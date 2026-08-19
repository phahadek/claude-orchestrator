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
  | 'base_branch_broken'
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
  | 'test_report_acquisition_failed'
  | 'ci_not_completing'
  | 'mcp_unreachable_exhausted';

export interface PauseReasonStruct {
  reason: CanonicalPauseReason;
  source: PauseSource;
  severity: PauseSeverity;
  retry_strategy: PauseRetryStrategy;
  /**
   * Whether this pause should block AutoMerger from merging the PR. Absent
   * (undefined) on a registry entry means true — fail-closed, so a reason
   * that hasn't been explicitly classified never silently becomes advisory.
   * Only set false for a reason deliberately designed to be non-blocking.
   */
  blocks_merge: boolean;
  detail?: string;
}

type RegistryEntry = {
  source: PauseSource;
  severity: PauseSeverity;
  retry_strategy: PauseRetryStrategy;
  /** See PauseReasonStruct.blocks_merge. Omit to default to true (blocking). */
  blocks_merge?: boolean;
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
  // Base branch itself is broken at a whole-suite/build level (total_fail —
  // no per-test breakdown, e.g. a crash or OOM-kill before any report was
  // written). Clears itself the moment a subsequent base-health check comes
  // back clean/partial — never requires a human, unlike launch_failed above.
  base_branch_broken: {
    source: 'launch',
    severity: 'recoverable',
    retry_strategy: 'automatic',
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
    blocks_merge: false,
  },
  // AutoMerger's per-PR loop hit its deadline (ci_poll_max_minutes) without
  // CI ever actually reporting failure — still running/pending/unknown. This
  // is advisory only: the scheduled sweep (register()'s poll job) keeps
  // re-attempting on its own interval and merges automatically once the PR
  // goes clean, or this pause is superseded by a genuine ci_failing pause if
  // CI subsequently fails for real. No RECOVERY_ACTION_MAP entry — same as
  // test_report_acquisition_failed/awaiting_human_approval, there is nothing
  // for an operator to click.
  ci_not_completing: {
    source: 'ci',
    severity: 'needs_attention',
    retry_strategy: 'automatic',
    blocks_merge: false,
  },
  // SessionManager.reconcileMcpUnreachableSessions exhausted its bounded
  // respawn budget (MAX_MCP_UNREACHABLE_RESPAWNS) for a session whose CLI's
  // MCP client never connected to the orchestrator server across every
  // attempt. Not auto-recoverable — an operator has to decide whether to
  // keep retrying by hand or abandon the session — so, like
  // test_request_cycle_exceeded/awaiting_human_approval, there is no
  // RECOVERY_ACTION_MAP entry.
  mcp_unreachable_exhausted: {
    source: 'session',
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

export interface TaskRecoveryContext {
  /** task_pause_reasons row for this task, if any. Preferred over prReason — the more specific signal. */
  taskReason: CanonicalPauseReason | null;
  /** PR-side (pull_requests.pause_reason) or session pr-creation-failure reason, if any. */
  prReason: CanonicalPauseReason | null;
  /** Whether this task currently has a PR. */
  hasPR: boolean;
  /** Whether the task's most recent code session ended in a terminal status (done/error/killed). */
  sessionTerminal: boolean;
}

/**
 * Task-level entry point for recovery derivation: routes task_pause_reasons
 * into deriveRecoveryDescriptor alongside the existing PR-side reason
 * (task-level wins when both are present), and — only when no reason of
 * either kind exists — falls back to redispatch for an orphaned task (no PR,
 * terminal session). That fallback bypasses RECOVERY_ACTION_MAP entirely
 * since there is no reason to look up; it must never be used to override a
 * reason that IS present but deliberately unmapped (e.g. awaiting_human_approval).
 */
export function deriveTaskRecoveryDescriptor(
  ctx: TaskRecoveryContext,
): RecoveryDescriptor {
  const effectiveReason = ctx.taskReason ?? ctx.prReason ?? null;
  if (effectiveReason != null) {
    return deriveRecoveryDescriptor(effectiveReason);
  }
  if (!ctx.hasPR && ctx.sessionTerminal) {
    return {
      available: true,
      action: 'redispatch',
      label: RECOVERY_LABELS.redispatch,
    };
  }
  return { available: false };
}

const CANONICAL_SET = new Set<string>(Object.keys(PAUSE_REASON_REGISTRY));

const UNKNOWN_FALLBACK: Required<RegistryEntry> = {
  source: 'session',
  severity: 'needs_attention',
  retry_strategy: 'manual_action',
  blocks_merge: true,
};

export function pauseReasonFromCanonical(
  reason: CanonicalPauseReason,
  detail?: string,
): PauseReasonStruct {
  const entry = PAUSE_REASON_REGISTRY[reason];
  const struct: PauseReasonStruct = {
    reason,
    ...entry,
    blocks_merge: entry.blocks_merge !== false,
  };
  if (detail !== undefined) struct.detail = detail;
  return struct;
}

/**
 * Whether a stored pause_reason should block AutoMerger from merging the PR.
 * Consults the reason's classification (blocks_merge), not merely whether a
 * pause is present — an advisory pause (e.g. test_report_acquisition_failed)
 * must not halt a merge whose underlying tests passed. Fails closed: no
 * pause blocks nothing (returns false), but any pause that fails to parse or
 * carries no explicit blocks_merge:false is treated as blocking.
 */
export function isMergeBlockingPause(pauseReasonRaw: string | null): boolean {
  const parsed = parsePauseReason(pauseReasonRaw);
  return parsed !== null && parsed.blocks_merge !== false;
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
        // Rows persisted before blocks_merge existed lack the field — re-derive
        // it from the registry (fail-closed to true if the reason is unknown)
        // rather than trusting an absent value as non-blocking.
        if (typeof parsed.blocks_merge !== 'boolean') {
          const registryEntry =
            PAUSE_REASON_REGISTRY[parsed.reason as CanonicalPauseReason];
          parsed.blocks_merge = registryEntry
            ? registryEntry.blocks_merge !== false
            : true;
        }
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
