import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getSeedReadiness,
  nextApplyableSeedItems,
  getSeedItem,
  getSeedItemDetail,
  listSeedItems,
  listSeedMilestoneReadiness,
  appendSeedItemEvent,
} from '../seed/seedService';
import type { SeedItemEventOutcome } from '../db/types';

/**
 * Thin read/write surface over seedService's module functions — the
 * config-seed run API. Business logic (readiness rollup, applyable
 * selection, event/state advance) lives in seedService; routes only parse
 * the request and translate errors to status codes.
 */
export function createSeedStateRouter(): Router {
  const router = Router();

  // GET /api/seed/readiness?milestone=M12
  router.get('/seed/readiness', (req: Request, res: Response) => {
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }
    res.json(getSeedReadiness(milestone));
  });

  // GET /api/seed/next?milestone=M12&deploySha=abc123&limit=1
  router.get('/seed/next', (req: Request, res: Response) => {
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    const deploySha =
      typeof req.query.deploySha === 'string' ? req.query.deploySha : null;
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }
    if (!deploySha) {
      res.status(400).json({ error: 'deploySha is required' });
      return;
    }
    const limit =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(
      nextApplyableSeedItems(milestone, deploySha, {
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    );
  });

  // GET /api/seed/items?project=P&milestone=M12&state=pending&page=1&limit=20
  router.get('/seed/items', (req: Request, res: Response) => {
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
      listSeedItems({
        project: stringParam('project'),
        milestone: stringParam('milestone'),
        state: stringParam('state'),
        page: numberParam('page'),
        limit: numberParam('limit'),
      }),
    );
  });

  // GET /api/seed/milestones/readiness?project=P
  router.get('/seed/milestones/readiness', (req: Request, res: Response) => {
    const project =
      typeof req.query.project === 'string' ? req.query.project : undefined;
    res.json(listSeedMilestoneReadiness({ project }));
  });

  // GET /api/seed/items/:id
  router.get('/seed/items/:id', (req: Request, res: Response) => {
    const item = getSeedItem(String(req.params.id));
    if (!item) {
      res.status(404).json({ error: `no seed item ${req.params.id}` });
      return;
    }
    res.json(item);
  });

  // GET /api/seed/items/:id/detail
  router.get('/seed/items/:id/detail', (req: Request, res: Response) => {
    const detail = getSeedItemDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: `no seed item ${req.params.id}` });
      return;
    }
    res.json(detail);
  });

  // POST /api/seed/items/:id/events  { outcome, evidence, filedFollowon, operator }
  router.post('/seed/items/:id/events', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = req.body as {
      outcome?: unknown;
      evidence?: unknown;
      filedFollowon?: unknown;
      operator?: unknown;
    };
    const outcome =
      typeof body.outcome === 'string'
        ? (body.outcome as SeedItemEventOutcome)
        : null;
    if (!outcome) {
      res.status(400).json({ error: 'outcome is required' });
      return;
    }
    try {
      const updated = appendSeedItemEvent(id, {
        outcome,
        evidence: body.evidence,
        filedFollowon:
          typeof body.filedFollowon === 'string'
            ? body.filedFollowon
            : undefined,
        operator: typeof body.operator === 'string' ? body.operator : undefined,
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'seed item event failed',
      });
    }
  });

  return router;
}
