import { db } from './db';
import type {
  Session,
  NewSession,
  SessionEvent,
  NewSessionEvent,
  PermissionEvent,
  NewPermissionEvent,
  PermissionRule,
  NewPermissionRule,
  TaskCache,
} from './types';

// ─── sessions ──────────────────────────────────────────────────────────────

const stmtInsertSession = db.prepare<NewSession>(`
  INSERT INTO sessions
    (session_id, notion_task_id, notion_task_url, project_context_url,
     status, started_at, ended_at, pr_url)
  VALUES
    (@session_id, @notion_task_id, @notion_task_url, @project_context_url,
     @status, @started_at, @ended_at, @pr_url)
`);

const stmtUpdateSessionStatus = db.prepare<{
  session_id: string;
  status: string;
  ended_at: number | null;
}>(`
  UPDATE sessions
  SET status = @status, ended_at = @ended_at
  WHERE session_id = @session_id
`);

const stmtGetSession = db.prepare<{ session_id: string }>(`
  SELECT * FROM sessions WHERE session_id = @session_id
`);

const stmtGetAllSessions = db.prepare(`
  SELECT * FROM sessions ORDER BY started_at DESC
`);

const stmtGetAllSessionIds = db.prepare(`
  SELECT session_id FROM sessions
`);

const stmtDeleteSessionEvents = db.prepare<{ session_id: string }>(`
  DELETE FROM session_events WHERE session_id = @session_id
`);

const stmtDeleteSession = db.prepare<{ session_id: string }>(`
  DELETE FROM sessions WHERE session_id = @session_id
`);

const stmtInsertSessionOrIgnore = db.prepare<NewSession>(`
  INSERT OR IGNORE INTO sessions
    (session_id, notion_task_id, notion_task_url, project_context_url,
     status, started_at, ended_at, pr_url)
  VALUES
    (@session_id, @notion_task_id, @notion_task_url, @project_context_url,
     @status, @started_at, @ended_at, @pr_url)
`);

export function insertSession(s: NewSession): void {
  stmtInsertSession.run({ ended_at: null, pr_url: null, ...s });
}

export function updateSessionStatus(
  sessionId: string,
  status: string,
  endedAt?: number,
): void {
  stmtUpdateSessionStatus.run({
    session_id: sessionId,
    status,
    ended_at: endedAt ?? null,
  });
}

export function getSession(sessionId: string): Session | undefined {
  return stmtGetSession.get({ session_id: sessionId }) as Session | undefined;
}

export function getAllSessions(): Session[] {
  return stmtGetAllSessions.all() as Session[];
}

export function getAllSessionIds(): string[] {
  return (stmtGetAllSessionIds.all() as { session_id: string }[]).map(r => r.session_id);
}

export function insertSessionOrIgnore(s: NewSession): void {
  stmtInsertSessionOrIgnore.run({ ended_at: null, pr_url: null, ...s });
}

export function deleteSession(sessionId: string): boolean {
  stmtDeleteSessionEvents.run({ session_id: sessionId });
  const result = stmtDeleteSession.run({ session_id: sessionId });
  return result.changes > 0;
}

export function getSessionsByStatus(statuses: string[]): Session[] {
  const placeholders = statuses.map(() => '?').join(', ');
  return db.prepare(`
    SELECT * FROM sessions WHERE status IN (${placeholders}) ORDER BY started_at DESC
  `).all(...statuses) as Session[];
}

// ─── session_events ────────────────────────────────────────────────────────

const stmtInsertEvent = db.prepare<NewSessionEvent>(`
  INSERT INTO session_events (session_id, event_type, payload, timestamp)
  VALUES (@session_id, @event_type, @payload, @timestamp)
`);

const stmtInsertEventOrIgnore = db.prepare<NewSessionEvent>(`
  INSERT OR IGNORE INTO session_events (session_id, event_type, payload, timestamp)
  VALUES (@session_id, @event_type, @payload, @timestamp)
`);

const stmtGetEventsBySession = db.prepare<{ session_id: string }>(`
  SELECT * FROM session_events WHERE session_id = @session_id ORDER BY id ASC
`);

export function insertEvent(e: NewSessionEvent): void {
  stmtInsertEvent.run(e);
}

export function insertEventOrIgnore(e: NewSessionEvent): void {
  stmtInsertEventOrIgnore.run(e);
}

export function getEventsBySession(sessionId: string): SessionEvent[] {
  return stmtGetEventsBySession.all({ session_id: sessionId }) as SessionEvent[];
}

