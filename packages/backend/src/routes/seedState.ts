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
  backfillSeedTask,
} from '../seed/seedService';
import type { SeedItemEventOutcome } from '../db/types';
import { getTaskBackend } from '../tasks/TaskBackend';
import { BackendTaskWriteCommands } from '../tasks/TaskWriteCommands';
import type {
  SeedContributionDecision,
  SeedContributionItemInput,
} from '../tasks/TaskWriteCommands';
import {
  resolveMilestoneForProject,
  resolveMilestoneAnyProject,
  UnknownMilestoneError,
} from '../projects/milestoneResolver';

/**
 * Thin read/write surface over seedService's module functions — the
 * config-seed run API. Business logic (readiness rollup, applyable
 * selection, event/state advance) lives in seedService; routes only parse
 * the request and translate errors to status codes.
 */
export function createSeedStateRouter(): Router {
  const router = Router();

  // GET /api/seed/readiness?project=P&milestone=M12
  router.get('/seed/readiness', (req: Request, res: Response) => {
    const project =
      typeof req.query.project === 'string' ? req.query.project : null;
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }
    try {
      res.json(
        getSeedReadiness(project, resolveMilestoneForProject(project, milestone)),
      );
    } catch (err) {
      if (err instanceof UnknownMilestoneError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // GET /api/seed/next?project=P&milestone=M12&deploySha=abc123&limit=1
  router.get('/seed/next', (req: Request, res: Response) => {
    const project =
      typeof req.query.project === 'string' ? req.query.project : null;
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    const deploySha =
      typeof req.query.deploySha === 'string' ? req.query.deploySha : null;
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
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
    try {
      res.json(
        nextApplyableSeedItems(
          project,
          resolveMilestoneForProject(project, milestone),
          deploySha,
          {
            limit: Number.isFinite(limit) ? limit : undefined,
          },
        ),
      );
    } catch (err) {
      if (err instanceof UnknownMilestoneError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
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
    const project = stringParam('project');
    const milestoneParam = stringParam('milestone');
    let milestone: string | undefined;
    try {
      if (milestoneParam !== undefined) {
        milestone = project
          ? resolveMilestoneForProject(project, milestoneParam)
          : resolveMilestoneAnyProject(milestoneParam);
      }
    } catch (err) {
      if (err instanceof UnknownMilestoneError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    const orderRaw = stringParam('order');
    if (orderRaw !== undefined && orderRaw !== 'not-done-first') {
      res.status(400).json({ error: `unknown order: ${orderRaw}` });
      return;
    }
    res.json(
      listSeedItems({
        project,
        milestone,
        state: stringParam('state'),
        page: numberParam('page'),
        limit: numberParam('limit'),
        order: orderRaw,
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

  // POST /api/seed/backfill  { project, taskId, milestone, candidates }
  router.post('/seed/backfill', async (req: Request, res: Response) => {
    const body = req.body as {
      project?: unknown;
      taskId?: unknown;
      milestone?: unknown;
      candidates?: unknown;
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
    const candidates = Array.isArray(body.candidates)
      ? body.candidates.filter(
          (c): c is { id: string; title: string } =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as { id?: unknown }).id === 'string' &&
            typeof (c as { title?: unknown }).title === 'string',
        )
      : undefined;

    let canonicalMilestone: string;
    try {
      canonicalMilestone = resolveMilestoneForProject(project, milestone);
    } catch (err) {
      if (err instanceof UnknownMilestoneError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    try {
      const result = await backfillSeedTask({
        project,
        taskId,
        milestone: canonicalMilestone,
        candidates,
      });
      res.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'seed backfill failed';
      res.status(message.includes('not found') ? 404 : 409).json({
        error: message,
      });
    }
  });

  // POST /api/seed/accrete-contribution
  //   { project, taskId, title, milestone, decision, seeds: [{ spec }] }
  // The grooming write-path for seed_contribution: mints seed_item rows for
  // the source task's operational data/config seeds and records the
  // seed_accretion marker checkGroomingPromotionGate reads before a
  // Code/Tooling Ready-flip. "none"/"n/a" mint the marker alone, with an
  // empty seeds array.
  router.post(
    '/seed/accrete-contribution',
    async (req: Request, res: Response) => {
      const body = req.body as {
        project?: unknown;
        taskId?: unknown;
        title?: unknown;
        milestone?: unknown;
        decision?: unknown;
        seeds?: unknown;
      };
      const project = typeof body.project === 'string' ? body.project : null;
      const taskId = typeof body.taskId === 'string' ? body.taskId : null;
      const title = typeof body.title === 'string' ? body.title : null;
      const milestone =
        typeof body.milestone === 'string' ? body.milestone : null;
      const decision =
        typeof body.decision === 'string'
          ? (body.decision as SeedContributionDecision)
          : null;
      if (!project) {
        res.status(400).json({ error: 'project is required' });
        return;
      }
      if (!taskId) {
        res.status(400).json({ error: 'taskId is required' });
        return;
      }
      if (!title) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      if (!milestone) {
        res.status(400).json({ error: 'milestone is required' });
        return;
      }
      if (!decision) {
        res.status(400).json({ error: 'decision is required' });
        return;
      }
      const seeds: SeedContributionItemInput[] = Array.isArray(body.seeds)
        ? body.seeds
            .filter(
              (seed): seed is { spec: string } =>
                typeof seed === 'object' &&
                seed !== null &&
                typeof (seed as { spec?: unknown }).spec === 'string',
            )
            .map((seed) => ({ spec: seed.spec }))
        : [];

      try {
        const canonicalMilestone = resolveMilestoneForProject(
          project,
          milestone,
        );
        const backend = getTaskBackend(project);
        const commands = new BackendTaskWriteCommands(backend, project);
        const result = await commands.stageSeedContribution(
          { id: taskId, title, project, milestone: canonicalMilestone },
          seeds,
          decision,
        );
        res.json(result);
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'seed accretion failed',
        });
      }
    },
  );

  return router;
}
