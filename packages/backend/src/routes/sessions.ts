import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getSession,
  getActiveSessions,
  getArchivedSessions,
  getSessionsByStatus,
  getSessionsByProject,
  deleteSession,
  archiveSession,
  unarchiveSession,
  archiveFinishedSessions,
  setSessionNote,
  setSessionTags,
  favoriteSession,
  unfavoriteSession,
  deleteDenialsBySession,
  getEventsBySession,
  removeGrantedCapability,
  getGrantedCapabilities,
  getSessionLastActivityMs,
} from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { getProjectById } from '../config';
import { getTaskBackend } from '../tasks/TaskBackend';
import { isSystemOnlyUserEvent } from '../utils/eventFilters';
import type { ServerMessage } from '../ws/types';
import { eventKind } from '../session/eventKind';
import type { SessionManager } from '../session/SessionManager';
import { deriveCapabilityProvenance } from '../audit/capabilityProvenance';
import type { Session } from '../db/types';

/** Attaches lastActivityAgeMs — ms since the session's last session_events row, null when unknown (none recorded, or pruned). */
function withActivityAge<T extends Session>(
  session: T,
): T & { lastActivityAgeMs: number | null } {
  const lastActivityTs = getSessionLastActivityMs(session.session_id);
  return {
    ...session,
    lastActivityAgeMs:
      lastActivityTs !== null ? Date.now() - lastActivityTs : null,
  };
}

let _broadcast: (msg: ServerMessage) => void = () => {};
export function setBroadcast(fn: (msg: ServerMessage) => void): void {
  _broadcast = fn;
}

let _sessionManager: SessionManager | null = null;
export function setSessionManager(sm: SessionManager): void {
  _sessionManager = sm;
}

export const sessionsRouter = Router();

// GET /api/sessions/archived
sessionsRouter.get('/archived', (_req: Request, res: Response) => {
  res.json(getArchivedSessions().map(withActivityAge));
});

// GET /api/sessions?status=running,done&projectId=claude-orchestrator
sessionsRouter.get('/', (req: Request, res: Response) => {
  const projectId =
    typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const statusParam =
    typeof req.query.status === 'string' ? req.query.status : '';

  if (projectId) {
    res.json(getSessionsByProject(projectId).map(withActivityAge));
    return;
  }
  if (statusParam) {
    const statuses = statusParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    res.json(getSessionsByStatus(statuses).map(withActivityAge));
  } else {
    res.json(getActiveSessions().map(withActivityAge));
  }
});

// GET /api/sessions/:id/events
sessionsRouter.get('/:id/events', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const rawSession = getSession(sessionId);
  if (!rawSession) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const session = withActivityAge(rawSession);
  const events = getEventsBySession(sessionId)
    .filter((ev) => !isSystemOnlyUserEvent(ev.payload))
    .map((ev) => ({
      eventType: eventKind(ev),
      content: ev.payload,
      timestamp: ev.timestamp,
      ...(ev.message_id != null && { messageId: ev.message_id }),
    }));
  res.json({ session, events });
});

// GET /api/sessions/:id/capabilities
sessionsRouter.get('/:id/capabilities', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const capabilities = deriveCapabilityProvenance(
    sessionId,
    getGrantedCapabilities(sessionId),
  );
  res.json({ capabilities });
});

// DELETE /api/sessions/:id/denials
sessionsRouter.delete('/:id/denials', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const existing = getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  deleteDenialsBySession(sessionId);
  res.status(200).json({ ok: true });
});

// DELETE /api/sessions/:id
sessionsRouter.delete('/:id', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const existing = getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  // Evict the in-memory entry first so a lingering live session can never
  // outlive its DB row and block a future relaunch.
  _sessionManager?.evictSession(sessionId);
  deleteSession(sessionId);
  res.status(200).json({ deleted: sessionId });
});

// POST /api/sessions/archive-finished
sessionsRouter.post('/archive-finished', (_req: Request, res: Response) => {
  const changes = archiveFinishedSessions();
  res.json({ ok: true, archived: changes });
});

