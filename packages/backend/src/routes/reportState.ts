import { Router, json } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  createReport,
  updateDraftReport,
  commitReport,
  abandonReport,
  getReportWithDerived,
  getReportImagePath,
  listReports,
} from '../investigation/reportService';

const IMAGE_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Body-size limit for the routes under /api/reports, which include the two
 * that accept a base64 screenshot (POST /reports, PATCH /reports/:id).
 * 12mb admits an 8MB decoded image plus base64's ~33% inflation and JSON
 * overhead; the route logic then validates the decoded byte length against
 * the real 8MB cap. This must be mounted in server.ts BEFORE the global
 * express.json() (whose small default limit would otherwise 413 an
 * oversized body before it ever reaches this router) — body-parser skips
 * re-parsing a body it's already consumed, so the global parser becomes a
 * no-op for these paths once this one has run. Scoped to just the
 * /api/reports path prefix, not the app's global default.
 */
export const reportImageBodyParser = json({ limit: '12mb' });

/**
 * Thin read/write surface over reportService's module functions — the
 * investigation_report intake/lifecycle's callable interface. Business
 * logic (the state-machine guards, resolve/blocking computations) lives in
 * reportService; routes only parse the request and translate errors to
 * status codes, mirroring routes/gateState.ts's convention. Dispatching a
 * report into a session is out of scope here — see the sibling dispatch
 * flow's routes.
 */
export function createReportStateRouter(): Router {
  const router = Router();

  // POST /api/reports  { projectId, milestoneId?, title, symptomText, evidenceText?, image?, source?, originSessionId?, originTaskId? }
  router.post('/reports', (req: Request, res: Response) => {
    const body = req.body as {
      projectId?: unknown;
      milestoneId?: unknown;
      title?: unknown;
      symptomText?: unknown;
      evidenceText?: unknown;
      image?: unknown;
      source?: unknown;
      originSessionId?: unknown;
      originTaskId?: unknown;
    };
    try {
      const report = createReport({
        projectId: typeof body.projectId === 'string' ? body.projectId : '',
        milestoneId:
          typeof body.milestoneId === 'string' ? body.milestoneId : undefined,
        title: typeof body.title === 'string' ? body.title : '',
        symptomText:
          typeof body.symptomText === 'string' ? body.symptomText : '',
        evidenceText:
          typeof body.evidenceText === 'string' ? body.evidenceText : undefined,
        image: typeof body.image === 'string' ? body.image : undefined,
        source:
          body.source === 'operator' || body.source === 'session'
            ? body.source
            : undefined,
        originSessionId:
          typeof body.originSessionId === 'string'
            ? body.originSessionId
            : undefined,
        originTaskId:
          typeof body.originTaskId === 'string' ? body.originTaskId : undefined,
      });
      res.status(201).json(report);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'report creation failed',
      });
    }
  });

  // GET /api/reports?project=P&milestone=M&state=draft&page=1&limit=20
  router.get('/reports', (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const stringParam = (key: string): string | undefined =>
      typeof query[key] === 'string' ? (query[key] as string) : undefined;
    const numberParam = (key: string): number | undefined => {
      const raw = stringParam(key);
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    try {
      res.json(
        listReports({
          project: stringParam('project'),
          milestone: stringParam('milestone'),
          state: stringParam('state'),
          page: numberParam('page'),
          limit: numberParam('limit'),
        }),
      );
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'report list failed',
      });
    }
  });

  // GET /api/reports/:id
  router.get('/reports/:id', (req: Request, res: Response) => {
    const report = getReportWithDerived(String(req.params.id));
    if (!report) {
      res
        .status(404)
        .json({ error: `no investigation report ${req.params.id}` });
      return;
    }
    res.json(report);
  });

  // GET /api/reports/:id/image
  router.get('/reports/:id/image', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const lookup = getReportImagePath(id);
    if (!lookup.report || !lookup.path || !fs.existsSync(lookup.path)) {
      res.status(404).json({ error: `no image for investigation report ${id}` });
      return;
    }
    const extension = path.extname(lookup.path).toLowerCase();
    const contentType =
      IMAGE_CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.sendFile(lookup.path);
  });

  // PATCH /api/reports/:id  { title?, symptomText?, evidenceText?, milestoneId?, image? }
  router.patch('/reports/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = req.body as {
      title?: unknown;
      symptomText?: unknown;
      evidenceText?: unknown;
      milestoneId?: unknown;
      image?: unknown;
    };
    try {
      const report = updateDraftReport(id, {
        title: typeof body.title === 'string' ? body.title : undefined,
        symptomText:
          typeof body.symptomText === 'string' ? body.symptomText : undefined,
        evidenceText:
          body.evidenceText === null
            ? null
            : typeof body.evidenceText === 'string'
              ? body.evidenceText
              : undefined,
        milestoneId:
          typeof body.milestoneId === 'string' ? body.milestoneId : undefined,
        image:
          body.image === null
            ? null
            : typeof body.image === 'string'
              ? body.image
              : undefined,
      });
      res.json(report);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'report update failed',
      });
    }
  });

  // POST /api/reports/:id/commit
  router.post('/reports/:id/commit', (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      res.json(commitReport(id));
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'report commit failed',
      });
    }
  });

  // POST /api/reports/:id/abandon
  router.post('/reports/:id/abandon', (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      res.json(abandonReport(id));
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'report abandon failed',
      });
    }
  });

  return router;
}
