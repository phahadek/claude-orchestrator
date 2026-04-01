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
  PermissionDenialRow,
  NewPermissionDenialRow,
  TaskCache,
  PullRequestRow,
} from './types';

// ─── sessions ──────────────────────────────────────────────────────────────

const stmtInsertSession = db.prepare<NewSession>(`
  INSERT INTO sessions
    (session_id, notion_task_id, notion_task_url, project_context_url,
     project_id, status, started_at, ended_at, pr_url, worktree_path)
  VALUES
    (@session_id, @notion_task_id, @notion_task_url, @project_context_url,
     @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path)
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
     project_id, status, started_at, ended_at, pr_url, worktree_path)
  VALUES
    (@session_id, @notion_task_id, @notion_task_url, @project_context_url,
     @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path)
`);

export function insertSession(s: NewSession): void {
  stmtInsertSession.run({ ended_at: null, pr_url: null, worktree_path: null, project_id: null, ...s });
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
  stmtInsertSessionOrIgnore.run({ ended_at: null, pr_url: null, worktree_path: null, project_id: null, ...s });
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

export function getActiveSessions(): Session[] {
  return db.prepare('SELECT * FROM sessions WHERE archived = 0 ORDER BY started_at DESC').all() as Session[];
}

export function getArchivedSessions(): Session[] {
  return db.prepare('SELECT * FROM sessions WHERE archived = 1 ORDER BY started_at DESC').all() as Session[];
}

export function archiveSession(sessionId: string): boolean {
  const result = db.prepare('UPDATE sessions SET archived = 1 WHERE session_id = ?').run(sessionId);
  return result.changes > 0;
}

export function unarchiveSession(sessionId: string): boolean {
  const result = db.prepare('UPDATE sessions SET archived = 0 WHERE session_id = ?').run(sessionId);
  return result.changes > 0;
}

export function archiveFinishedSessions(): number {
  const result = db.prepare(
    `UPDATE sessions SET archived = 1 WHERE status IN ('done', 'error', 'killed')`
  ).run();
  return result.changes;
}

export function getSessionsByProject(projectId: string): Session[] {
  return db.prepare(
    'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC'
  ).all(projectId) as Session[];
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

export function getRecentPermissionEvents(
  limit: number,
): Array<PermissionEvent & { notion_task_url: string | null }> {
  return db
    .prepare(
      `SELECT pe.*, s.notion_task_url FROM permission_events pe
       LEFT JOIN sessions s ON pe.session_id = s.session_id
       ORDER BY pe.decided_at DESC LIMIT ?`,
    )
    .all(limit) as Array<PermissionEvent & { notion_task_url: string | null }>;
}

const stmtClearPermissionEvents = db.prepare(`DELETE FROM permission_events`);

export function clearPermissionEvents(): void {
  stmtClearPermissionEvents.run();
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

// ─── permission_denials ─────────────────────────────────────────────────────

const stmtInsertPermissionDenial = db.prepare<NewPermissionDenialRow>(`
  INSERT INTO permission_denials (session_id, tool_name, tool_use_id, tool_input, timestamp)
  VALUES (@session_id, @tool_name, @tool_use_id, @tool_input, @timestamp)
`);

const stmtGetDenialsBySession = db.prepare<{ session_id: string }>(`
  SELECT * FROM permission_denials WHERE session_id = @session_id ORDER BY id ASC
`);

export function insertPermissionDenial(d: NewPermissionDenialRow): void {
  stmtInsertPermissionDenial.run(d);
}

export function getDenialsBySession(sessionId: string): PermissionDenialRow[] {
  return stmtGetDenialsBySession.all({ session_id: sessionId }) as PermissionDenialRow[];
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

export function getTaskTitleFromCache(taskId: string): string | null {
  const row = getTaskCache(taskId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.raw_json) as { title?: unknown };
    return typeof parsed.title === 'string' ? parsed.title : null;
  } catch {
    return null;
  }
}

// ─── pull_requests ──────────────────────────────────────────────────────────

export function upsertPullRequest(pr: Omit<PullRequestRow, 'id'>): PullRequestRow {
  db.prepare<Omit<PullRequestRow, 'id'>>(`
    INSERT INTO pull_requests
      (pr_number, pr_url, notion_task_id, session_id, repo, title, body,
       head_branch, base_branch, state, review_result, review_at,
       created_at, updated_at, synced_at)
    VALUES
      (@pr_number, @pr_url, @notion_task_id, @session_id, @repo, @title, @body,
       @head_branch, @base_branch, @state, @review_result, @review_at,
       @created_at, @updated_at, @synced_at)
    ON CONFLICT(pr_url) DO UPDATE SET
      synced_at      = excluded.synced_at,
      state          = excluded.state,
      title          = COALESCE(excluded.title, title),
      body           = COALESCE(excluded.body, body),
      head_branch    = COALESCE(excluded.head_branch, head_branch),
      base_branch    = COALESCE(excluded.base_branch, base_branch),
      notion_task_id = COALESCE(excluded.notion_task_id, notion_task_id),
      session_id     = COALESCE(excluded.session_id, session_id),
      updated_at     = excluded.updated_at
  `).run(pr);
  return db.prepare<{ pr_url: string }>(`
    SELECT * FROM pull_requests WHERE pr_url = @pr_url
  `).get({ pr_url: pr.pr_url }) as PullRequestRow;
}

export function getOpenPRs(repo: string): PullRequestRow[] {
  return db.prepare<{ repo: string }>(`
    SELECT * FROM pull_requests WHERE repo = @repo AND state = 'open' ORDER BY pr_number DESC
  `).all({ repo }) as PullRequestRow[];
}

export function getPRByNumber(prNumber: number, repo: string): PullRequestRow | null {
  return db.prepare<{ pr_number: number; repo: string }>(`
    SELECT * FROM pull_requests WHERE pr_number = @pr_number AND repo = @repo
  `).get({ pr_number: prNumber, repo }) as PullRequestRow | null;
}

export function setPRReviewResult(prNumber: number, repo: string, result: string): void {
  db.prepare<{ pr_number: number; repo: string; review_result: string; review_at: string }>(`
    UPDATE pull_requests
    SET review_result = @review_result, review_at = @review_at
    WHERE pr_number = @pr_number AND repo = @repo
  `).run({ pr_number: prNumber, repo, review_result: result, review_at: new Date().toISOString() });
}

export function updatePRState(prNumber: number, repo: string, state: string): void {
  db.prepare<{ pr_number: number; repo: string; state: string }>(`
    UPDATE pull_requests SET state = @state WHERE pr_number = @pr_number AND repo = @repo
  `).run({ pr_number: prNumber, repo, state });
}
