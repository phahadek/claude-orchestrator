import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadGroomContext } from '../groom/groomLoad';
import { getProjectRowById } from '../db/queries';
import { computeMergeCandidates } from '../orchestration/mergeCandidates';
import { planMerge, type MergePlanInput } from '../orchestration/mergeSession';
import { stageIntent } from './stagedIntents';

/**
 * Read-only surface for the scope-overlap merge-candidate detector
 * (orchestration/mergeCandidates.ts): loads the same milestone context the
 * /groom skill loads (loadGroomContext), then runs the deterministic
 * detector over each task's declared `## Files / paths affected` regions.
 * Advisory only — never auto-merges; candidates are surfaced for operator
 * confirmation.
 *
 * The confirm route is the "route" half of the detect -> confirm -> route
 * flow: given an operator-confirmed pair (+ the milestone dependency graph
 * and merge-set body content, already loaded by the caller), it composes the
 * merge plan via mergeSession.ts's planMerge and stages the resulting
 * intents on the shared staged-intent display (routes/stagedIntents.ts) for
 * human apply. It never calls TaskWriteCommands itself.
 */
export function createMergeCandidatesRouter(): Router {
  const router = Router();

  // GET /api/merge-candidates?milestone=M12&project=p1
  router.get('/merge-candidates', async (req: Request, res: Response) => {
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    const project =
      typeof req.query.project === 'string' ? req.query.project : null;
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }

    let repoRoot: string | undefined;
    if (project) {
      const projectRow = getProjectRowById(project);
      if (!projectRow) {
        res.status(404).json({ error: `unknown project ${project}` });
        return;
      }
      repoRoot = projectRow.project_dir;
    }

    try {
      const result = await loadGroomContext(
        milestone,
        repoRoot ? { repoRoot } : undefined,
      );
      const candidates = computeMergeCandidates(
        result.targetTasks.map((t) => ({
          id: t.id,
          status: t.status,
          regions: t.regions,
        })),
      );
      res.json({ candidates });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'merge-candidates load failed',
      });
    }
  });

  // POST /api/merge-candidates/confirm
  // Body: { projectId, milestoneTasks, mergeSet, survivorId? } — an
  // operator-confirmed candidate pair, routed to planMerge as its mergeSet.
  router.post('/merge-candidates/confirm', (req: Request, res: Response) => {
    const body = req.body as {
      projectId?: unknown;
      milestoneTasks?: unknown;
      mergeSet?: unknown;
      survivorId?: unknown;
    };
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }
    if (!Array.isArray(body.milestoneTasks)) {
      res.status(400).json({ error: 'milestoneTasks must be an array' });
      return;
    }
    if (!Array.isArray(body.mergeSet) || body.mergeSet.length < 2) {
      res
        .status(400)
        .json({ error: 'mergeSet must be an array of at least 2 tasks' });
      return;
    }
    const survivorId =
      typeof body.survivorId === 'string' ? body.survivorId : undefined;

    try {
      const plan = planMerge({
        milestoneTasks: body.milestoneTasks,
        mergeSet: body.mergeSet,
        survivorId,
      } as MergePlanInput);

      const groupId = `merge-${plan.survivorId}-${plan.mergedAwayIds.join('-')}`;
      const staged = plan.intents.map((intent) =>
        stageIntent(intent.kind, intent.payload, projectId, groupId),
      );

      res.status(201).json({ plan, groupId, staged });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'planMerge failed',
      });
    }
  });

  return router;
}
