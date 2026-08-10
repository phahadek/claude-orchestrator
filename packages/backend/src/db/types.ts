export type { CanonicalPauseReason, PauseReasonStruct } from './pauseReason';

import type {
  CanonicalPauseReason as _CanonicalPauseReason,
  PauseReasonStruct,
} from './pauseReason';
import type { SessionType } from '../session/sessionPredicates';
/** Back-compat alias — canonical source of truth is CanonicalPauseReason in pauseReason.ts. */
type PauseReason = _CanonicalPauseReason;
export type { PauseReason };

// ─── sessions ──────────────────────────────────────────────────────────────

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'needs_permission'
  | 'idle'
  | 'done'
  | 'error'
  | 'killed';

export interface Session {
  session_id: string;
  task_id: string | null;
  task_url: string | null;
  project_context_url: string | null;
  project_id: string | null;
  status: SessionStatus;
  started_at: number;
  ended_at: number | null;
  // Set only on a genuine terminal transition (status -> done/error/killed),
  // never on a non-terminal write that happens to also set ended_at (e.g.
  // the deferred-while-running path). NULL for historical rows. Unlike
  // ended_at, this can answer "was this session terminal at time T".
  terminalized_at: number | null;
  pr_url: string | null;
  worktree_path: string | null;
  archived: number; // 0 | 1 (SQLite boolean)
  favorited: number; // 0 | 1 (SQLite boolean)
  session_type: SessionType;
  note: string | null;
  tags: string | null; // JSON array of strings, e.g. '["bugfix","auth"]'
  total_input_tokens: number;
  total_output_tokens: number;
  compaction_count: number;
  context_occupancy_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  model?: string | null;
  effort?: string | null; // resolved effort level used at session launch, e.g. "high"
  model_setting_key?: string | null; // settings key the model was resolved from, e.g. "groom_session_model"
  effort_setting_key?: string | null; // settings key the effort was resolved from, e.g. "groom_session_effort"
  task_name: string | null;
  metadata: string | null; // JSON blob for small session metadata (e.g. aiTitle)
  review_result: string | null; // JSON — verdict stored for local-only review sessions
  pause_reason: string | null;
  last_error_detail: string | null;
  events_pruned_at: number | null;
  granted_capabilities: string; // JSON array of operator-approved capability strings, sticky for the session's life
  pending_done_ended_at: number | null; // deferred done-transition, applied once the in-flight turn completes
  pending_done_pr_url: string | null;
  pending_done_call_site: string | null;
  terminal_completion_reason: string | null; // reason string markTerminal passed to markSessionDone, persisted for lookup after the session has ended
}

export type NewSession = Omit<
  Session,
  | 'ended_at'
  | 'terminalized_at'
  | 'pr_url'
  | 'worktree_path'
  | 'archived'
  | 'favorited'
  | 'project_id'
  | 'session_type'
  | 'note'
  | 'tags'
  | 'total_input_tokens'
  | 'total_output_tokens'
  | 'compaction_count'
  | 'context_occupancy_tokens'
  | 'cache_read_tokens'
  | 'cache_creation_tokens'
  | 'task_name'
  | 'metadata'
  | 'review_result'
  | 'pause_reason'
  | 'last_error_detail'
  | 'events_pruned_at'
  | 'granted_capabilities'
  | 'pending_done_ended_at'
  | 'pending_done_pr_url'
  | 'pending_done_call_site'
  | 'terminal_completion_reason'
> & {
  ended_at?: number | null;
  terminalized_at?: number | null;
  pr_url?: string | null;
  worktree_path?: string | null;
  archived?: number;
  favorited?: number;
  project_id?: string | null;
  session_type?: SessionType;
  note?: string | null;
  tags?: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
  compaction_count?: number;
  context_occupancy_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  task_name?: string | null;
  metadata?: string | null;
  review_result?: string | null;
  granted_capabilities?: string;
};

// ─── session_events ────────────────────────────────────────────────────────

export type EventType = 'text' | 'system' | 'user_message' | 'rate_limit';

export interface SessionEvent {
  id: number;
  session_id: string;
  event_type: EventType;
  payload: string; // JSON string
  timestamp: number;
  message_id?: string | null;
}

