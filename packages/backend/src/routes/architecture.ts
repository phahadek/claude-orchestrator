import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnit, getUnitEvents, queryUnits } from '../architecture/ArchUnitStore';
import type { ArchUnitKind, ArchUnitStatus } from '../db/types';

/**
 * Read/query surface over the arch_unit store — consumers (dashboard browse
 * panel, session integration, the arch.* command layer) list and look up
 * units here. Writes are not exposed on this route: units are edited only
 * through the command layer's staged-apply path (sibling design), never raw
 * writes from sessions.
 */
export function createArchitectureRouter(): Router {
  const router = Router();

  // GET /api/architecture/units?topic=T&kind=invariant&region=packages/backend&status=active&includeSuperseded=true
  router.get('/architecture/units', (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const stringParam = (key: string): string | undefined =>
      typeof query[key] === 'string' ? (query[key] as string) : undefined;
    res.json(
      queryUnits({
        topic: stringParam('topic'),
        kind: stringParam('kind') as ArchUnitKind | undefined,
        region: stringParam('region'),
        status: stringParam('status') as ArchUnitStatus | undefined,
        includeSuperseded: stringParam('includeSuperseded') === 'true',
      }),
    );
  });

  // GET /api/architecture/units/:id
  router.get('/architecture/units/:id', (req: Request, res: Response) => {
    const unit = getUnit(String(req.params.id));
    if (!unit) {
      res.status(404).json({ error: `no arch unit ${req.params.id}` });
      return;
    }
    res.json(unit);
  });

  // GET /api/architecture/units/:id/events
  router.get(
    '/architecture/units/:id/events',
    (req: Request, res: Response) => {
      const unit = getUnit(String(req.params.id));
      if (!unit) {
        res.status(404).json({ error: `no arch unit ${req.params.id}` });
        return;
      }
      res.json(getUnitEvents(unit.id));
    },
  );

  return router;
}
