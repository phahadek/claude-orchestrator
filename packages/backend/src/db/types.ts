// ─── sessions ──────────────────────────────────────────────────────────────

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'needs_permission'
  | 'done'
  | 'error'
  | 'killed';

export interface Session {
  session_id: string;
  notion_task_id: string | null;
  notion_task_url: string | null;
  project_context_url: string | null;
  project_id: string | null;
  status: SessionStatus;
  started_at: number;
  ended_at: number | null;
  pr_url: string | null;
  worktree_path: string | null;
  archived: number; // 0 | 1 (SQLite boolean)
  favorited: number; // 0 | 1 (SQLite boolean)
  session_type: string; // 'standard' | 'review'
  note: string | null;
  tags: string | null; // JSON array of strings, e.g. '["bugfix","auth"]'
  total_input_tokens: number;
  total_output_tokens: number;
  model?: string | null;
  task_name: string | null;
}

export type NewSession = Omit<Session, 'ended_at' | 'pr_url' | 'worktree_path' | 'archived' | 'favorited' | 'project_id' | 'session_type' | 'note' | 'tags' | 'total_input_tokens' | 'total_output_tokens' | 'task_name'> & {
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
  task_name?: string | null;
};

// ─── session_events ────────────────────────────────────────────────────────

export type EventType = 'text' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'user_message';

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

export type PermissionDecision = 'auto_allow' | 'auto_deny' | 'approved' | 'denied';

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

export type MatchType = 'glob' | 'regex';
export type RuleDecision = 'allow' | 'deny';

export interface PermissionRule {
  id: number;
  order_index: number;
  pattern: string;
  match_type: MatchType;
  decision: RuleDecision;
  label: string | null;
  enabled: number; // 0 | 1 (SQLite boolean)
}

export type NewPermissionRule = Omit<PermissionRule, 'id'>;

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
  notion_task_id: string;
  fetched_at: number;
  raw_json: string;
}

// ─── projects ──────────────────────────────────────────────────────────────

export type TaskSource = 'notion' | 'yaml';

export interface ProjectRow {
  id: string;
  name: string;
  project_dir: string;
  context_url: string | null;
  github_repo: string | null;
  task_source: TaskSource;
  auto_launch_enabled: number; // 0 | 1 (SQLite boolean)
  auto_launch_milestone_id: string | null;
  created_at: number;
  updated_at: number;
}

export type NewProjectRow = Omit<ProjectRow, 'created_at' | 'updated_at' | 'auto_launch_enabled' | 'auto_launch_milestone_id'> & {
  auto_launch_enabled?: number;
  auto_launch_milestone_id?: string | null;
  created_at?: number;
  updated_at?: number;
};

// ─── milestones ────────────────────────────────────────────────────────────

export interface MilestoneRow {
  id: string;
  project_id: string;
  name: string;
  source_id: string | null;
  display_order: number;
  created_at: number;
  updated_at: number;
}

export type NewMilestoneRow = Omit<MilestoneRow, 'created_at' | 'updated_at' | 'display_order'> & {
  display_order?: number;
  created_at?: number;
  updated_at?: number;
};

// ─── pull_requests ──────────────────────────────────────────────────────────

/**
 * Closed set of reasons a task is paused awaiting human attention. Stored as
 * plain TEXT in SQLite; the union gives compile-time safety in TS code paths.
 * Extend this list as new auto-orchestration triggers land (ci_failing,
 * auto_merge_failed, pr_closed).
 */
export type PauseReason = 'max_reviews' | 'stuck_timeout';

export interface PullRequestRow {
  id: number;
  pr_number: number;
  pr_url: string;
  notion_task_id: string | null;
  session_id: string | null;
  repo: string;
  title: string | null;
  body: string | null;
  head_branch: string | null;
  base_branch: string | null;
  state: string;
  draft: number;              // 0 | 1 (SQLite boolean)
  review_result: string | null; // JSON
  review_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  synced_at: string;
  review_session_id: string | null;
  review_iteration: number;
  head_sha: string | null;
  last_reviewed_sha: string | null;
  node_id: string | null;     // GitHub GraphQL global ID
  mergeable: number | null;   // 0 | 1 | NULL (SQLite boolean, NULL = unknown)
  merge_state: string | null; // 'clean' | 'dirty' | 'blocked' | 'unknown' | null
  merge_state_checked_at: string | null; // ISO timestamp
  pending_push: number;       // 0 | 1 — push arrived before initial review completed
  pause_reason: PauseReason | null; // non-null marks the task as needs_attention
}
