import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Scheduler } from '../orchestration/Scheduler';
import {
  reportProjectDeploy,
  getLatestDeployRun,
  listDeployRunEvents,
  appendDeployRunEvent,
  DeployRunConflictError,
} from '../deploy/deployService';
import {
  DeployOrchestrator,
  buildDeployAgenticTaskId,
} from '../deploy/DeployOrchestrator';
import type { StepDescriptor } from '../deploy/playbookSchema';
import { loadDeployPlaybook } from '../deploy/loadPlaybook';
import {
  getProjectRowById,
  getProjectDeployedShaRow,
  listMergedSince,
  getSession,
  hasActiveCapabilityRequestForSession,
  markSessionDone,
  setSessionTerminalCompletionReason,
  insertCompletingSignal,
  TERMINAL_SESSION_STATUSES,
  getLatestOpsSessionByTaskId,
} from '../db/queries';
import type { ProjectRow } from '../db/types';
import { getProjectById } from '../config';
import type { SessionManager } from '../session/SessionManager';
import type { DeployAgenticVerdictPayload } from '../session/AgentSession';
import {
  renderOpsCapabilities,
  renderProjectRecordAccess,
} from '../planning/procedureAssembler';
import { orchestratorMcpToolName } from '../mcp/toolNaming';
import { logger } from '../logger';
import { asyncHandler } from './asyncHandler';

const GATE_RECONCILER_JOB = 'gate_verification_reconciler';

/** Wall-clock budget per runId:stepId before an agentic step abstains to `inconclusive`. Mirrors gate-verify's default. */
const DEFAULT_AGENTIC_STEP_BUDGET_MS = 20 * 60_000;
/** Poll cadence while a budget is suspended behind an outstanding capability request. */
const CAPABILITY_POLL_INTERVAL_MS = 5_000;

let _scheduler: Scheduler | null = null;

export function setDeployScheduler(s: Scheduler): void {
  _scheduler = s;
}

let _deployAgenticStepSpawner: DeployAgenticStepSpawner | null = null;

/**
 * Wires the SessionManager the agentic-step spawner dispatches sessions
 * through. Must be called before any deploy run reaches an `agentic` step —
 * server.ts calls this immediately after constructing SessionManager, ahead
 * of the boot-time resumeActiveDeployRuns() call below.
 */
export function setDeploySessionManager(sessionManager: SessionManager): void {
  _deployAgenticStepSpawner = new DeployAgenticStepSpawner(
    sessionManager,
    (project) => orchestrators.get(project),
  );
}

const orchestrators = new Map<string, DeployOrchestrator>();

/**
 * The injected procedure a dispatched agentic-step session runs under —
 * assembled and passed as `injectedProcedureContent`, mirroring
 * gateItemVerifier.ts's buildGateVerifyProcedure. This makes
 * SessionManager.start() use it verbatim (no worktree, no
 * buildOrchestratorClaudeMd code-session scaffold): the session is a
 * bounded, one-shot investigation into whether a production-mutating
 * playbook step is safe/correct to proceed past, not a code session.
 */
function buildDeployAgenticStepProcedure(input: {
  runId: string;
  project: string;
  step: StepDescriptor;
}): string {
  const { runId, project, step } = input;
  return [
    '## Session Lifecycle',
    '',
    'This is an injected, non-interactive, one-shot session dispatched to ' +
      `settle a single \`agentic\` deploy-playbook step (run ${runId}, step ` +
      `"${step.id}") for project "${project}". It is not auto-dispatched ` +
      'onto anything else. There is no worktree and no feature branch, and ' +
      'this session never stages code, opens a PR, or drives an ops_journal ' +
      'transition. Its only job is to carry out the instruction below and ' +
      'report exactly one verdict, then end the turn — there is no ' +
      'follow-up loop or review cycle to wait for, and no operator sits ' +
      'between your report and the deploy engine acting on it.',
    '',
    '### Step instruction',
    '',
    step.command_or_prompt ?? '(no instruction text)',
    '',
    ...renderProjectRecordAccess('ops', project),
    ...renderOpsCapabilities(),
    '### Procedure',
    '',
    'Carry out the instruction above using your available read tools and ' +
      'the operational record (audit_log, session_events, live DB/API ' +
      'state, an observed runtime occurrence) — never guess, and never ' +
      'infer a pass from source code alone. This is a bounded best-effort ' +
      'read: settle within your time/turn budget, or report `inconclusive`. ' +
      'You hold no general write authority beyond the base read/stage ' +
      'profile above — if the instruction genuinely requires a write this ' +
      'session was not granted, stage a `session.requestCapability` intent ' +
      'naming it and end the turn; a blocked read or missing capability is ' +
      'grounds for `inconclusive`, never for guessing.',
    '',
    'Report your finding by calling the ' +
      `\`${orchestratorMcpToolName('deploy.verdict')}\` tool exactly once, ` +
      'as your final action — never a chat block, which is not delivered ' +
      "anywhere and leaves the deploy run stalled until this session's " +
      'budget expires. `verdict` is one of `approved` (the step is safe/' +
      'correct to proceed past), `rejected` (it is not — the deploy engine ' +
      'halts the run), or `inconclusive` (you could not conclusively ' +
      'determine either, e.g. a blocked read or a genuinely ambiguous ' +
      'result — this halts the run for operator investigation, the same ' +
      'as `rejected`, but is reported honestly rather than guessed):',
    '',
    '```json',
    `{"verdict": "approved"|"rejected"|"inconclusive", "detail": "..."}`,
    '```',
  ].join('\n');
}

