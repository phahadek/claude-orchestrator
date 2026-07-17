import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getGateReadiness,
  reconcileGateRunnability,
  nextRunnableGateItems,
  getGateItem,
  getGateItemDetail,
  listGateItems,
  listMilestoneReadiness,
  appendGateItemEvent,
  approveGateItem,
  backfillGateTask,
} from '../gate/gateService';
import type { GateItemClassification } from '../db/types';

/**
 * Thin read/write surface over gateService's module functions — the
 * Manual Verification Gate's callable interface. Business logic (readiness
 * rollup, runnability reconcile, tiered pull, disposition/consent) lives in
 * gateService; routes only parse the request and translate errors to status codes.
 */
export function createGateStateRouter(): Router {
  const router = Router();

  // GET /api/gate/readiness?milestone=M12
  router.get('/gate/readiness', (req: Request, res: Response) => {
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }
    res.json(getGateReadiness(milestone));
  });

  // POST /api/gate/reconcile  { deploySha }
  router.post('/gate/reconcile', (req: Request, res: Response) => {
    const body = req.body as { deploySha?: unknown };
    const deploySha =
      typeof body.deploySha === 'string' ? body.deploySha : null;
    if (!deploySha) {
      res.status(400).json({ error: 'deploySha is required' });
      return;
    }
    res.json(reconcileGateRunnability(deploySha));
  });

  // GET /api/gate/next?milestone=M12&classification=Read-Only&limit=5
  router.get('/gate/next', (req: Request, res: Response) => {
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }
    const classification =
      typeof req.query.classification === 'string'
        ? (req.query.classification as GateItemClassification)
        : undefined;
    const limit =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(
      nextRunnableGateItems(milestone, {
        classification,
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    );
  });

  // GET /api/gate/items?project=P&milestone=M12&state=open&classification=Read-Only&runnable=true&page=1&limit=20
  router.get('/gate/items', (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const stringParam = (key: string): string | undefined =>
      typeof query[key] === 'string' ? (query[key] as string) : undefined;
    const numberParam = (key: string): number | undefined => {
      const raw = stringParam(key);
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const runnableRaw = stringParam('runnable');
    res.json(
      listGateItems({
        project: stringParam('project'),
        milestone: stringParam('milestone'),
        state: stringParam('state'),
        classification: stringParam('classification') as
          | GateItemClassification
          | undefined,
        runnable:
          runnableRaw === undefined ? undefined : runnableRaw === 'true',
        page: numberParam('page'),
        limit: numberParam('limit'),
      }),
    );
  });

  // GET /api/gate/milestones/readiness?project=P
  router.get('/gate/milestones/readiness', (req: Request, res: Response) => {
    const project =
      typeof req.query.project === 'string' ? req.query.project : undefined;
    res.json(listMilestoneReadiness({ project }));
  });

  // GET /api/gate/items/:id
  router.get('/gate/items/:id', (req: Request, res: Response) => {
    const item = getGateItem(String(req.params.id));
    if (!item) {
      res.status(404).json({ error: `no gate item ${req.params.id}` });
      return;
    }
    res.json(item);
  });

  // GET /api/gate/items/:id/detail
  router.get('/gate/items/:id/detail', (req: Request, res: Response) => {
    const detail = getGateItemDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: `no gate item ${req.params.id}` });
      return;
    }
    res.json(detail);
  });

  // POST /api/gate/items/:id/events  { disposition, evidence, filedFollowon, deploySha, operator }
  router.post('/gate/items/:id/events', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = req.body as {
      disposition?: unknown;
      evidence?: unknown;
      filedFollowon?: unknown;
      deploySha?: unknown;
      operator?: unknown;
    };
    const disposition =
      typeof body.disposition === 'string' ? body.disposition : null;
    if (!disposition) {
      res.status(400).json({ error: 'disposition is required' });
      return;
    }
    try {
      const updated = appendGateItemEvent(id, {
        disposition,
        evidence: body.evidence,
        filedFollowon:
          typeof body.filedFollowon === 'string'
            ? body.filedFollowon
            : undefined,
        deploySha:
          typeof body.deploySha === 'string' ? body.deploySha : undefined,
        operator: typeof body.operator === 'string' ? body.operator : undefined,
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'gate item event failed',
      });
    }
  });

  // POST /api/gate/items/:id/approve  { operator }
  router.post('/gate/items/:id/approve', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = req.body as { operator?: unknown };
    try {
      const updated = approveGateItem(
        id,
        typeof body.operator === 'string' ? body.operator : undefined,
      );
      res.json(updated);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'gate item approval failed',
      });
    }
  });

  // POST /api/gate/backfill  { project, taskId, milestone, milestoneBoardIds }
  router.post('/gate/backfill', async (req: Request, res: Response) => {
    const body = req.body as {
      project?: unknown;
      taskId?: unknown;
      milestone?: unknown;
      milestoneBoardIds?: unknown;
    };
    const project = typeof body.project === 'string' ? body.project : null;
    const taskId = typeof body.taskId === 'string' ? body.taskId : null;
    const milestone =
      typeof body.milestone === 'string' ? body.milestone : null;
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    if (!taskId) {
      res.status(400).json({ error: 'taskId is required' });
      return;
    }
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }
    const milestoneBoardIds = Array.isArray(body.milestoneBoardIds)
      ? body.milestoneBoardIds.filter(
          (id): id is string => typeof id === 'string',
        )
      : undefined;

    try {
      const result = await backfillGateTask({
        project,
        taskId,
        milestone,
        milestoneBoardIds,
      });
      res.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'gate backfill failed';
      res.status(message.includes('not found') ? 404 : 409).json({
        error: message,
      });
    }
  });

  return router;
}
