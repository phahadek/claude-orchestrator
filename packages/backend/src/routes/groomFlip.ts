import { Router } from 'express';
import type { Request, Response } from 'express';
import { getTaskBackend } from '../tasks/TaskBackend';
import {
  BackendTaskWriteCommands,
  type FlipReadyParams,
  type GateContributionDecision,
  type GateContributionItemInput,
  type SeedContributionDecision,
  type SeedContributionItemInput,
} from '../tasks/TaskWriteCommands';
import { GroomingGateError, type GroomingGateEntry } from '../groom/groomGate';
import { ReadinessGateError } from '../tasks/readinessGate';
import { resolveMilestoneForProject } from '../projects/milestoneResolver';

/**
 * The consolidated grooming Ready-flip endpoint: replaces the /groom skill's
 * ~6 separate client calls (gate accrete, seed accrete, setDependsOn,
 * setStatus, each applied) with one request, driven entirely by the caller's
 * grooming-state.json entry for the task — every id (task id, dependsOn ids)
 * comes from that entry, never hand-typed per call. See
 * TaskWriteCommands.flipToReady for the atomic accrete + accrete +
 * setDependsOn + setStatus(Ready) sequence and its rollback-on-failure
 * behavior.
 */
export function createGroomFlipRouter(): Router {
  const router = Router();

  // POST /api/groom/flip
  //   { project, taskId, title, milestone, dependsOn: string[],
  //     groomingGate: {size_check, type_check, ...},
  //     gateContribution: {classification, items: [{text}]},
  //     seedContribution: {decision, seeds: [{spec}]} }
  router.post('/groom/flip', async (req: Request, res: Response) => {
    const body = req.body as {
      project?: unknown;
      taskId?: unknown;
      title?: unknown;
      milestone?: unknown;
      dependsOn?: unknown;
      groomingGate?: unknown;
      gateContribution?: unknown;
      seedContribution?: unknown;
    };

    const project = typeof body.project === 'string' ? body.project : null;
    const taskId = typeof body.taskId === 'string' ? body.taskId : null;
    const title = typeof body.title === 'string' ? body.title : null;
    const milestone =
      typeof body.milestone === 'string' ? body.milestone : null;
    const dependsOn =
      Array.isArray(body.dependsOn) &&
      body.dependsOn.every((id) => typeof id === 'string')
        ? (body.dependsOn as string[])
        : null;
    const groomingGate =
      body.groomingGate && typeof body.groomingGate === 'object'
        ? (body.groomingGate as GroomingGateEntry)
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
    if (!dependsOn) {
      res.status(400).json({ error: 'dependsOn (string[]) is required' });
      return;
    }
    if (!groomingGate) {
      res.status(400).json({ error: 'groomingGate is required' });
      return;
    }

    const gc = body.gateContribution as
      | { classification?: unknown; items?: unknown }
      | undefined;
    const classification =
      typeof gc?.classification === 'string'
        ? (gc.classification as GateContributionDecision)
        : null;
    if (!classification) {
      res
        .status(400)
        .json({ error: 'gateContribution.classification is required' });
      return;
    }
    const gateItems: GateContributionItemInput[] = Array.isArray(gc?.items)
      ? gc.items
          .filter(
            (item): item is { text: string } =>
              typeof item === 'object' &&
              item !== null &&
              typeof (item as { text?: unknown }).text === 'string',
          )
          .map((item) => ({ text: item.text }))
      : [];

    const sc = body.seedContribution as
      | { decision?: unknown; seeds?: unknown }
      | undefined;
    const decision =
      typeof sc?.decision === 'string'
        ? (sc.decision as SeedContributionDecision)
        : null;
    if (!decision) {
      res.status(400).json({ error: 'seedContribution.decision is required' });
      return;
    }
    const seeds: SeedContributionItemInput[] = Array.isArray(sc?.seeds)
      ? sc.seeds
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
      const params: FlipReadyParams = {
        taskId,
        title,
        project,
        milestone: canonicalMilestone,
        dependsOn,
        groomingGate,
        gateContribution: { classification, items: gateItems },
        seedContribution: { decision, seeds },
      };
      const result = await commands.flipToReady(params, { source: 'human' });
      res.json(result);
    } catch (err) {
      if (err instanceof GroomingGateError) {
        res.status(409).json({ error: err.message, reasons: err.reasons });
        return;
      }
      if (err instanceof ReadinessGateError) {
        res
          .status(409)
          .json({ error: err.message, violations: err.violations });
        return;
      }
      res.status(400).json({
        error: err instanceof Error ? err.message : 'grooming Ready-flip failed',
      });
    }
  });

  return router;
}
