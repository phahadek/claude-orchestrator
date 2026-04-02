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
     project_id, status, started_at, ended_at, pr_url, worktree_path, session_type)
  VALUES
    (@session_id, @notion_task_id, @notion_task_url, @project_context_url,
     @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path, @session_type)
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
     project_id, status, started_at, ended_at, pr_url, worktree_path, session_type)
  VALUES
    (@session_id, @notion_task_id, @notion_task_url, @project_context_url,
     @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path, @session_type)
`);

export function insertSession(s: NewSession): void {
  stmtInsertSession.run({ ended_at: null, pr_url: null, worktree_path: null, project_id: null, session_type: 'standard', ...s });
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
  stmtInsertSessionOrIgnore.run({ ended_at: null, pr_url: null, worktree_path: null, project_id: null, session_type: 'standard', ...s });
}

export function deleteSession(sessionId: string): boolean {
  stmtDeleteSessionEvents.run({ session_id: sessionId });
  const result = stmtDeleteSession.run({ session_id: sessionId });
  return result.changes > 0;
}

/**
 * Delete sessions that have no events — these are "ghost sessions" created by
 * either empty JSONL imports or session starts that never ran the subprocess.
 * Returns the number of sessions deleted.
 */
export function deleteGhostSessions(): number {
  const result = db.prepare(`
    DELETE FROM sessions
    WHERE session_id NOT IN (SELECT DISTINCT session_id FROM session_events)
  `).run();
  return result.changes;
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

export function favoriteSession(sessionId: string): boolean {
  const result = db.prepare('UPDATE sessions SET favorited = 1 WHERE session_id = ?').run(sessionId);
  return result.changes > 0;
}

export function unfavoriteSession(sessionId: string): boolean {
  const result = db.prepare('UPDATE sessions SET favorited = 0 WHERE session_id = ?').run(sessionId);
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

export function setSessionNote(sessionId: string, note: string | null): void {
  db.prepare('UPDATE sessions SET note = ? WHERE session_id = ?').run(note, sessionId);
}

export function setSessionTags(sessionId: string, tags: string[]): void {
  db.prepare('UPDATE sessions SET tags = ? WHERE session_id = ?').run(JSON.stringify(tags), sessionId);
}

export function getSessionTags(sessionId: string): string[] {
  const row = db.prepare('SELECT tags FROM sessions WHERE session_id = ?').get(sessionId) as { tags: string | null } | undefined;
  if (!row?.tags) return [];
  try { return JSON.parse(row.tags) as string[]; } catch { return []; }
}

// ─── session_events ────────────────────────────────────────────────────────

const stmtInsertEvent = db.prepare<NewSessionEvent & { message_id: string | null }>(`
  INSERT INTO session_events (session_id, event_type, payload, timestamp, message_id)
  VALUES (@session_id, @event_type, @payload, @timestamp, @message_id)
`);

const stmtInsertEventOrIgnore = db.prepare<NewSessionEvent & { message_id: string | null }>(`
  INSERT OR IGNORE INTO session_events (session_id, event_type, payload, timestamp, message_id)
  VALUES (@session_id, @event_type, @payload, @timestamp, @message_id)
`);

const stmtUpdateEventPayload = db.prepare<{ id: number; payload: string; timestamp: number }>(`
  UPDATE session_events SET payload = @payload, timestamp = @timestamp WHERE id = @id
`);

const stmtGetEventsBySession = db.prepare<{ session_id: string }>(`
  SELECT * FROM session_events WHERE session_id = @session_id ORDER BY id ASC
