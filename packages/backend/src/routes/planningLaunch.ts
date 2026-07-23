import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadOpsContext } from '../ops/opsLoad';
import { getMilestoneById, getProjectRowById } from '../db/queries';
import type {
  OpsSessionLauncher,
  PlanningSessionType,
  PlanningTaskEntry,
} from '../orchestration/OpsSessionLauncher';
import { toExternalId, normalizeTaskId } from '../tasks/taskId';

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
 * Resolves a launch `workflow` to the SessionManager sessionType it
 * dispatches — see OpsSessionLauncher.PlanningSessionType. Returns null for
 * an unrecognized workflow.
 */
export function resolveSessionType(
  workflow: string,
): PlanningSessionType | null {
  switch (workflow) {
    case 'groom':
      return 'groom';
    case 'design':
      return 'design';
    case 'ops':
    case 'investigation':
      return 'ops';
    default:
      return null;
  }
}

/**
 * Unified planning-session dispatch behind the Groom(N) / Ops(N) launcher
 * buttons: resolves `workflow` to a sessionType and starts one session per
 * selected task via OpsSessionLauncher (generalized to dispatch any
 * planning sessionType, not just 'standard'). Generalizes the earlier
 * /api/ops/launch route.
 */
export function createPlanningLaunchRouter(
  launcher: OpsSessionLauncher,
): Router {
  const router = Router();

  router.post('/planning/launch', async (req: Request, res: Response) => {
    const body = req.body as {
      workflow?: unknown;
      projectId?: unknown;
      milestone?: unknown;
      taskIds?: unknown;
      model?: unknown;
      effort?: unknown;
    };
    const workflow = typeof body.workflow === 'string' ? body.workflow : null;
    const milestoneId =
      typeof body.milestone === 'string' ? body.milestone : null;
    const projectIdParam =
      typeof body.projectId === 'string' ? body.projectId : null;
    const taskIds =
      Array.isArray(body.taskIds) &&
      body.taskIds.every((t) => typeof t === 'string')
        ? (body.taskIds as string[])
        : null;
    const model = typeof body.model === 'string' ? body.model : undefined;
    const effort = typeof body.effort === 'string' ? body.effort : undefined;

    if (!workflow || !milestoneId || !taskIds || taskIds.length === 0) {
      res.status(400).json({
        error: 'workflow, milestone, and a non-empty taskIds[] are required',
      });
      return;
    }

    const sessionType = resolveSessionType(workflow);
    if (!sessionType) {
      res.status(400).json({ error: `unsupported workflow "${workflow}"` });
      return;
    }

    const milestone = getMilestoneById(milestoneId);
    if (!milestone) {
      res.status(404).json({ error: `unknown milestone ${milestoneId}` });
      return;
    }
    if (projectIdParam && projectIdParam !== milestone.project_id) {
      res.status(400).json({
        error: `milestone ${milestoneId} belongs to project ${milestone.project_id}, not ${projectIdParam}`,
      });
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
      if (sessionType === 'ops') {
        // ops / investigation workflow: reuse the ops loader's classification
        // and Depends-On dependency ordering, unchanged from /api/ops/launch.
        const opsContext = await loadOpsContext(milestoneId);
        const selectedIds = new Set(taskIds.map(bareId));
        const tasks = opsContext.worklist.executable.filter((t) =>
          selectedIds.has(bareId(t.id)),
        );
        const result = await launcher.launchSelected({
          projectId: milestone.project_id,
          projectContextUrl: project.context_url ?? '',
          milestoneId,
          sessionType,
          opsContext,
          tasks,
          model,
          effort,
        });
        res.status(202).json(result);
        return;
      }

      // groom / design: dispatch directly per selected task id. No
      // dependency gating and no rich per-task context yet — building that
      // out is the injected-assembler's job, not this dispatch seam's.
      const tasks: PlanningTaskEntry[] = taskIds.map((id) => {
        const cleanId = bareId(id);
        return {
          id: normalizeTaskId(id),
          title: cleanId,
          url: '',
          blockingDepIds: [],
        };
      });
      const result = await launcher.launchSelected({
        projectId: milestone.project_id,
        projectContextUrl: project.context_url ?? '',
        milestoneId,
        sessionType,
        tasks,
        model,
        effort,
      });
      res.status(202).json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'planning launch failed',
      });
    }
  });

  return router;
}
