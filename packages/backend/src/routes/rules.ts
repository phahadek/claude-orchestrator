import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getRecentPermissionDenials,
  clearPermissionDenials,
} from '../db/queries';

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