`);

export function insertEvent(e: NewSessionEvent): void {
  stmtInsertEvent.run({ message_id: null, ...e });
}

export function insertEventOrIgnore(e: NewSessionEvent): void {
  stmtInsertEventOrIgnore.run({ message_id: null, ...e });
}

/**
 * Upsert a session event keyed on session_id + message_id.
 * If `existingId` is provided, updates the existing row's payload in-place.
 * Otherwise inserts a new row. Returns the row ID in both cases.
 */
export function upsertSessionEvent(
  e: NewSessionEvent & { message_id?: string | null },
  existingId?: number,
): number {
  if (existingId != null) {
    stmtUpdateEventPayload.run({ id: existingId, payload: e.payload, timestamp: e.timestamp });
    return existingId;
  }
  const result = stmtInsertEvent.run({ message_id: null, ...e });
  return result.lastInsertRowid as number;
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

const stmtClearPermissionDenials = db.prepare(`DELETE FROM permission_denials`);

export function clearPermissionDenials(): void {
  stmtClearPermissionDenials.run();
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

export function deleteDenialsBySession(sessionId: string): void {
  db.prepare<{ session_id: string }>(`
    DELETE FROM permission_denials WHERE session_id = @session_id
  `).run({ session_id: sessionId });
}

export function getRecentPermissionDenials(
  limit: number,
): Array<PermissionDenialRow & { notion_task_url: string | null }> {
  return db
    .prepare(
      `SELECT d.*, s.notion_task_url FROM permission_denials d
       LEFT JOIN sessions s ON d.session_id = s.session_id
       ORDER BY d.id DESC LIMIT ?`,
    )
    .all(limit) as Array<PermissionDenialRow & { notion_task_url: string | null }>;
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
  const row = stmtGetTaskCache.get({ notion_task_id: taskId }) as TaskCache | undefined;
  if (row) return row;
  // Sessions store IDs without hyphens; cache stores UUID format — try the other form
  const alt = taskId.includes('-')
    ? taskId.replace(/-/g, '')
    : taskId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  if (alt === taskId) return undefined;
  return stmtGetTaskCache.get({ notion_task_id: alt }) as TaskCache | undefined;
}

export function getCacheAge(taskId: string): number {
  const row = getTaskCache(taskId);
  if (!row) return Infinity;
  return Date.now() - row.fetched_at;
}

export function incrementTokens(sessionId: string, inputTokens: number, outputTokens: number): void {
  db.prepare(`
    UPDATE sessions
    SET total_input_tokens  = total_input_tokens  + ?,
        total_output_tokens = total_output_tokens + ?
    WHERE session_id = ?
  `).run(inputTokens, outputTokens, sessionId);
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
       head_branch, base_branch, state, draft, review_result, review_at,
       created_at, updated_at, synced_at)
    VALUES
      (@pr_number, @pr_url, @notion_task_id, @session_id, @repo, @title, @body,
       @head_branch, @base_branch, @state, @draft, @review_result, @review_at,
       @created_at, @updated_at, @synced_at)
    ON CONFLICT(pr_url) DO UPDATE SET
      synced_at      = excluded.synced_at,
      state          = excluded.state,
      draft          = excluded.draft,
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

export function getPRs(repo: string): PullRequestRow[] {
  return db.prepare<{ repo: string }>(`
    SELECT * FROM pull_requests WHERE repo = @repo ORDER BY pr_number DESC
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

export function deletePR(prNumber: number, repo: string): boolean {
  const result = db.prepare<{ pr_number: number; repo: string }>(`
    DELETE FROM pull_requests WHERE pr_number = @pr_number AND repo = @repo
  `).run({ pr_number: prNumber, repo });
  return result.changes > 0;
}

// ─── settings ────────────────────────────────────────────────────────────────

export function getSetting(key: string): string | undefined {
  const row = db.prepare<{ key: string }>(`SELECT value FROM settings WHERE key = @key`)
    .get({ key }) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare<{ key: string; value: string }>(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ key, value });
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ─── session_audits ──────────────────────────────────────────────────────────

export interface SessionAuditRow {
  id: number;
  session_id: string;
  pr_opened: number;
  pr_targets: string | null;
  task_status: string | null;
  violations: string;
  spec_mismatch: string | null;
  audited_at: string;
}

export function insertSessionAudit(row: Omit<SessionAuditRow, 'id'>): void {
  db.prepare<Omit<SessionAuditRow, 'id'>>(`
    INSERT INTO session_audits
      (session_id, pr_opened, pr_targets, task_status, violations, spec_mismatch, audited_at)
    VALUES
      (@session_id, @pr_opened, @pr_targets, @task_status, @violations, @spec_mismatch, @audited_at)
  `).run(row);
}

export function getSessionAudit(sessionId: string): SessionAuditRow | undefined {
  return db.prepare<{ session_id: string }>(`
    SELECT * FROM session_audits WHERE session_id = @session_id ORDER BY id DESC LIMIT 1
  `).get({ session_id: sessionId }) as SessionAuditRow | undefined;
}

export function deleteMergedAndClosedPRs(repo: string): number {
  const result = db.prepare<{ repo: string }>(`
    DELETE FROM pull_requests WHERE repo = @repo AND state IN ('merged', 'closed')
  `).run({ repo });
  return result.changes;
}

export function countMergedAndClosedPRs(repo: string): number {
  const row = db.prepare<{ repo: string }>(`
    SELECT COUNT(*) as count FROM pull_requests WHERE repo = @repo AND state IN ('merged', 'closed')
  `).get({ repo }) as { count: number };
  return row.count;
}
