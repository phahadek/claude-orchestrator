import { db } from '../db/db';
import type { AuditEvent } from './types';

export function recordEvent(event: AuditEvent): void {
  const stmt = db.prepare(`
    INSERT INTO audit_log (ts, event_type, actor_type, actor_id, project_id, task_id, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    Date.now(),
    event.event_type,
    event.actor_type,
    event.actor_id ?? null,
    event.project_id ?? null,
    event.task_id ?? null,
    JSON.stringify(event.payload),
  );
}
