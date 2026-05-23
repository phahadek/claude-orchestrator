import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getRecentPermissionEvents,
  clearPermissionEvents,
  getRecentPermissionDenials,
  clearPermissionDenials,
} from '../db/queries';

// ─── Permission events router ───────────────────────────────────────────────

export const permissionEventsRouter = Router();

// GET /api/permission-events
permissionEventsRouter.get('/', (_req: Request, res: Response) => {
  const rows = getRecentPermissionEvents(200);
  res.json(rows);
});

// DELETE /api/permission-events
permissionEventsRouter.delete('/', (_req: Request, res: Response) => {
  clearPermissionEvents();
  res.status(200).json({ cleared: true });
});

// ─── Permission denials router ───────────────────────────────────────────────

export const permissionDenialsRouter = Router();

// GET /api/permission-denials
permissionDenialsRouter.get('/', (_req: Request, res: Response) => {
  const rows = getRecentPermissionDenials(200);
  res.json(rows);
});

// DELETE /api/permission-denials
permissionDenialsRouter.delete('/', (_req: Request, res: Response) => {
  clearPermissionDenials();
  res.status(200).json({ cleared: true });
});
