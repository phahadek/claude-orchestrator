export type EventType =
  | 'session_launched'
  | 'commit'
  | 'pr_opened'
  | 'pr_merged'
  | 'status_updated'
  | 'pr_body_invalid'
  | 'pr_body_invalid_warning'
  | 'attribution_missing'
  | 'session_launch_refused_zdr'
  | 'data_residency_flag_toggled'
  | 'file_pollution_reverted'
  | 'file_pollution_checked'
  | 'file_pollution_re_injected_blocked'
  | 'autofix_for_ci_failure'
  | 'autofix_banned_file_unstaged'
  | 'file_pollution_check_failed'
  | 'handle_clean_exit_entered'
  | 'handle_clean_exit_session_marked_done'
  | 'task_orphan_reverted'
  | 'session_errored';

export type ActorType = 'ai' | 'human' | 'system';

export interface AuditEvent {
  event_type: EventType;
  actor_type: ActorType;
  actor_id?: string | null;
  project_id?: string | null;
  task_id?: string | null;
  payload: Record<string, unknown>;
}
