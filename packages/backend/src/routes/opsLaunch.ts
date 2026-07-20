import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadOpsContext } from '../ops/opsLoad';
import { getMilestoneById, getProjectRowById } from '../db/queries';
import type { OpsSessionLauncher } from '../orchestration/OpsSessionLauncher';
import { toExternalId } from '../tasks/taskId';

/**
 * Worklist entry ids from loadOpsContext are bare Notion UUIDs, but the
 * frontend selects tasks by their `source:externalId` task ref (e.g.
 * `notion:<uuid>`). Strip a valid prefix so both forms compare equal.
 */
function bareId(id: string): string {
  try {
    return toExternalId(id);
  } catch {
    return id;
  }
}

/**
 * Ops(N)-button trigger: launches one individual session per selected
 * 🔧 Operational / 🔎 Investigation task, dependency-ordered. Replaces the
 * old placeholder combined-run spawn. Human-triggered only — never called by
 * a poll loop.
 */
export function createOpsLaunchRouter(launcher: OpsSessionLauncher): Router {
  const router = Router();

  router.post('/ops/launch', async (req: Request, res: Response) => {
    const body = req.body as { milestoneId?: unknown; taskIds?: unknown };
    const milestoneId =
      typeof body.milestoneId === 'string' ? body.milestoneId : null;
    const taskIds =
      Array.isArray(body.taskIds) &&
      body.taskIds.every((t) => typeof t === 'string')
        ? (body.taskIds as string[])
        : null;

    if (!milestoneId || !taskIds || taskIds.length === 0) {
      res
        .status(400)
        .json({ error: 'milestoneId and a non-empty taskIds[] are required' });
      return;
    }

    const milestone = getMilestoneById(milestoneId);
    if (!milestone) {
      res.status(404).json({ error: `unknown milestone ${milestoneId}` });
      return;
    }
    const project = getProjectRowById(milestone.project_id);
    if (!project) {
      res
        .status(404)
        .json({ error: `unknown project ${milestone.project_id}` });
      return;
    }

    try {
      const opsContext = await loadOpsContext(milestoneId);
      const selectedIds = new Set(taskIds.map(bareId));
      const tasks = opsContext.worklist.executable.filter((t) =>
        selectedIds.has(bareId(t.id)),
      );
      const result = await launcher.launchSelected({
        projectId: milestone.project_id,
        projectContextUrl: project.context_url ?? '',
        milestoneId,
        opsContext,
        tasks,
      });
      res.status(202).json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'ops launch failed',
      });
    }
  });

  return router;
}
