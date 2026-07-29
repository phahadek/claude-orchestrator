import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadOpsContext, type OpsLoadResult } from '../ops/opsLoad';
import {
  getMilestoneById,
  getProjectRowById,
  getTaskTitleFromCache,
} from '../db/queries';
import type { MilestoneRow, ProjectRow } from '../db/types';
import type {
  OpsLaunchResult,
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

export interface DispatchPlanningFlowOptions {
  model?: string;
  effort?: string;
  /** Pre-loaded ops context — lets a caller that already loaded it once (the route) skip a second load. */
  opsContext?: OpsLoadResult;
}

/**
 * Planning-flow dispatch shared by the /planning/launch route (one call per
 * request, batching every selected task id) and DispatchTriggerEvaluator
 * (one call per groom candidate, no self-HTTP). Resolves `flow` to a
 * sessionType and builds the PlanningTaskEntry/OpsTaskEntry the launcher
 * needs, mirroring what the route used to build inline for each of its
 * three flow types.
 */
export async function dispatchPlanningFlow(
  launcher: OpsSessionLauncher,
  milestone: MilestoneRow,
  project: ProjectRow,
  flow: string,
  taskIds: string[],
  opts: DispatchPlanningFlowOptions = {},
): Promise<OpsLaunchResult> {
  const sessionType = resolveSessionType(flow);
  if (!sessionType) {
    return {
      launched: [],
      deferred: [],
      failed: taskIds.map((taskId) => ({
        taskId,
        reason: `unsupported workflow "${flow}"`,
      })),
    };
  }

  if (sessionType === 'ops') {
    // ops / investigation workflow: reuse the ops loader's classification
    // and Depends-On dependency ordering.
    const opsContext = opts.opsContext ?? (await loadOpsContext(milestone.id));
    const selectedIds = new Set(taskIds.map(bareId));
    const tasks = opsContext.worklist.executable.filter((t) =>
      selectedIds.has(bareId(t.id)),
    );
    return launcher.launchSelected({
      projectId: project.id,
      projectContextUrl: project.context_url ?? '',
      milestoneId: milestone.id,
      sessionType,
      opsContext,
      tasks,
      model: opts.model,
      effort: opts.effort,
    });
  }

  // groom / design: dispatch directly per task id. No dependency gating
  // here — the evaluator's candidate scan (or a human's selection) is where
  // gating belongs, not the dispatch step itself.
  const tasks: PlanningTaskEntry[] = taskIds.map((id) => {
    const normalizedId = normalizeTaskId(id);
    return {
      id: normalizedId,
      title: getTaskTitleFromCache(normalizedId) || bareId(id),
      url: '',
      blockingDepIds: [],
    };
  });
  return launcher.launchSelected({
    projectId: project.id,
    projectContextUrl: project.context_url ?? '',
    milestoneId: milestone.id,
    sessionType,
    tasks,
    model: opts.model,
    effort: opts.effort,
  });
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
      const result = await dispatchPlanningFlow(
        launcher,
        milestone,
        project,
        workflow,
        taskIds,
        { model, effort },
      );
      res.status(202).json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'planning launch failed',
      });
    }
  });

  return router;
}
