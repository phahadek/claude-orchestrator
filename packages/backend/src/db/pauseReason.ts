export type PauseSource =
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
  | 'stalled_no_relaunch_target'
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
  | 'mcp_unreachable_exhausted'
  | 'verdict_routing_failed'
  | 'base_attributable_test_excluded'
  | 'migration_reservation_overtaken';

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
  /**
   * Per-entry timestamp used only to tie-break resolution order among
   * concurrent entries (see resolvePauseReasonEntry below) — never for
   * merge-blocking, which ORs across every live entry regardless of age.
   * Absent on structs built for non-concurrent storage (task_pause_reasons,
   * session_pause_intervals) where a single column-level timestamp suffices.
   */
  set_at?: number;
}

type RegistryEntry = {
  source: PauseSource;
  severity: PauseSeverity;
  retry_strategy: PauseRetryStrategy;
  /** See PauseReasonStruct.blocks_merge. Omit to default to true (blocking). */
  blocks_merge?: boolean;
};

// The 7 original exact-match consumers named when this registry's
// (source, retry_strategy, blocks_merge) capability model was locked, and how
// each expresses its predicate today. 5 already speak the capability model;
// 2 still key off a literal CanonicalPauseReason value (tracked for
// conversion in a sibling task, not this one — this comment only documents
// current state):
//   1. classifyStalledPR's early return (github/pollUtils.ts) — still a
//      literal exact-match: `parsed?.reason === 'analyze_failing'`.
//   2. handleVerifiedFlakyDisposition's expectedPauseReason check
//      (mcp/tools/verdictTools.ts) — still a literal exact-match:
//      `pauseStruct?.reason !== expectedPauseReason`.
//   3. RECOVERY_ACTION_MAP / deriveRecoveryDescriptor (below, this file) —
//      capability-shaped but deliberately NOT re-expressed as a
//      (source, retry_strategy) predicate: it's an exhaustive per-reason
//      lookup table, keyed by CanonicalPauseReason, because which
//      RecoveryAction applies doesn't correlate with source (see the comment
//      on RECOVERY_ACTION_MAP below).
//   4. isMergeBlockingPause (below, this file) — pure capability predicate:
//      ORs `blocks_merge !== false` across every live concurrent entry.
//   5. clearTerminalPRFlags's guard — actually named
//      RECONCILE_EXHAUSTED_CLEAR_ALLOWED_TRIGGERS (db/queries.ts), not
//      CAP_CLEAR_ALLOWED_TRIGGERS — exact-matches a *trigger* literal against
//      a Set, a different axis entirely from pause-reason capability.
//   6. StalledPRReconciler's retry_strategy === 'manual_action' skip
//      (orchestration/StalledPRReconciler.ts) — capability predicate via
//      isManualActionPause (below, this file): ORs
//      `retry_strategy === 'manual_action'` across every live entry.
//   7. AutoMerger's merge gate (github/AutoMerger.ts) — capability predicate:
//      `struct.source === 'ci' && struct.blocks_merge`.
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
  // Distinct from the reconcile_exhausted flag: this PR was never charged
  // against the retry budget at all — there was no session to relaunch a
  // fixer onto (session_id is null), so retrying the same no-op forever
  // would just loop silently. Surfaced immediately rather than after
  // burning attempts.
  stalled_no_relaunch_target: {
    source: 'session',
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
  // Out-of-band reservation overtake: the review-gate migration-reservation
  // dimension override (PRReviewService.ts's applyMigrationReservationOverride)
  // detected that the shipped migration number belongs, per the reservation
  // table, to a *different* task whose PR/branch has already merged — not
  // this task's own drift, which the dimension override fails on its own
  // without escalation. Always requires human disposition: the reservation
  // table and the live migrations directory have diverged in a way no
  // automatic retry resolves.
  migration_reservation_overtaken: {
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
  // A needs_changes/incomplete verdict had no session_id to route feedback
  // to (e.g. a boot-swept PR that never matched a session by branch — see
  // PRBootSweep.insertIfMissing). No automated recovery path exists for a
  // PR with no session to nudge, so — like needs_repo/workflow_scope_denied
  // — this is a permanent operator-action-required pause.
  verdict_routing_failed: {
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  },
  // Advisory-only pill: the F2 gate's baseAttributableFilter excused this
  // PR's failing test(s) as confirmed base-attributable (and, for any
  // excluded test, cleared both masking guards — see
  // orchestration/baseAttributableFilter.ts). Never blocks merge — the
  // point is to keep the exclusion visible to an operator rather than let
  // it pass silently, mirroring ci_not_completing/
  // test_report_acquisition_failed. No RECOVERY_ACTION_MAP entry — nothing
  // for an operator to click, the pill clears itself once a subsequent run
  // is clean or newly attributable.
  base_attributable_test_excluded: {
    source: 'tests',
    severity: 'needs_attention',
    retry_strategy: 'automatic',
    blocks_merge: false,
  },
};

// ── Recovery descriptor ──────────────────────────────────────────────────────

type RecoveryAction = 'redispatch' | 'rerun' | 'resume';

export interface RecoveryDescriptor {
  available: boolean;
  action?: RecoveryAction;
  label?: string;
}

// Discharge-path completeness decision: enforced at the type level, not by
// convention. The enforcement mechanism is the `Record<CanonicalPauseReason,
// RecoveryAction | 'none'>` annotation below — TypeScript's mapped-type
// checker rejects this file at `tsc` compile time if any CanonicalPauseReason
// key is missing an entry (mirrors PAUSE_REASON_REGISTRY, which uses the same
// `Record<CanonicalPauseReason, RegistryEntry>` mechanism for the same
// reason). There is no runtime fallback, default case, or lint rule standing
// in for this — the compiler is the sole guarantee. Every CanonicalPauseReason
// needs an explicit, reviewed entry here — either a real RecoveryAction or a
// deliberate 'none' — so adding a new reason without deciding its discharge
// path is a typecheck failure, not a silent omission.
//
// Deliberately kept keyed by CanonicalPauseReason rather than re-expressed as
// a (source, retry_strategy) capability predicate like
// findAutomaticGateRecoveryEntry/isManualActionPause above: which
// RecoveryAction applies (redispatch vs rerun vs resume) does not correlate
// with source — e.g. 'merge'-sourced auto_merge_failed is 'rerun' while
// 'merge'-sourced merge_conflict is 'resume' and 'merge'-sourced
// pr_creation_failed is 'redispatch'. The one capability-derivable slice —
// every severity:'recoverable' + retry_strategy:'automatic' reason
// (stuck_timeout, api_overloaded, base_branch_broken, rate_limit,
// depth_review_pending, usage_limit_deferred) maps to 'none' below, since a
// self-healing pause never has a manual click to offer — is still listed
// explicitly per-reason rather than derived, to preserve the exhaustiveness
// guarantee against a reason moving between (severity, retry_strategy) pairs
// without this map being re-reviewed.
const RECOVERY_ACTION_MAP: Record<
  CanonicalPauseReason,
  RecoveryAction | 'none'
> = {
  // redispatch: clear pause + reset crash count + set Ready
  launch_failed: 'redispatch',
  needs_repo: 'redispatch',
  stalled_idle: 'redispatch',
  resume_failed: 'redispatch',
  pr_creation_failed: 'redispatch',
  planning_crashed: 'redispatch',
  planning_first_turn_empty: 'redispatch',
  planning_terminal_no_decision: 'redispatch',
  ops_journal_terminal_incomplete: 'redispatch',
  // no session exists to relaunch onto — a fresh dispatch is the only
  // recovery, mirroring stalled_idle above.
  stalled_no_relaunch_target: 'redispatch',
  // rerun: clear pause + re-run the pre-review pipeline
  autofix_git_infra_failure: 'rerun',
  autofix_tool_infra_failure: 'rerun',
  ci_billing_blocked: 'rerun',
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
  // Escalated form of diverged_branch once MAX_REBASE_NUDGES is exhausted —
  // once a human rebases by hand out of band, the session still needs the
  // same continue-nudge diverged_branch already uses.
  diverged_branch_unresolved: 'resume',
  // Escalated form of api_overloaded once the in-session respawn/backoff
  // budget is exhausted — flagged for manual attention, then resumed.
  api_overloaded_exhausted: 'resume',
  // none: no click in this map fixes it — either the system already
  // auto-clears it, or the fix is structurally outside redispatch/rerun/resume.
  max_reviews: 'none', // reviewed and closed by the reviewer/operator directly
  stuck_timeout: 'none', // recoverable+automatic: auto continue-nudge, then orphan-reconciliation force-kill
  pr_closed: 'none', // terminal; PRMergeWatcher auto-reconciles within a grace window, otherwise outside this map's actions
  api_overloaded: 'none', // recoverable+automatic: auto-retries via in-place kill+respawn before ever reaching *_exhausted
  awaiting_human_approval: 'none', // cleared by approving the PR on GitHub, not by this map
  notion_done_update_stuck: 'none', // PR is already merged; a redispatch would incorrectly reset an already-completed task
  base_branch_broken: 'none', // clears itself the moment a subsequent base-health check comes back clean/partial
  rate_limit: 'none', // recoverable+automatic: auto-clears the moment the rate_limit_event status flips to 'resumed'
  workflow_scope_denied: 'none', // fix is retyping the task as Tooling for an interactive session — a routing change outside this session
  review_rules_escalation: 'none', // resolve manually; no dedicated auto-discharge route
  // Deliberate, reviewed 'none': set identically to review_rules_escalation
  // with no dedicated clear route beyond the standard human-operated recover
  // flow. Mirrors the other non-automatable, human-adjudicated escalation
  // reasons rather than inventing new discharge machinery.
  baseline_escalation_floor: 'none',
  // Same shape as baseline_escalation_floor: the reservation table vs. live
  // migrations directory divergence is resolved via the reassignment remedy
  // flow (report.file claim + re-derivation), not a one-click discharge.
  migration_reservation_overtaken: 'none',
  depth_review_escalation: 'none', // same shape as baseline_escalation_floor; can be raised with no linked session to route to
  depth_review_pending: 'none', // recoverable+automatic: clears itself within dispatchDepthReview's timeout ceiling
  planning_terminal_blocked_members: 'none', // fix is dispositioning stuck staged intents, not a task-level redispatch
  ops_terminal_group_incomplete: 'none', // fix is staging the missing transition manually, not a session action
  usage_limit_deferred: 'none', // recoverable+automatic: resumes at the recorded resets_at
  manual_verification_pending: 'none', // cleared only via the dedicated verify-manual-items route
  test_request_cycle_exceeded: 'none', // needs a human look, not a one-click redispatch/resume that would just resume the same loop
  test_report_acquisition_failed: 'none', // nothing auto-recovers it, but it also never blocks merge
  ci_not_completing: 'none', // advisory-only: self-clears via the scheduled poll job or is superseded by a genuine ci_failing pause
  mcp_unreachable_exhausted: 'none', // an operator has to decide whether to keep retrying by hand or abandon the session
  verdict_routing_failed: 'none', // no session to nudge; permanent operator-action-required pause
  base_attributable_test_excluded: 'none', // advisory-only: the pill clears itself once a subsequent run is clean or newly attributable
};

const RECOVERY_LABELS: Record<RecoveryAction, string> = {
  redispatch: 'Redispatch',
  rerun: 'Rerun',
  resume: 'Resume',
};

/**
 * 'stalled_reconcile_cap' predates the extraction of the orthogonal
 * reconcile_exhausted flag (see schema.ts) and is no longer written for new
 * escalations, but old PR rows can still carry it as a legacy bare-string
 * pause_reason (parsePauseReasonSet's unknown-string fallback preserves the
 * original string rather than discarding it). It is deliberately not a
 * CanonicalPauseReason / RECOVERY_ACTION_MAP entry — that registry is for
 * live-written reasons — so it's special-cased here instead, mapped to the
 * same 'rerun' action the deprecated /unpark route already performs for it
 * via executeRerunPipeline.
 */
const LEGACY_STALLED_RECONCILE_CAP = 'stalled_reconcile_cap';

export function deriveRecoveryDescriptor(
  reason: CanonicalPauseReason | 'stalled_reconcile_cap' | null | undefined,
): RecoveryDescriptor {
  if (reason == null) return { available: false };
  if (reason === LEGACY_STALLED_RECONCILE_CAP) {
    return { available: true, action: 'rerun', label: RECOVERY_LABELS.rerun };
  }
  const action = RECOVERY_ACTION_MAP[reason];
  if (action == null || action === 'none') return { available: false };
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
 * ORs blocks_merge across every live concurrent entry — not just the one
 * resolution order would pick for display — since a single advisory entry
 * (e.g. test_report_acquisition_failed) must never mask a concurrently-live
 * blocking entry from a different source. Fails closed: no pause blocks
 * nothing (returns false), but any entry that carries no explicit
 * blocks_merge:false is treated as blocking.
 */
export function isMergeBlockingPause(pauseReasonRaw: string | null): boolean {
  const set = parsePauseReasonSet(pauseReasonRaw);
  return set.some((entry) => entry.blocks_merge !== false);
}

/**
 * Capability predicate for "this PR is parked on an operator action item" —
 * true when any live concurrent entry declares retry_strategy:
 * 'manual_action'. Mirrors isMergeBlockingPause's shape: ORs across the full
 * set rather than only the single entry precedence resolution would pick,
 * since a manual_action entry from one source (e.g. depth_review_escalation)
 * must still be honored even when a different, higher-severity or
 * more-recent entry from another source would otherwise resolve to the
 * display-level "top" pause.
 */
export function isManualActionPause(pauseReasonRaw: string | null): boolean {
  const set = parsePauseReasonSet(pauseReasonRaw);
  return set.some((entry) => entry.retry_strategy === 'manual_action');
}

export function serializePauseReason(struct: PauseReasonStruct): string {
  return JSON.stringify(struct);
}

/** Serializes a concurrent pause-reason set for storage in pull_requests.pause_reason. */
export function serializePauseReasonSet(entries: PauseReasonStruct[]): string {
  return JSON.stringify(entries);
}

/**
 * Capability predicate generalizing isAutomaticRecoveryPending below: finds
 * the live concurrent-set entry (if any) whose source matches `source` and
 * whose retry_strategy is 'automatic' — i.e. a pause that a same-commit
 * automatic re-run can discharge. Callers that used to compare
 * pauseStruct.reason against a single expected literal (e.g. 'ci_failing')
 * should match on this instead: it generalizes past source alone, which
 * would incorrectly treat a manual_action pause sharing the same source
 * (e.g. ci_billing_blocked, source: 'ci') as automatically dischargeable.
 */
export function findAutomaticGateRecoveryEntry(
  entries: PauseReasonStruct[],
  source: PauseSource,
): PauseReasonStruct | null {
  return (
    entries.find(
      (entry) =>
        entry.source === source && entry.retry_strategy === 'automatic',
    ) ?? null
  );
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

/** Coerces one parsed JSON object into a PauseReasonStruct, or null if it isn't shaped like one. */
function coercePauseReasonObject(
  parsed: Record<string, unknown>,
): PauseReasonStruct | null {
  if (
    typeof parsed.reason !== 'string' ||
    typeof parsed.source !== 'string' ||
    typeof parsed.severity !== 'string' ||
    typeof parsed.retry_strategy !== 'string'
  ) {
    return null;
  }
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

function unknownPauseReasonFallback(raw: string): PauseReasonStruct {
  console.warn(
    `[pauseReason] Unknown pause reason: "${raw}", using safe default`,
  );
  return { reason: raw as CanonicalPauseReason, ...UNKNOWN_FALLBACK };
}

/**
 * Coerces one element of a concurrent-set JSON array, degrading a malformed
 * element to the same safe fallback as an unknown bare-string reason rather
 * than dropping it — a corrupt array element must never silently vanish from
 * the set, since that would make isMergeBlockingPause under-report a pause
 * that fails to parse (see UNKNOWN_FALLBACK's fail-closed blocks_merge:true).
 */
function coerceArrayElementOrFallback(
  item: unknown,
  index: number,
): PauseReasonStruct {
  if (item !== null && typeof item === 'object') {
    const coerced = coercePauseReasonObject(item as Record<string, unknown>);
    if (coerced) return coerced;
    const record = item as Record<string, unknown>;
    if (typeof record.reason === 'string') {
      return unknownPauseReasonFallback(record.reason);
    }
  }
  return unknownPauseReasonFallback(`malformed_entry_${index}`);
}

/**
 * Parses pull_requests.pause_reason into the full concurrent set of live
 * entries (at most one per PauseSource). Handles every storage shape the
 * column has ever held:
 *  - current: a JSON array of PauseReasonStruct entries.
 *  - legacy struct: a single JSON object — treated as a one-element set.
 *  - legacy bare string: a canonical reason name — treated as a one-element
 *    set via pauseReasonFromCanonical.
 * Never throws: a malformed/unknown value degrades to a safe single-entry
 * fallback rather than losing the pause signal entirely.
 */
export function parsePauseReasonSet(raw: string | null): PauseReasonStruct[] {
  if (raw === null || raw === '') return [];

  if (raw.startsWith('[')) {
    try {
      const parsedArray = JSON.parse(raw) as unknown[];
      return parsedArray.map((item, index) =>
        coerceArrayElementOrFallback(item, index),
      );
    } catch {
      // fall through to legacy handling
    }
  }

  if (raw.startsWith('{')) {
    try {
      const parsed = coercePauseReasonObject(
        JSON.parse(raw) as Record<string, unknown>,
      );
      if (parsed) return [parsed];
    } catch {
      // fall through to legacy handling
    }
  }

  if (CANONICAL_SET.has(raw)) {
    return [pauseReasonFromCanonical(raw as CanonicalPauseReason)];
  }

  return [unknownPauseReasonFallback(raw)];
}

/**
 * Resolution order for single-value display/precedence contexts (never for
 * merge-blocking — see isMergeBlockingPause): ranks by severity (terminal >
 * needs_attention > recoverable), tie-broken by the most recent per-entry
 * set_at.
 */
const SEVERITY_RANK: Record<PauseSeverity, number> = {
  terminal: 3,
  needs_attention: 2,
  recoverable: 1,
};

function resolvePauseReasonEntry(
  entries: PauseReasonStruct[],
): PauseReasonStruct | null {
  if (entries.length === 0) return null;
  return entries.reduce((best, candidate) => {
    const bestRank = SEVERITY_RANK[best.severity];
    const candidateRank = SEVERITY_RANK[candidate.severity];
    if (candidateRank !== bestRank) {
      return candidateRank > bestRank ? candidate : best;
    }
    return (candidate.set_at ?? 0) > (best.set_at ?? 0) ? candidate : best;
  });
}

/**
 * Single-value view of pull_requests.pause_reason for display/precedence
 * contexts, resolved from the full concurrent set — see
 * resolvePauseReasonEntry. Never use this to decide merge-blocking; use
 * isMergeBlockingPause, which ORs across every live entry instead.
 */
export function parsePauseReason(raw: string | null): PauseReasonStruct | null {
  return resolvePauseReasonEntry(parsePauseReasonSet(raw));
}