export type NewSessionEvent = Omit<SessionEvent, 'id'>;

// ─── permission_denials ─────────────────────────────────────────────────────

export interface PermissionDenialRow {
  id: number;
  session_id: string;
  tool_name: string;
  tool_use_id: string;
  tool_input: string; // JSON string
  timestamp: number;
}

export type NewPermissionDenialRow = Omit<PermissionDenialRow, 'id'>;

// ─── task_cache ────────────────────────────────────────────────────────────

export interface TaskCache {
  task_id: string;
  fetched_at: number;
  raw_json: string;
}

// ─── projects ──────────────────────────────────────────────────────────────

export type TaskSource = 'notion' | 'yaml' | 'jira' | 'github';
export type GitMode = 'github' | 'local-only';

export interface ProjectRow {
  id: string;
  name: string;
  project_dir: string;
  context_url: string | null;
  github_repo: string | null;
  task_source: TaskSource;
  git_mode: GitMode;
  auto_launch_enabled: number; // 0 | 1 (SQLite boolean)
  auto_launch_milestone_id: string | null;
  auto_merge_enabled: number; // 0 | 1 (SQLite boolean)
  milestone_branching: 'two_tier' | 'flat' | null;
  non_milestone_source_config: string | null;
  /** JSON blob: { host, project_key, default_jql, status_mapping, ... } */
  task_source_config: string | null;
  data_residency_confirmed: number; // 0 | 1 (SQLite boolean)
  base_branch: string;
  /** 0 = read the project's Notion architecture pages; 1 = read the arch_unit store. */
  arch_store_adopted: number; // 0 | 1 (SQLite boolean)
  created_at: number;
  updated_at: number;
}

export type NewProjectRow = Omit<
  ProjectRow,
  | 'created_at'
  | 'updated_at'
  | 'auto_launch_enabled'
  | 'auto_launch_milestone_id'
  | 'auto_merge_enabled'
  | 'data_residency_confirmed'
  | 'git_mode'
  | 'milestone_branching'
  | 'non_milestone_source_config'
  | 'task_source_config'
  | 'base_branch'
  | 'arch_store_adopted'
> & {
  auto_launch_enabled?: number;
  auto_launch_milestone_id?: string | null;
  auto_merge_enabled?: number;
  data_residency_confirmed?: number;
  git_mode?: GitMode;
  milestone_branching?: 'two_tier' | 'flat' | null;
  non_milestone_source_config?: string | null;
  task_source_config?: string | null;
  base_branch?: string;
  arch_store_adopted?: number;
  created_at?: number;
  updated_at?: number;
};

// ─── milestones ────────────────────────────────────────────────────────────

export interface MilestoneRow {
  id: string;
  project_id: string;
  name: string;
  source_id: string | null;
  canonical_short_id: string | null;
  display_order: number;
  /** Set once /milestone-wrap closes out this milestone. Null = active or in-planning. */
  wrapped_at: number | null;
  created_at: number;
  updated_at: number;
}

export type NewMilestoneRow = Omit<
  MilestoneRow,
  'created_at' | 'updated_at' | 'display_order' | 'wrapped_at'
> & {
  display_order?: number;
  wrapped_at?: number | null;
  created_at?: number;
  updated_at?: number;
};

// ─── flow_arm ──────────────────────────────────────────────────────────────

export interface FlowArmRow {
  milestone_id: string;
  flow: string;
  armed: number;
  updated_at: number;
}

// ─── local_branches ────────────────────────────────────────────────────────

type LocalBranchStatus = 'open' | 'merged' | 'abandoned';

