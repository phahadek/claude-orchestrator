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
} from '../db/queries';
import { getProjectById } from '../config';
import { getTaskBackend } from '../tasks/TaskBackend';
import { isSystemOnlyUserEvent } from '../utils/eventFilters';
import type { ServerMessage } from '../ws/types';

let _broadcast: (msg: ServerMessage) => void = () => {};
export function setBroadcast(fn: (msg: ServerMessage) => void): void {
  _broadcast = fn;
}

export const sessionsRouter = Router();

// GET /api/sessions/archived
sessionsRouter.get('/archived', (_req: Request, res: Response) => {
  res.json(getArchivedSessions());
});

// GET /api/sessions?status=running,done&projectId=claude-orchestrator
sessionsRouter.get('/', (req: Request, res: Response) => {
  const projectId =
    typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const statusParam =
    typeof req.query.status === 'string' ? req.query.status : '';

  if (projectId) {
    res.json(getSessionsByProject(projectId));
    return;
  }
  if (statusParam) {
    const statuses = statusParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    res.json(getSessionsByStatus(statuses));
  } else {
    res.json(getActiveSessions());
  }
});

// GET /api/sessions/:id/events
sessionsRouter.get('/:id/events', (req: Request, res: Response) => {
  const sessionId = String(req.params.id);
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const events = getEventsBySession(sessionId)
    .filter((ev) => !isSystemOnlyUserEvent(ev.payload))
    .map((ev) => ({
      eventType: ev.event_type,
      content: ev.payload,
      timestamp: ev.timestamp,
      ...(ev.message_id != null && { messageId: ev.message_id }),
    }));
  res.json({ session, events });
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
  archiveSession(sessionId);
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

  const notionTaskId = session.notion_task_id;
  if (!notionTaskId) {
    res.status(400).json({ error: 'Session has no associated task' });
    return;
  }

  try {
    await getTaskBackend(projectId).updateStatus(notionTaskId, '✅ Done');
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
