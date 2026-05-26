export type EventType =
  | 'session_launched'
  | 'commit'
  | 'pr_opened'
  | 'pr_merged'
  | 'status_updated'
  | 'pr_body_invalid'
  | 'pr_body_invalid_warning'
  | 'attribution_missing';

export type ActorType = 'ai' | 'human' | 'system';

export interface AuditEvent {
  event_type: EventType;
  actor_type: ActorType;
  actor_id?: string | null;
  project_id?: string | null;
  task_id?: string | null;
  payload: Record<string, unknown>;
}