/**
 * Dispatches (or reattaches to) the one-shot `ops` session that settles an
 * `agentic` deploy-playbook step, mirroring SessionGateItemVerifier's
 * dispatch shape, wall-clock budget, and resume-time reattachment.
 *
 * Unlike a gate-verify session's report (staged for an operator to
 * dispose), a deploy-agentic-step verdict goes straight to
 * `DeployOrchestrator.reportAgenticVerdict()` — there is no staged intent
 * and no operator disposition in the loop, so this class tears the session
 * down (markSessionDone + archiveAndEndSession) as soon as it settles,
 * whether by report or by timeout, rather than leaving it parked.
 */
export class DeployAgenticStepSpawner {
  private readonly budgetMs: number;
  private readonly pending = new Map<
    string,
    {
      runId: string;
      stepId: string;
      project: string;
      sessionId: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** A verdict that arrived before its dispatch's `arm()` call landed (a fast session racing `SessionManager.start()`'s own resolution). */
  private readonly earlyVerdicts = new Map<
    string,
    DeployAgenticVerdictPayload
  >();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly getOrchestrator: (
      project: string,
    ) => DeployOrchestrator | undefined,
    options: { budgetMs?: number } = {},
  ) {
    this.budgetMs = options.budgetMs ?? DEFAULT_AGENTIC_STEP_BUDGET_MS;
    this.sessionManager.on('deploy_agentic_verdict', (payload: unknown) => {
      this.handleVerdict(payload as DeployAgenticVerdictPayload);
    });
  }

  private key(runId: string, stepId: string): string {
    return `${runId}:${stepId}`;
  }

  /** Fire-and-forget entrypoint matching DeployOrchestratorDeps's AgenticStepSpawner shape. */
  spawn(input: { runId: string; project: string; step: StepDescriptor }): void {
    void this.dispatchOrReattach(input).catch((err) => {
      logger.error(
        `[deploy] run ${input.runId}: agentic step "${input.step.id}" spawner failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.getOrchestrator(input.project)?.reportAgenticVerdict(
        input.runId,
        input.step.id,
        'inconclusive',
        `agentic step spawner failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async dispatchOrReattach(input: {
    runId: string;
    project: string;
    step: StepDescriptor;
  }): Promise<void> {
    const { runId, project, step } = input;
    const taskId = buildDeployAgenticTaskId(runId, step.id);

    // Resume-time reattachment: a still-live session already dispatched for
    // this exact run/step (e.g. before a backend restart lost the in-memory
    // budget timer and verdict listener) is reattached rather than
    // re-dispatched — a fresh dispatch here would leave two sessions racing
    // to settle the same step.
    const existing = getLatestOpsSessionByTaskId(taskId);
    if (existing && !TERMINAL_SESSION_STATUSES.has(existing.status)) {
      logger.info(
        `[deploy] run ${runId}: reattaching to live agentic-step session ${existing.session_id.slice(0, 8)} for step "${step.id}"`,
      );
      this.arm(runId, step.id, project, existing.session_id);
      return;
    }

    const projectConfig = getProjectById(project);
    if (!projectConfig) {
      this.getOrchestrator(project)?.reportAgenticVerdict(
        runId,
        step.id,
        'inconclusive',
        `unknown project "${project}"`,
      );
      return;
    }

    const sessionId = await this.sessionManager.start(
      taskId,
      projectConfig.contextUrl,
      {
        projectId: project,
        taskName: `Deploy agentic step: ${step.id}`,
        sessionType: 'ops',
        taskKind: 'non_milestone',
        taskId,
        injectedProcedureContent: buildDeployAgenticStepProcedure(input),
      },
    );
    this.arm(runId, step.id, project, sessionId);
  }

  private arm(
    runId: string,
    stepId: string,
    project: string,
    sessionId: string,
  ): void {
    const key = this.key(runId, stepId);
    const early = this.earlyVerdicts.get(key);
    if (early && early.sessionId === sessionId) {
      this.earlyVerdicts.delete(key);
      this.settleVerdict(early);
      return;
    }
    const timer = setTimeout(
      () => this.onBudgetFire(runId, stepId, project, sessionId),
      this.budgetMs,
    );
    this.pending.set(key, { runId, stepId, project, sessionId, timer });
  }

  /**
   * Exempted while the session has a pending `session.requestCapability`
   * intent outstanding — a budget firing mid-request would tear the session
   * down out from under a legitimately parked capability request, racing
   * the human review it exists to wait for. Mirrors
   * SessionGateItemVerifier's onBudgetFire/waitForCapabilityClear.
   */
  private onBudgetFire(
    runId: string,
    stepId: string,
    project: string,
    sessionId: string,
  ): void {
    const key = this.key(runId, stepId);
    if (hasActiveCapabilityRequestForSession(sessionId)) {
      logger.info(
        `[deploy] agentic-step session ${sessionId.slice(0, 8)} exceeded budget while a capability request was outstanding — suspending budget until it clears`,
      );
      const timer = setTimeout(
        () => this.waitForCapabilityClear(runId, stepId, project, sessionId),
        CAPABILITY_POLL_INTERVAL_MS,
      );
      this.pending.set(key, { runId, stepId, project, sessionId, timer });
      return;
    }
    this.settleTimeout(runId, stepId, project, sessionId);
  }

  private waitForCapabilityClear(
    runId: string,
    stepId: string,
    project: string,
    sessionId: string,
  ): void {
    const key = this.key(runId, stepId);
    if (hasActiveCapabilityRequestForSession(sessionId)) {
      const timer = setTimeout(
        () => this.waitForCapabilityClear(runId, stepId, project, sessionId),
        CAPABILITY_POLL_INTERVAL_MS,
      );
      this.pending.set(key, { runId, stepId, project, sessionId, timer });
      return;
    }
    const timer = setTimeout(
      () => this.onBudgetFire(runId, stepId, project, sessionId),
      this.budgetMs,
    );
    this.pending.set(key, { runId, stepId, project, sessionId, timer });
  }

  private settleTimeout(
    runId: string,
    stepId: string,
    project: string,
    sessionId: string,
  ): void {
    const key = this.key(runId, stepId);
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);

    appendDeployRunEvent({
      runId,
      step: stepId,
      eventType: 'agentic_step_timeout',
      detail: `agentic step session ${sessionId} exceeded its ${this.budgetMs}ms verification budget`,
      at: new Date().toISOString(),
    });
    this.teardownSession(sessionId, 'deploy_agentic_step_timeout');
    this.getOrchestrator(project)?.reportAgenticVerdict(
      runId,
      stepId,
      'inconclusive',
      'agentic step verification budget exceeded',
    );
  }

  private handleVerdict(payload: DeployAgenticVerdictPayload): void {
    const key = this.key(payload.runId, payload.stepId);
    const entry = this.pending.get(key);
    if (!entry || entry.sessionId !== payload.sessionId) {
      // Arrived before this dispatch's arm() call landed — buffer it so
      // arm() can settle it immediately once the dispatch resolves.
      this.earlyVerdicts.set(key, payload);
      return;
    }
    this.settleVerdict(payload);
  }

  private settleVerdict(payload: DeployAgenticVerdictPayload): void {
    const key = this.key(payload.runId, payload.stepId);
    const entry = this.pending.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(key);
    }
    this.teardownSession(payload.sessionId, 'deploy_agentic_verdict_reported');
    this.getOrchestrator(payload.projectId)?.reportAgenticVerdict(
      payload.runId,
      payload.stepId,
      payload.verdict,
      payload.detail,
    );
  }

  /** Reaps a one-shot agentic-step session once it has settled (report or timeout) — never left parked, unlike a gate-verify session. */
  private teardownSession(sessionId: string, reason: string): void {
    const row = getSession(sessionId);
    if (row && !TERMINAL_SESSION_STATUSES.has(row.status)) {
      markSessionDone(sessionId, Date.now(), null, reason);
      setSessionTerminalCompletionReason(sessionId, reason);
      // Dual-write bridge (see session/completingSignalRegistry.ts and
      // sessionStatusDeriver.ts) — purely additive ahead of any read-side
      // cutover; never gates or alters the writes above.
      insertCompletingSignal({
        session_id: sessionId,
        task_id: row.task_id ?? null,
        session_type: row.session_type,
        signal_class: 'staged_intent',
        signal_value: reason,
        recorded_at: Date.now(),
      });
      this.sessionManager.archiveAndEndSession(sessionId);
    }
  }
}

/**
 * Lazily builds the one DeployOrchestrator per project. The two-phase
 * confirm gate lives client-side by design (GateReadinessPanel's
 * review-then-confirm sequence, gated on the DB-derived "behind" preview) —
 * by the time `/deploy/launch` is called, the operator has already
 * confirmed. Any `confirm-gate` step a playbook declares (e.g. this repo's
 * `confirm-restart`) is therefore intentionally auto-approved here — it is
 * not a second gate to pause on. An `agentic` step is instead settled by the
 * dispatched-session spawner wired up below.
 */
function getOrchestrator(
  project: string,
  projectDir: string,
): DeployOrchestrator {
  let orchestrator = orchestrators.get(project);
  if (!orchestrator) {
    orchestrator = new DeployOrchestrator(project, projectDir, {
      waitForConfirmGate: async () => true,
      spawnAgenticStep: (input) => {
        if (!_deployAgenticStepSpawner) {
          logger.warn(
            `[deploy] run ${input.runId}: agentic step "${input.step.id}" has no session manager wired up yet`,
          );
          return;
        }
        _deployAgenticStepSpawner.spawn(input);
      },
    });
    orchestrators.set(project, orchestrator);
  }
  return orchestrator;
}

/**
 * Boot-time reconciliation: resumes each project's in-progress deploy_run
 * (if any) at its current_step. This is what finalizes a self-deploy after
 * the restart step reboots the very backend driving the run — without it,
 * the run is left `running` forever, blocking any later deploy for that
 * project (startDeployRun's at-most-one-active-run-per-project constraint).
 * Non-blocking and per-project isolated: one project's resume failing
 * doesn't stop the others from resuming.
 */
export function resumeActiveDeployRuns(projects: ProjectRow[]): void {
  for (const project of projects) {
    const orchestrator = getOrchestrator(project.id, project.project_dir);
    void orchestrator.resume().catch((err) => {
      logger.error(
        `[deploy] boot resume failed for project ${project.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
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
  router.post(
    '/deploy/launch',
    asyncHandler(async (req: Request, res: Response) => {
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
    }),
  );

  // GET /api/deploy/status?projectId=...
  // Gate-panel progress read: the project's active deploy_run if any,
  // otherwise its most recent terminal run (so a failure's reason stays
  // visible after the run leaves 'running'), plus its event log, the last
  // reported deployed SHA, and the DB-derived "behind" preview (merged PRs
  // + merged local branches since that SHA was recorded) the client's
  // two-phase confirm gate is built on.
  router.get('/deploy/status', (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : null;
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    const run = getLatestDeployRun(projectId) ?? null;
    const events = run ? listDeployRunEvents(run.run_id) : [];
    const deployedShaRow = getProjectDeployedShaRow(projectId);
    const behindItems = listMergedSince(
      projectId,
      deployedShaRow?.recordedAt ?? null,
    );
    const project = getProjectRowById(projectId);
    const playbookResult = project
      ? loadDeployPlaybook(project.project_dir)
      : { ok: false as const, reason: `unknown project ${projectId}` };
    const plan = playbookResult.ok
      ? playbookResult.playbook.steps.map((step) => ({
          id: step.id,
          description: step.command_or_prompt ?? null,
        }))
      : [];
    res.status(200).json({
      run,
      events,
      deployedSha: deployedShaRow?.sha ?? null,
      deployedShaRecordedAt: deployedShaRow?.recordedAt ?? null,
      behind: { count: behindItems.length, items: behindItems },
      plan,
    });
  });

  return router;
}
