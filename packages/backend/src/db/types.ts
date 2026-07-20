export type { CanonicalPauseReason, PauseReasonStruct } from './pauseReason';

import type {
  CanonicalPauseReason as _CanonicalPauseReason,
  PauseReasonStruct,
} from './pauseReason';
/** Back-compat alias — canonical source of truth is CanonicalPauseReason in pauseReason.ts. */
type PauseReason = _CanonicalPauseReason;
export type { PauseReason };

// ─── sessions ──────────────────────────────────────────────────────────────

type SessionStatus =
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
  pr_url: string | null;
  worktree_path: string | null;
  archived: number; // 0 | 1 (SQLite boolean)
  favorited: number; // 0 | 1 (SQLite boolean)
  session_type: string; // 'standard' | 'review' | 'groom' | 'design'
  note: string | null;
  tags: string | null; // JSON array of strings, e.g. '["bugfix","auth"]'
  total_input_tokens: number;
  total_output_tokens: number;
  compaction_count: number;
  context_occupancy_tokens: number;
  model?: string | null;
  task_name: string | null;
  metadata: string | null; // JSON blob for small session metadata (e.g. aiTitle)
  review_result: string | null; // JSON — verdict stored for local-only review sessions
  pause_reason: string | null;
  last_error_detail: string | null;
  events_pruned_at: number | null;
}

export type NewSession = Omit<
  Session,
  | 'ended_at'
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
  | 'task_name'
  | 'metadata'
  | 'review_result'
  | 'pause_reason'
  | 'last_error_detail'
  | 'events_pruned_at'
> & {
  ended_at?: number | null;
  pr_url?: string | null;
  worktree_path?: string | null;
  archived?: number;
  favorited?: number;
  project_id?: string | null;
  session_type?: string;
  note?: string | null;
  tags?: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
  compaction_count?: number;
  context_occupancy_tokens?: number;
  task_name?: string | null;
  metadata?: string | null;
  review_result?: string | null;
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

// ─── permission_events ─────────────────────────────────────────────────────

type PermissionDecision = 'auto_allow' | 'auto_deny' | 'approved' | 'denied';

export interface PermissionEvent {
  id: number;
  session_id: string;
  tool_name: string;
  proposed_action: string | null;
  decision: PermissionDecision;
  rule_matched: string | null;
  decided_at: number;
}

export type NewPermissionEvent = Omit<PermissionEvent, 'id'>;

// ─── permission_rules ──────────────────────────────────────────────────────

type MatchType = 'glob' | 'regex';
type RuleDecision = 'allow' | 'deny';

export interface PermissionRule {
  id: number;
  order_index: number;
  pattern: string;
  match_type: MatchType;
  decision: RuleDecision;
  label: string | null;
  enabled: number; // 0 | 1 (SQLite boolean)
}

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
  created_at: number;
  updated_at: number;
}

export type NewMilestoneRow = Omit<
  MilestoneRow,
  'created_at' | 'updated_at' | 'display_order'
> & {
  display_order?: number;
  created_at?: number;
  updated_at?: number;
};

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

// ─── gate_item ────────────────────────────────────────────────────────────

export type GateItemClassification =
  | 'Read-Only'
  | 'Prod-Mutating'
  | 'Opportunistic'
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

export interface SeedItemRow {
  id: string;
  project: string;
  milestone: string;
  spec: string;
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

/** Per-intent lifecycle: staged -> approved -> committed | rejected | superseded. */
export type StagedIntentState =
  | 'staged'
  | 'approved'
  | 'committed'
  | 'rejected'
  | 'superseded';

export interface StagedIntentRow {
  id: string;
  kind: string;
  payload: string;
  payload_hash: string;
  task_id: string | null;
  project_id: string;
  session_id: string | null;
  group_id: string | null;
  state: StagedIntentState;
  supersedes: string | null;
  annotation: string | null;
  /** Human-facing rationale/summary the decision surface renders beside the payload. */
  decision_proposal: string | null;
  /** Tier-3 semantic readiness advisory — distinct from `annotation`'s deterministic hard-block channel. */
  advisory: string | null;
  created_at: number;
  updated_at: number;
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

/** A single candidate question the /design completeness critic considered and dispositioned. */
export interface CompletenessDispositionQuestion {
  question: string;
  disposition: 'accepted' | 'dismissed';
  reason: string;
}

/**
 * Durable analog of gate_accretion for the /design completeness safeguard —
 * one row per critic run, recording the source design task, the candidate
 * questions it considered, and why each was accepted or dismissed. Advisory
 * audit trail only; never read by a promotion gate.
 */
export interface CompletenessDispositionRow {
  id: number;
  source_task_id: string;
  project: string | null;
  milestone: string | null;
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