// ─── permission_events ─────────────────────────────────────────────────────

const stmtInsertPermissionEvent = db.prepare<NewPermissionEvent>(`
  INSERT INTO permission_events
    (session_id, tool_name, proposed_action, decision, rule_matched, decided_at)
  VALUES
    (@session_id, @tool_name, @proposed_action, @decision, @rule_matched, @decided_at)
`);

export function insertPermissionEvent(e: NewPermissionEvent): void {
  stmtInsertPermissionEvent.run(e);
}

// ─── permission_rules ──────────────────────────────────────────────────────

const stmtGetRules = db.prepare(`
  SELECT * FROM permission_rules WHERE enabled = 1 ORDER BY order_index ASC
`);

const stmtGetAllRules = db.prepare(`
  SELECT * FROM permission_rules ORDER BY order_index ASC
`);

const stmtGetRuleById = db.prepare<{ id: number }>(`
  SELECT * FROM permission_rules WHERE id = @id
`);

const stmtGetMaxOrderIndex = db.prepare(`
  SELECT COALESCE(MAX(order_index), 0) AS max_idx FROM permission_rules
`);

const stmtInsertRule = db.prepare<NewPermissionRule>(`
  INSERT INTO permission_rules
    (order_index, pattern, match_type, decision, label, enabled)
  VALUES
    (@order_index, @pattern, @match_type, @decision, @label, @enabled)
`);

const stmtUpdateRule = db.prepare<{
  id: number;
  order_index?: number;
  pattern?: string;
  match_type?: string;
  decision?: string;
  label?: string | null;
  enabled?: number;
}>(`
  UPDATE permission_rules
  SET
    order_index = COALESCE(@order_index, order_index),
    pattern     = COALESCE(@pattern,     pattern),
    match_type  = COALESCE(@match_type,  match_type),
    decision    = COALESCE(@decision,    decision),
    label       = CASE WHEN @label IS NULL AND @label IS NOT @label
                       THEN label ELSE COALESCE(@label, label) END,
    enabled     = COALESCE(@enabled,     enabled)
  WHERE id = @id
`);

const stmtDeleteRule = db.prepare<{ id: number }>(`
  DELETE FROM permission_rules WHERE id = @id
`);

export function getRules(): PermissionRule[] {
  return stmtGetRules.all() as PermissionRule[];
}

export function getAllRules(): PermissionRule[] {
  return stmtGetAllRules.all() as PermissionRule[];
}

export function getRuleById(id: number): PermissionRule | undefined {
  return stmtGetRuleById.get({ id }) as PermissionRule | undefined;
}

export function insertRule(r: NewPermissionRule): void {
  stmtInsertRule.run(r);
}

export function insertRuleReturning(
  body: Omit<NewPermissionRule, 'order_index'>,
): PermissionRule {
  const { max_idx } = stmtGetMaxOrderIndex.get() as { max_idx: number };
  const r: NewPermissionRule = { ...body, order_index: max_idx + 1 };
  const result = stmtInsertRule.run(r);
  return getRuleById(result.lastInsertRowid as number)!;
}

export function updateRule(id: number, patch: Partial<PermissionRule>): void {
  stmtUpdateRule.run({ id, ...patch });
}

export function deleteRule(id: number): void {
  stmtDeleteRule.run({ id });
}

// ─── task_cache ────────────────────────────────────────────────────────────

const stmtUpsertTaskCache = db.prepare<{
  notion_task_id: string;
  fetched_at: number;
  raw_json: string;
}>(`
  INSERT INTO task_cache (notion_task_id, fetched_at, raw_json)
  VALUES (@notion_task_id, @fetched_at, @raw_json)
  ON CONFLICT(notion_task_id) DO UPDATE SET
    fetched_at = excluded.fetched_at,
    raw_json   = excluded.raw_json
`);

const stmtGetTaskCache = db.prepare<{ notion_task_id: string }>(`
  SELECT * FROM task_cache WHERE notion_task_id = @notion_task_id
`);

export function upsertTaskCache(taskId: string, rawJson: string): void {
  stmtUpsertTaskCache.run({
    notion_task_id: taskId,
    fetched_at: Date.now(),
    raw_json: rawJson,
  });
}

export function getTaskCache(taskId: string): TaskCache | undefined {
  return stmtGetTaskCache.get({ notion_task_id: taskId }) as TaskCache | undefined;
}

export function getCacheAge(taskId: string): number {
  const row = getTaskCache(taskId);
  if (!row) return Infinity;
  return Date.now() - row.fetched_at;
}
