import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSession, getActiveSessions, getArchivedSessions, getSessionsByStatus, getSessionsByProject, deleteSession, archiveSession, unarchiveSession, archiveFinishedSessions, setSessionNote, setSessionTags } from '../db/queries';
import type { ServerMessage } from '../ws/types';

let _broadcast: ((msg: ServerMessage) => void) = () => {};
export function setBroadcast(fn: (msg: ServerMessage) => void): void {
  _broadcast = fn;
}

export const sessionsRouter = Router();

// GET /api/sessions/archived
sessionsRouter.get('/archived', (_req: Request, res: Response) => {
  res.json(getArchivedSessions());
});

// GET /api/sessions?status=running,done&projectId=claude-dashboard
sessionsRouter.get('/', (req: Request, res: Response) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const statusParam = typeof req.query.status === 'string' ? req.query.status : '';

  if (projectId) {
    res.json(getSessionsByProject(projectId));
    return;
  }
  if (statusParam) {
    const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
    res.json(getSessionsByStatus(statuses));
  } else {
    res.json(getActiveSessions());
  }
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
  const tags: string[] = Array.isArray(req.body.tags) ? req.body.tags.map(String) : [];
  setSessionTags(sessionId, tags);
  _broadcast({ type: 'session_updated', sessionId, tags });
  res.json({ ok: true });
});
