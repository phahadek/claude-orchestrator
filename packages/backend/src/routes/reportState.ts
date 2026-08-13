import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  createReport,
  updateDraftReport,
  commitReport,
  abandonReport,
  getReportWithDerived,
  listReports,
} from '../investigation/reportService';

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

  // POST /api/reports  { projectId, milestoneId?, title, symptomText, evidenceText?, source?, originSessionId?, originTaskId? }
  router.post('/reports', (req: Request, res: Response) => {
    const body = req.body as {
      projectId?: unknown;
      milestoneId?: unknown;
      title?: unknown;
      symptomText?: unknown;
      evidenceText?: unknown;
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
    res.json(
      listReports({
        project: stringParam('project'),
        milestone: stringParam('milestone'),
        state: stringParam('state'),
        page: numberParam('page'),
        limit: numberParam('limit'),
      }),
    );
  });

  // GET /api/reports/:id
  router.get('/reports/:id', (req: Request, res: Response) => {
    const report = getReportWithDerived(String(req.params.id));
    if (!report) {
      res.status(404).json({ error: `no investigation report ${req.params.id}` });
      return;
    }
    res.json(report);
  });

  // PATCH /api/reports/:id  { title?, symptomText?, evidenceText?, milestoneId? }
  router.patch('/reports/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = req.body as {
      title?: unknown;
      symptomText?: unknown;
      evidenceText?: unknown;
      milestoneId?: unknown;
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
