import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Scheduler } from '../orchestration/Scheduler';
import {
  reportProjectDeploy,
  getLatestDeployRun,
  listDeployRunEvents,
  DeployRunConflictError,
} from '../deploy/deployService';
import { DeployOrchestrator } from '../deploy/DeployOrchestrator';
import { getProjectRowById } from '../db/queries';
import { logger } from '../logger';

const GATE_RECONCILER_JOB = 'gate_verification_reconciler';

let _scheduler: Scheduler | null = null;

export function setDeployScheduler(s: Scheduler): void {
  _scheduler = s;
}

const orchestrators = new Map<string, DeployOrchestrator>();

/**
 * Lazily builds the one DeployOrchestrator per project. The initial
 * confirm-gate is satisfied by the launch request itself — clicking the
 * gate-panel launch control is the operator's confirmation, so there's no
 * second in-flight pause to wait on here. Agentic steps have no spawner
 * wired up yet, so a playbook step of that kind stalls rather than
 * silently passing.
 */
function getOrchestrator(
  project: string,
  projectDir: string,
): DeployOrchestrator {
  let orchestrator = orchestrators.get(project);
  if (!orchestrator) {
    orchestrator = new DeployOrchestrator(project, projectDir, {
      waitForConfirmGate: async () => true,
      spawnAgenticStep: ({ runId, step }) => {
        logger.warn(
          `[deploy] run ${runId}: agentic step "${step.id}" has no spawner wired up yet`,
        );
      },
    });
    orchestrators.set(project, orchestrator);
  }
  return orchestrator;
}

/**
 * The uniform report-in surface every project's deploy flow calls (skill→
 * orchestrator direction) — including claude-orchestrator itself, no
 * self-hosted carve-out. Fires the gate-verification reconciler on report,
 * event-driven rather than polled.
 */
export function createDeployRouter(): Router {
  const router = Router();

  // POST /api/deploy/report-in  { projectId, sha }
  router.post('/deploy/report-in', (req: Request, res: Response) => {
    const body = req.body as { projectId?: unknown; sha?: unknown };
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;
    const sha = typeof body.sha === 'string' ? body.sha : null;
    if (!projectId || !sha) {
      res.status(400).json({ error: 'projectId and sha are required' });
      return;
    }

    reportProjectDeploy(projectId, sha);

    if (_scheduler) {
      void _scheduler.triggerNow(GATE_RECONCILER_JOB).catch(() => {
        /* errors are logged inside triggerNow */
      });
    }

    res.status(202).json({ projectId, sha });
  });

  // POST /api/deploy/launch  { projectId }
  // Gate-panel launch control: starts a deploy_run targeting the playbook's
  // latest dev (resolved server-side at launch), gated by the playbook's
  // initial confirm-gate.
  router.post('/deploy/launch', async (req: Request, res: Response) => {
    const body = req.body as { projectId?: unknown };
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    const project = getProjectRowById(projectId);
    if (!project) {
      res.status(404).json({ error: `unknown project ${projectId}` });
      return;
    }

    try {
      const orchestrator = getOrchestrator(projectId, project.project_dir);
      const run = await orchestrator.startDeploy();
      res.status(202).json({ run });
    } catch (err) {
      if (err instanceof DeployRunConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'deploy launch failed',
      });
    }
  });

  // GET /api/deploy/status?projectId=...
  // Gate-panel progress read: the project's active deploy_run if any,
  // otherwise its most recent terminal run (so a failure's reason stays
  // visible after the run leaves 'running'), plus its event log.
  router.get('/deploy/status', (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : null;
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    const run = getLatestDeployRun(projectId) ?? null;
    const events = run ? listDeployRunEvents(run.run_id) : [];
    res.status(200).json({ run, events });
  });

  return router;
}
