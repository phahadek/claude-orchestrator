type EventType =
  | 'session_launched'
  | 'commit'
  | 'pr_opened'
  | 'pr_merged'
  | 'status_updated'
  | 'pr_body_invalid'
  | 'pr_body_invalid_warning'
  | 'pr_body_updated_via_marker'
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
  | 'handle_clean_exit_session_marked_idle'
  | 'task_orphan_reverted'
  | 'task_orphan_nudged'
  | 'task_orphan_surfaced'
  | 'session_errored'
  | 'session_backfilled'
  | 'verdict_routing_failed'
  | 'manual_pr_clear'
  | 'sessions_auto_archived'
  | 'pr_attribution_mismatch'
  | 'pr_creation_failed'
  | 'session_aborted'
  | 'auto_launch_done_update_stuck'
  | 'auto_launch_paused'
  | 'session_marked_done_while_running'
  | 'conflict_nudge_delivery_failed'
  | 'worktree_remove_failed'
  | 'stale_branch_abandoned'
  | 'review_side_effect_failed'
  | 'pipeline_stage_entered'
  | 'pipeline_stage_passed'
  | 'pipeline_stage_failed';

type ActorType = 'ai' | 'human' | 'system';

export interface AuditEvent {
  event_type: EventType;
  actor_type: ActorType;
  actor_id?: string | null;
  project_id?: string | null;
  task_id?: string | null;
  payload: Record<string, unknown>;
}