// PATCH /api/sessions/:id/archive
sessionsRouter.patch('/:id/archive', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const existing = getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  // Archiving is an explicit operator signal the session is done — reap any
  // live subprocess so it doesn't keep holding a concurrency slot under an
  // archived (dashboard-invisible) row.
  if (_sessionManager) {
    _sessionManager.archiveAndEndSession(sessionId);
  } else {
    archiveSession(sessionId);
  }
  res.json({ ok: true });
});

// PATCH /api/sessions/:id/unarchive
sessionsRouter.patch('/:id/unarchive', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const existing = getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  unarchiveSession(sessionId);
  res.json({ ok: true });
});

// PATCH /api/sessions/:id/favorite
sessionsRouter.patch('/:id/favorite', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const existing = getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  favoriteSession(sessionId);
  res.json({ ok: true });
});

// PATCH /api/sessions/:id/unfavorite
sessionsRouter.patch('/:id/unfavorite', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const existing = getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  unfavoriteSession(sessionId);
  res.json({ ok: true });
});

// PATCH /api/sessions/:id/note
sessionsRouter.patch('/:id/note', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const existing = getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const note: string | null = req.body.note ?? null;
  setSessionNote(sessionId, note);
  _broadcast({ type: 'session_updated', sessionId, note });
  res.json({ ok: true });
});

// PATCH /api/sessions/:id/tags
sessionsRouter.patch('/:id/tags', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const existing = getSession(sessionId);
  if (!existing) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const tags: string[] = Array.isArray(req.body.tags)
    ? req.body.tags.map(String)
    : [];
  setSessionTags(sessionId, tags);
  _broadcast({ type: 'session_updated', sessionId, tags });
  res.json({ ok: true });
});

// PATCH /api/sessions/:id/capabilities/revoke
sessionsRouter.patch(
  '/:id/capabilities/revoke',
  async (req: Request, res: Response) => {
    const sessionId = String(req.params.id);
    const existing = getSession(sessionId);
    if (!existing) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const capability = String(req.body.capability ?? '');
    if (!capability) {
      res.status(400).json({ error: 'capability is required' });
      return;
    }
    const grantedCapabilities = _sessionManager
      ? await _sessionManager.revokeCapability(sessionId, capability)
      : removeGrantedCapability(sessionId, capability);

    recordEvent({
      event_type: 'capability_revoked',
      actor_type: 'human',
      actor_id: sessionId,
      project_id: existing.project_id,
      task_id: existing.task_id,
      payload: { capability },
    });

    _broadcast({ type: 'session_updated', sessionId, grantedCapabilities });
    res.json({ ok: true, grantedCapabilities });
  },
);

// POST /api/sessions/:id/mark-merged
// For local-only projects: mark the task as Done (mirrors the merge step for GitHub projects).
sessionsRouter.post('/:id/mark-merged', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const projectId = session.project_id ?? '';
  const project = getProjectById(projectId);
  if (!project) {
    res.status(400).json({ error: 'Session has no associated project' });
    return;
  }
  if (project.gitMode !== 'local-only') {
    res
      .status(400)
      .json({ error: 'mark-merged is only available for local-only projects' });
    return;
  }

  const notionTaskId = session.task_id;
  if (!notionTaskId) {
    res.status(400).json({ error: 'Session has no associated task' });
    return;
  }

  try {
    await getTaskBackend(projectId).updateStatus(notionTaskId, '✅ Done', {
      source: 'human',
    });
    _broadcast({
      type: 'task_status_changed',
      notionTaskId,
      newStatus: '✅ Done',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error:
        err instanceof Error ? err.message : 'Failed to update task status',
    });
  }
});

// POST /api/sessions/:id/abort
// Kill the session and reset the task to Ready for a fresh launch.
// Unlike Kill, abort pre-marks the session as killed in the DB before sending
// the kill signal, so a server restart cannot resume the aborted session.
sessionsRouter.post('/:id/abort', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  if (!_sessionManager) {
    res.status(503).json({ error: 'Session manager not available' });
    return;
  }

  try {
    await _sessionManager.abortSession(sessionId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to abort session',
    });
  }
});
