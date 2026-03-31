import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSession, getAllSessions, getSessionsByStatus, deleteSession } from '../db/queries';

export const sessionsRouter = Router();

// GET /api/sessions?status=running,done
sessionsRouter.get('/', (req: Request, res: Response) => {
  const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
  if (statusParam) {
    const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
    res.json(getSessionsByStatus(statuses));
  } else {
    res.json(getAllSessions());
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
