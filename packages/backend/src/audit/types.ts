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
  | 'data_residency_flag_toggled';

export type ActorType = 'ai' | 'human' | 'system';

export interface AuditEvent {
  event_type: EventType;
  actor_type: ActorType;
  actor_id?: string | null;
  project_id?: string | null;
  task_id?: string | null;
  payload: Record<string, unknown>;
}
