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
  status: SessionStatus;
  started_at: number;
  ended_at: number | null;
  pr_url: string | null;
  worktree_path: string | null;
  archived: number; // 0 | 1 (SQLite boolean)
}

export type NewSession = Omit<Session, 'ended_at' | 'pr_url' | 'worktree_path' | 'archived'> & {
  ended_at?: number | null;
  pr_url?: string | null;
  worktree_path?: string | null;
  archived?: number;
};

// ─── session_events ────────────────────────────────────────────────────────

export type EventType = 'text' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'user_message';

export interface SessionEvent {
  id: number;
  session_id: string;
  event_type: EventType;
  payload: string; // JSON string
  timestamp: number;
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

// ─── pull_requests ──────────────────────────────────────────────────────────

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
  review_result: string | null; // JSON
  review_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  synced_at: string;
}