export interface LocalBranchRow {
  id: number;
  project_id: string;
  session_id: string;
  branch_name: string;
  base_branch: string;
  status: LocalBranchStatus;
  review_result: string | null; // JSON verdict
  pause_reason: string | null; // JSON-serialized PauseReasonStruct or legacy bare string
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

export type NewLocalBranchRow = Omit<
  LocalBranchRow,
  'id' | 'pause_reason' | 'merge_commit_sha'
> & {
  pause_reason?: string | null;
  merge_commit_sha?: string | null;
};

// ─── session_audits violations ───────────────────────────────────────────────

export interface WorktreeEscapeViolation {
  type: 'worktree_escape';
  tool: string;
  path: string;
  escapedTo: string;
}

// ─── devices ────────────────────────────────────────────────────────────────

export interface DeviceRow {
  id: string;
  name: string;
  user_agent: string | null;
  last_ip: string | null;
  last_seen: number | null;
  enrolled_at: number;
  token: string;
  revoked: number; // 0 | 1 (SQLite boolean)
}

export type NewDeviceRow = Omit<DeviceRow, 'last_seen' | 'revoked'> & {
  last_seen?: number | null;
  revoked?: number;
};

// ─── session_pause_intervals ────────────────────────────────────────────────

export interface SessionPauseInterval {
  id: number;
  session_id: string;
  pause_reason: PauseReasonStruct;
  paused_at: number;
  resumed_at: number | null;
}

// ─── pull_requests ──────────────────────────────────────────────────────────

export interface PullRequestRow {
  id: number;
  pr_number: number;
  pr_url: string;
  task_id: string | null;
  session_id: string | null;
  repo: string;
  title: string | null;
  body: string | null;
  head_branch: string | null;
  base_branch: string | null;
  state: string;
  draft: number; // 0 | 1 (SQLite boolean)
  review_result: string | null; // JSON
  review_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  synced_at: string;
  review_session_id: string | null;
  review_iteration: number;
  head_sha: string | null;
  last_reviewed_sha: string | null;
  node_id: string | null; // GitHub GraphQL global ID
  mergeable: number | null; // 0 | 1 | NULL (SQLite boolean, NULL = unknown)
  /**
   * Categorized non-mergeability reason. Extends GitHub's raw mergeable_state
   * so the dashboard can tell merge conflicts apart from CI failures and
   * branch-protection blocks.
   *   'clean' | 'dirty' | 'ci_failed' | 'blocked' | 'unknown' | null
   */
  merge_state: string | null;
  merge_state_checked_at: string | null; // ISO timestamp
  /** JSON-encoded string[] of failing check-run names. Non-null only when merge_state = 'ci_failed'. */
  failing_checks: string | null;
  pending_push: number; // 0 | 1 — push arrived before initial review completed
  pause_reason: string | null; // JSON-serialized PauseReasonStruct or legacy bare string
  pause_reason_set_at: number | null; // Unix ms timestamp of when pause_reason was last set
  ci_remediation_attempted_sha: string | null; // last head_sha for which CI remediation was attempted
  pre_review_stage: string | null;
  conflict_nudge_sha: string | null; // SHA for which a conflict nudge was last sent (dedup key)
  stalled_pr_retry_count: number; // reconciler attempt counter; resets when head_sha changes
  /** Unix ms timestamp set when a session's own gh pr close/reopen command was
   *  live-detected; cleared on reconcile (reopen) and on terminalize. Null means
   *  no session-initiated close/reopen churn is pending for this PR. */
  session_initiated_close_at: number | null;
  /** Unix ms timestamp stamped once requestReviewers has been called for this
   *  PR (corporate-mode reviewer auto-assignment); null means not yet fired. */
  reviewer_requested_at: number | null;
  /** Count of verified-flaky same-SHA gate re-runs attempted for the current
   *  ci_failing pause; resets to 0 when the pause clears or head_sha advances. */
  flake_recovery_attempts: number;
  /** 0 | 1 — the docs execution flow's never-auto-merged output gate: set at
   *  PR-open for repo-file docs PRs. Excluded from getApprovedOpenPRs and
   *  independently refused at AutoMerger's merge-attempt choke point; never
   *  classified stalled/orphaned by the sweepers. Waits indefinitely for a
   *  human to merge. */
  human_merge_only: number;
  /** The approved ops.prIntent (staged_intent.id) this PR was opened for, if
   *  any — set via db/queries.ts's linkPRToPRIntent at PR-open time. Null for
   *  every non-Ops PR. One approved PR-intent authorizes exactly one PR:
   *  linkPRToPRIntent rejects a second PR row claiming the same intent id. */
  pr_intent_id: string | null;
}

// ─── task_repo_assignments ──────────────────────────────────────────────────

export interface TaskRepoAssignmentRow {
  task_id: string;
  project_id: string;
  repo: string;
  assigned_by: string;
  assigned_at: number;
}

// ─── ops_journal ──────────────────────────────────────────────────────────

export type OpsJournalState =
  | 'pending'
  | 'candidate'
  | 'staged-proposal'
  | 'applied-pending-confirm'
  | 'blocked'
  | 'incident-frozen'
  | 'resolved';

/** JSON-TEXT columns carry the full on-disk worked-field set verbatim (unparsed). */
export interface OpsJournalRow {
  task_id: string;
  project: string;
  milestone: string;
  state: OpsJournalState;
  disposition: string | null;
  worked_in: string | null;
  evidence: string | null;
  finding_or_proposal: string | null;
  falsification: string | null;
  filed_followons: string | null;
  needs_from_operator: string | null;
  resolution: string | null;
  updated_at: string;
}

/**
 * Reconciliation assertion carried by an Operational completing intent
 * (`journal.setState` -> "applied-pending-confirm") — a declaration of what
 * must be true once the change applies. The session performs the actual
 * check itself (re-reading a config row, counting a backfill) and reports
 * the outcome here; the orchestrator only acts on it, after apply: `passed`
 * drives the journal to "resolved" automatically with no operator
 * involvement, a failure stages an interrupting `journal.setState` ->
 * "blocked" intent carrying `mismatch` for the operator to review.
 */
export interface OpsReconciliationAssertion {
  description: string;
  passed: boolean;
  mismatch?: string;
}

// ─── capability_disqualification ────────────────────────────────────────────

/**
 * 'open': an Investigation task is filed and unresolved — the key is
 * excluded from new denial-pattern mining while it's pending.
 * 'hardened': the Investigation resolved confirming genuine capability-level
 * risk — permanently excluded, no passive/time-based expiry.
 * 'lifted': the Investigation resolved concluding the pattern was a
 * task-quality defect, not a capability risk — the key is eligible again,
 * with `lifted_at` marking the point after which denial evidence resumes
 * accumulating (denials at or before it are never recounted).
 */
export type CapabilityDisqualificationState = 'open' | 'hardened' | 'lifted';

/** One row per (project_id, capability) key ever disqualified by the capability-disposition-trail miner. */
export interface CapabilityDisqualificationRow {
  id: string;
  project_id: string;
  capability: string;
  investigation_task_id: string;
  state: CapabilityDisqualificationState;
  created_at: string;
  resolved_at: string | null;
  lifted_at: string | null;
  updated_at: string;
}

export type NewCapabilityDisqualificationRow = Omit<
  CapabilityDisqualificationRow,
  'id' | 'resolved_at' | 'lifted_at'
> & {
  resolved_at?: string | null;
  lifted_at?: string | null;
};

// ─── convergence_snapshot ───────────────────────────────────────────────────

/** A point-in-time sample of a milestone's live convergence, written by ConvergenceSnapshotJob only when it changes. */
export interface ConvergenceSnapshotRow {
  id: string;
  project: string;
  milestone: string;
  /** ISO-8601 UTC, consistent with scheduler_audit. */
  ts: string;
  tasks_open: number;
  tasks_closed: number;
  gate_open: number;
  gate_closed: number;
  /** Non-blocking `pending` gate items — never subtracted from gate_open/gate_closed. */
  gate_parked: number;
  seed_open: number;
  seed_closed: number;
  ops_open: number;
  ops_closed: number;
  total_scope: number;
  distance_to_green: number;
  status: string;
}

export type NewConvergenceSnapshotRow = Omit<ConvergenceSnapshotRow, 'id'>;

// ─── gate_item ────────────────────────────────────────────────────────────

export type GateItemClassification =
  | 'Read-Only'
  | 'Prod-Mutating'
  | 'Human-Observation'
  | 'needs-triage';

export interface GateItemRow {
  id: string;
  project: string;
  milestone: string;
  text: string;
  classification: GateItemClassification;
  min_deployed_commit: string | null;
  state: string;
  current_disposition: string | null;
  /** The disposition carried by the item's most recent event, regardless of whether it advanced state — distinct from current_disposition, which only moves on a terminal (state-advancing) disposition. */
  latest_disposition: string | null;
  /** Earliest time a `pending` item is eligible for its next not-yet-triggerable re-check. NULL outside `pending`. */
  next_attempt_at: string | null;
  /** Consecutive not-yet-triggerable results so far — drives the doubling backoff. 0 outside `pending`. */
  pending_attempt_count: number;
  updated_at: string;
}

export interface GateItemSourceRow {
  id: number;
  gate_item_id: string;
  source_task_id: string;
  source_task_title: string;
  merge_commit: string | null;
  added_at: string;
}

export type NewGateItemSourceRow = Omit<GateItemSourceRow, 'id'>;

export interface GateItemEventRow {
  id: number;
  gate_item_id: string;
  disposition: string | null;
  evidence: string | null;
  filed_followon: string | null;
  deploy_sha: string | null;
  operator: string | null;
  /** 1 = a fully-unattended reconciler auto-launch verified this event; 0 = a manual dispatch; NULL = not verifier-originated. */
  unattended: number | null;
  /** min_deployed_commit stamped server-side at write time when disposition is `fail` — see gateStore.appendEvent. NULL for any other disposition. */
  min_deployed_commit_at_fail: string | null;
  at: string;
}

// ─── gate_accretion ───────────────────────────────────────────────────────

/** Per-source-task marker recording whether the gate_contribution promotion check is satisfied. */
export type GateAccretionDecision = 'items' | 'none' | 'n/a';

export interface GateAccretionRow {
  source_task_id: string;
  project: string;
  milestone: string;
  decision: GateAccretionDecision;
  /** Substantive reason recorded for a bare 'none'/'n/a' decision — mandatory for those, absent for 'items'. */
  reason: string | null;
  accreted_at: string;
}

export type NewGateItemEventRow = Omit<GateItemEventRow, 'id'>;

// ─── deploy_run ───────────────────────────────────────────────────────────

/** Single-field lifecycle: running -> succeeded | failed | aborted. */
export type DeployRunStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export interface DeployRunRow {
  run_id: string;
  project: string;
  target_sha: string;
  current_step: string | null;
  status: DeployRunStatus;
  started_at: string;
  completed_at: string | null;
}

export interface DeployRunEventRow {
  id: number;
  run_id: string;
  step: string;
  event_type: string;
  disposition: string | null;
  detail: string | null;
  at: string;
}

export type NewDeployRunEventRow = Omit<DeployRunEventRow, 'id'>;

// ─── seed_item ────────────────────────────────────────────────────────────

/** Single-field lifecycle: pending -> applied -> confirmed | blocked. */
export type SeedItemState = 'pending' | 'applied' | 'confirmed' | 'blocked';

/**
 * Mirrors GateItemClassification's schema-vs-data split for a seed
 * candidate, which is always a static data/config value (runtime-
 * observability is categorically inapplicable here): 'operational-seed' is a
 * genuine data/config row/default/flag correctly kept out of the PR;
 * 'in-pr' is actually schema/DDL or code that ships in the task's own PR —
 * the line was mislabeled and should not accrete; 'needs-triage' is unclear,
 * deferred.
 */
export type SeedItemClassification =
  | 'operational-seed'
  | 'in-pr'
  | 'needs-triage';

export interface SeedItemRow {
  id: string;
  project: string;
  milestone: string;
  spec: string;
  classification: SeedItemClassification | null;
  min_deployed_commit: string | null;
  state: SeedItemState;
  updated_at: string;
}

// ─── seed_accretion ───────────────────────────────────────────────────────

/** Per-source-task marker recording whether the seed_contribution promotion check is satisfied. */
export type SeedAccretionDecision = 'seeds' | 'none' | 'n/a';

export interface SeedAccretionRow {
  source_task_id: string;
  project: string;
  milestone: string;
  decision: SeedAccretionDecision;
  accreted_at: string;
}

export interface SeedItemSourceRow {
  id: number;
  seed_item_id: string;
  source_task_id: string;
  source_task_title: string;
  merge_commit: string | null;
  added_at: string;
}

export type NewSeedItemSourceRow = Omit<SeedItemSourceRow, 'id'>;

export type SeedItemEventOutcome = 'applied' | 'confirmed' | 'blocked';

export interface SeedItemEventRow {
  id: number;
  seed_item_id: string;
  outcome: SeedItemEventOutcome;
  evidence: string | null;
  filed_followon: string | null;
  operator: string | null;
  at: string;
}

// ─── staged_intent ────────────────────────────────────────────────────────

/**
 * Per-intent lifecycle: staged -> approved -> committed | rejected | superseded.
 * `pending_verification` and `needs_revision` gate a dispatched session's
 * proposal group between turn-end and operator visibility (see
 * verifyDispatchedGroupsForSession in routes/stagedIntents.ts): a group's
 * `staged` members move to `pending_verification` while the group-level
 * verify pass runs, then either back to `staged` (clean) or to
 * `needs_revision` (blocked, and not yet escalated to the operator) — both
 * transient states are excluded from the operator-facing surface.
 */
export type StagedIntentState =
  | 'staged'
  | 'pending_verification'
  | 'needs_revision'
  | 'approved'
  | 'committed'
  | 'rejected'
  | 'superseded'
  /** Terminal, non-appliable: the staging session itself withdrew this intent — see stagedIntents.ts's withdrawIntent. */
  | 'withdrawn';

export interface StagedIntentRow {
  id: string;
  /** Free-form intent-kind vocabulary — see stagedIntents.ts's KNOWN_INTENT_KINDS (e.g. "task.setStatus", "notion.pageEdit"). */
  kind: string;
  payload: string;
  payload_hash: string;
  task_id: string | null;
  project_id: string;
  session_id: string | null;
  group_id: string | null;
  /** The milestone (canonical_short_id) this intent's target task belongs to. Null = unattributed (legacy row or unresolvable task). */
  milestone: string | null;
  state: StagedIntentState;
  supersedes: string | null;
  annotation: string | null;
  /** Human-facing rationale/summary the decision surface renders beside the payload. */
  decision_proposal: string | null;
  /**
   * The file:line / arch-page-section / API-result evidence a decision.pickOne
   * intent's `decision_proposal` recommendation rests on — kept separate so
   * `decision_proposal` stays at design altitude. Rendered collapsed by
   * default. Null for kinds that don't carry one, and for rows created
   * before this column existed.
   */
  investigation: string | null;
  /**
   * The /groom skill's structured proposal fields (JSON-encoded
   * `GroomProposalFields`), carried by a dispatched groom session's
   * Ready-flip decision in place of a free-prose `decision_proposal`.
   */
  groom_proposal: string | null;
  /** Tier-3 semantic readiness advisory — distinct from `annotation`'s deterministic hard-block channel. */
  advisory: string | null;
  /** Operator-supplied rationale for a reject disposition (pushback | decline). Null until rejected. */
  disposition_reason: string | null;
  /** The operator's answer to a decision.pickOne question-intent — JSON-serialized StagedIntentAnswer. Null until answered. */
  answer: string | null;
  /**
   * The id `applyIntent` minted for this intent's non-idempotent create
   * (task.create's created task id / arch.createUnit's new unit id) — set the
   * instant the backend write succeeds, independent of and prior to the
   * row's own staged/approved -> committed transition, so it stays a
   * reliable "has this create already applied" signal even when that
   * transition later loses a race (see AlreadyAppliedCreateSupersedeError in
   * routes/stagedIntents.ts). Null for every other kind, and for a create
   * that hasn't applied yet.
   */
  applied_task_id?: string | null;
  created_at: number;
  updated_at: number;
}

/** The two explicit operator-chosen outcomes for a reject disposition. */
export type StagedIntentRejectOutcome = 'pushback' | 'decline';

/** A single candidate the operator can pick for a decision.pickOne question-intent. */
interface DecisionPickOneOption {
  label: string;
  description: string;
}

/**
 * Payload for the decision.pickOne question-intent kind — modeled on
 * Claude's AskUserQuestion shape: a multi-option question a dispatched
 * planning session poses to the operator when it cannot confidently resolve
 * a fork itself. Staging this writes no task store; only the answer does
 * (by re-turning the originating session, which then stages the concrete
 * writes for the chosen path as ordinary intents).
 */
export interface DecisionPickOnePayload {
  prompt: string;
  options: DecisionPickOneOption[];
  allowFreeForm: boolean;
}

/** The operator's response to a decision.pickOne question-intent. At least one of chosenLabel or freeForm is present. */
export interface StagedIntentAnswer {
  chosenLabel: string | null;
  freeForm: string | null;
}

/**
 * Payload for the review.dispute staged-intent kind — a code session's route
 * out of a `needs_changes`/`incomplete` PR review verdict it concludes is
 * wrong, carrying the evidence for an operator to judge instead of leaving
 * the session waiting on a re-review that a disputed-but-unchanged head SHA
 * will never trigger. Approval clears the blocking verdict without a new
 * commit; pushback resumes the authoring session for a revision turn.
 */
export interface ReviewDisputePayload {
  taskId: string;
  prNumber: number;
  repo: string;
  rationale: string;
}

/**
 * Payload for the ops.prIntent staged-intent kind — a dispatched Ops
 * session's mid-execution "I intend to open a PR for X, here's the diff
 * scope and why" declaration. Unlike a Code task's task-body Files/paths
 * affected list (written up front, before the work is scoped), an Ops
 * session's PR content is a mid-execution decision the task body cannot
 * declare in advance — so this carries the declaration itself, staged for
 * operator approval before the session may open the PR. Deliberately not
 * validated via isToolShapedCapability (session.requestCapability's
 * Bash-prefix/MCP-verb shape) — this is a free-form change-and-reason
 * declaration, not a tool grant. Once approved (see approve route's
 * ops.prIntent branch, terminal like review.dispute/session.requestCapability
 * above), PRReviewService resolves this declaration to build the Ops rubric
 * variant's "changed files" dimension instead of a task-body section — see
 * getPRIntentForPR / linkPRToPRIntent in db/queries.ts, which enforce that
 * one approved PR-intent authorizes exactly one PR (fire-once).
 */
export interface OpsPrIntentPayload {
  taskId: string;
  /** Short PR title the operator is approving, e.g. "add retry to X poller". */
  title: string;
  /** The declared diff scope — files/areas expected to change, and why they're in scope. */
  scope: string;
  /** Why this PR is being opened now — the finding/decision driving it. */
  reason: string;
}

/**
 * The /groom skill's per-task proposal shape (`presentation.md`'s 4/5-point
 * summary: what it achieves, open questions, automated tests, manual
 * verification, and operational seed) — the structured contract a dispatched
 * groom session's Ready-flip decision carries instead of free prose, so the
 * reviewing human (and the decision surface) can render/judge it as fields
 * rather than parse a paragraph.
 */
export interface GroomProposalFields {
  achieves: string;
  openQuestions: string;
  automatedTests: string;
  manualVerification: string;
  operationalSeed: string;
}

// ─── staged_intent_group ──────────────────────────────────────────────────

/** Per-group counter of automatic Tier-3 route-backs; caps at N (default 3), then escalates. */
export interface StagedIntentGroupRow {
  group_id: string;
  route_back_count: number;
  escalated: number;
  updated_at: number;
}

export type NewSeedItemEventRow = Omit<SeedItemEventRow, 'id'>;

// ─── completeness_disposition ───────────────────────────────────────────────

/**
 * The Design skill's six-value disposition vocabulary (design skill,
 * presentation.md) for a completeness-critic candidate question. Five of
 * the six collapse to "the question is closed, no follow-on"; `fold` and the
 * two sibling variants each mean something materially different (folded back
 * into an open question vs. owned by a sibling task), which a binary
 * accepted/dismissed column could not distinguish — see task
 * …3012260f. Stored verbatim, never collapsed.
 */
type NamedCompletenessDisposition =
  | 'resolved'
  | 'out-of-scope'
  | 'not-a-decision'
  | 'fold'
  | 'file-sibling'
  | 'sibling-owned';

/** A single candidate question the /design completeness critic considered and dispositioned. */
export interface CompletenessDispositionQuestion {
  question: string;
  disposition: NamedCompletenessDisposition;
  reason: string;
  /**
   * Recorded (`proposed`, the default at critic-run time) is not approved —
   * the same disposition is carried into a `completeness.disposition` staged
   * intent for operator sign-off, and only flips to `approved` once that
   * intent is approved — see routes/stagedIntents.ts's completeness-
   * disposition approve handling, which is what actually advances this field
   * on the stored row. A rejected run deletes the row entirely (see
   * deleteCompletenessDisposition) and leaves the session free to re-run the
   * critic and stage a revised `completeness.disposition` intent.
   */
  approvalStatus?: 'proposed' | 'approved' | 'rejected';
}

/**
 * The named gap classes the design skill's completeness critic is required
 * to probe (task …3012260f, defect 2). Recording which of these were
 * actually probed on a run turns a clean pass into an affirmative statement
 * ("these classes were checked, none produced a gap") instead of an
 * indistinguishable-from-skipped empty `questions` array.
 */
export const COMPLETENESS_PROBED_GAP_CLASSES = [
  'durability-failure-modes',
  'dual-read-consumer-set',
  'interaction-bugs',
  'missing-scaffolding',
  'state-mutation-granularity',
  'unstated-premises',
] as const;

export type CompletenessProbedGapClass =
  (typeof COMPLETENESS_PROBED_GAP_CLASSES)[number];

/**
 * The shape stored (as JSON) in `completeness_disposition.questions` — a
 * pre-existing JSON TEXT column, so widening it from a bare array to this
 * object is a TypeScript/zod type change only, no SQL migration. `probed`
 * is never empty: a clean pass still names every gap class the critic
 * checked, so the record can never be confused with a skipped run.
 */
export interface CompletenessDispositionRecord {
  probed: CompletenessProbedGapClass[];
  questions: CompletenessDispositionQuestion[];
}

/**
 * Durable analog of gate_accretion for the /design completeness safeguard —
 * one row per critic run, recording the source design task, the gap classes
 * probed, and the candidate questions considered with their named
 * disposition. Advisory audit trail only; never read by a promotion gate.
 */
export interface CompletenessDispositionRow {
  id: number;
  source_task_id: string;
  project: string | null;
  milestone: string | null;
  /** JSON-serialized CompletenessDispositionRecord. */
  questions: string;
  run_at: string;
}

export type NewCompletenessDispositionRow = Omit<
  CompletenessDispositionRow,
  'id'
>;

// ─── session_feedback_inbox ─────────────────────────────────────────────────

export interface FeedbackInboxRow {
  id: number;
  session_id: string;
  source: string;
  payload: string;
  enqueued_at: number;
  delivered_at: number | null;
}

// ─── arch_unit ────────────────────────────────────────────────────────────

/** A single titled architecture statement. */
export type ArchUnitKind =
  | 'subsystem'
  | 'invariant'
  | 'decision'
  | 'contract'
  | 'reference';

export type ArchUnitStatus = 'active' | 'deferred' | 'superseded';

export interface ArchUnitRow {
  id: string;
  title: string;
  kind: ArchUnitKind;
  topic: string;
  /** JSON-encoded string[] of code paths/regions (same vocabulary as the grooming code-worklist). */
  regions: string;
  status: ArchUnitStatus;
  body: string;
  supersedes: string | null;
  superseded_by: string | null;
  /** Optimistic-concurrency counter, bumped on every update/supersede mutation. */
  version: number;
  created_at: string;
  updated_at: string;
}

export type NewArchUnitRow = Omit<
  ArchUnitRow,
  'superseded_by' | 'created_at' | 'updated_at'
> & {
  superseded_by?: string | null;
  created_at: string;
  updated_at: string;
};

export type ArchUnitEventType = 'created' | 'updated' | 'superseded';

export interface ArchUnitEventRow {
  id: number;
  arch_unit_id: string;
  event_type: ArchUnitEventType;
  /** JSON-encoded change payload (e.g. previous/next field diffs); null for simple markers. */
  payload: string | null;
  at: string;
}

export type NewArchUnitEventRow = Omit<ArchUnitEventRow, 'id'>;

export interface ArchUnitQuery {
  topic?: string;
  kind?: ArchUnitKind;
  /** Region substring filter — matches units whose regions array contains a path prefix match. */
  region?: string;
  status?: ArchUnitStatus;
  /** When true, includes superseded units. Default false (active-set query). */
  includeSuperseded?: boolean;
}
