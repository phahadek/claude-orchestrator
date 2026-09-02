import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Scheduler } from '../orchestration/Scheduler';
import {
  reportProjectDeploy,
  getLatestDeployRun,
  getActiveDeployRun,
  completeDeployRun,
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
  buildWrapPlaybook,
  createWrapShellRunner,
  recordWrapLaunchParams,
  readWrapLaunchParams,
  WRAP_STATIC_BINDINGS,
  type WrapPlaybookInput,
} from '../deploy/wrapPlaybook';
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

/**
 * The SHA `npm run build` embeds into `dist/build-sha.txt` (see
 * packages/backend/package.json's `build` script) — read once at process
 * startup and served verbatim by `GET /deploy/build-sha`. This is verify's
 * identity check target: it proves which build a restarted process is
 * actually running, not merely that a restart happened (see
 * DeployOrchestrator's `resolveIdentityCheck`). Overridable via
 * `DEPLOY_BUILD_SHA_PATH` for tests, which don't have a real `dist/` build
 * to read from.
 */
const BUILD_SHA_PATH =
  process.env.DEPLOY_BUILD_SHA_PATH ?? path.join(__dirname, '../build-sha.txt');
const BUILD_SHA: string = (() => {
  try {
    return fs.readFileSync(BUILD_SHA_PATH, 'utf8').trim();
  } catch {
    return 'unknown';
  }
})();

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
    ...renderOpsCapabilities(project),
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
/**
 * GET /api/deploy/build-sha — reports the SHA embedded into this running
 * process's own build. This is the identity check verify's playbook step
 * curls (`curl -sf .../deploy/build-sha`) and compares byte-for-byte
 * against the run's own target_sha, so it responds with the bare SHA as
 * plain text, not a JSON envelope.
 *
 * Registered as its own router, mounted in server.ts ahead of
 * requireDeviceOrSessionRouteAuth (mirroring GET /api/readiness) rather
 * than living inside createDeployRouter(): a restarted process must be
 * able to report its own identity without a device token, since the
 * restart step's identity_capture runs as an unauthenticated loopback curl.
 * The build SHA is a build identity, not a secret. Every other deploy
 * route stays behind auth via createDeployRouter() below.
 */
export function createDeployBuildShaRouter(): Router {
  const router = Router();
  router.get('/deploy/build-sha', (_req: Request, res: Response) => {
    res.status(200).type('text/plain').send(BUILD_SHA);
  });
  return router;
}

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

// ─── Milestone wrap ─────────────────────────────────────────────────────────
// Drives the `wrap` deploy_run kind — the orchestrator-owned milestone-wrap
// playbook (see deploy/wrapPlaybook.ts) on the same DeployOrchestrator engine
// a project's deploy runs on. A wrap run's exclusivity lock is scoped to
// (project, 'wrap'), independent of that project's (project, 'deploy') lock
// — a deploy and a wrap can run concurrently for the same project.

/**
 * Resolves a wrap `confirm-gate` step's operator disposition — parked here
 * (not auto-approved like a deploy's) because, unlike a deploy launch, a
 * wrap's two confirm-gates (repoint auto-launch, cut the release) are the
 * live go/no-go the operator hasn't already given by the time
 * `/wrap/launch` is called.
 */
class WrapConfirmGateController {
  private readonly pending = new Map<string, (approved: boolean) => void>();

  private key(runId: string, stepId: string): string {
    return `${runId}:${stepId}`;
  }

  wait(runId: string, stepId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pending.set(this.key(runId, stepId), resolve);
    });
  }

  /** Resolves a pending wait; returns false if there was none (already settled, or never dispatched). */
  resolve(runId: string, stepId: string, approved: boolean): boolean {
    const key = this.key(runId, stepId);
    const resolve = this.pending.get(key);
    if (!resolve) return false;
    this.pending.delete(key);
    resolve(approved);
    return true;
  }
}

const wrapConfirmGates = new WrapConfirmGateController();

/**
 * Builds the `DeployOrchestrator` a wrap run drives on — shared by
 * `/wrap/launch` (a fresh call) and `resumeActiveWrapRuns` (boot-time
 * recovery), so the two never drift into building the playbook/deps two
 * different ways.
 */
function createWrapOrchestrator(
  project: ProjectRow,
  params: WrapPlaybookInput,
): DeployOrchestrator {
  const playbook = buildWrapPlaybook(params);
  return new DeployOrchestrator(
    project.id,
    project.project_dir,
    {
      loadPlaybook: () => ({ ok: true, playbook }),
      loadDeployBindings: () => ({
        ok: true,
        bindings: WRAP_STATIC_BINDINGS,
        bindingsPath: null,
      }),
      runShell: createWrapShellRunner(),
      spawnAgenticStep: (input) => {
        logger.error(
          `[wrap] run ${input.runId}: unexpected agentic step "${input.step.id}" — the wrap playbook declares none`,
        );
      },
      waitForConfirmGate: (input) =>
        wrapConfirmGates.wait(input.runId, input.step.id),
    },
    'wrap',
  );
}

/**
 * Boot-time reconciliation for the `wrap` run kind — mirrors
 * `resumeActiveDeployRuns`: without this, a wrap run interrupted by a
 * backend restart (or any crash) mid-run would sit `running` forever,
 * permanently blocking any future wrap launch for that project via the
 * (project, 'wrap') exclusivity lock, with no route to recover short of a
 * hand DB edit. A wrap run's playbook is rebuilt from its recorded launch
 * params (see recordWrapLaunchParams) rather than reloaded from a per-project
 * file, since the wrap playbook is orchestrator-owned, not per-project.
 * A run that somehow has no recorded params (e.g. it predates this
 * mechanism, or crashed in the narrow window before they were recorded) is
 * failed outright rather than left stuck, so the exclusivity lock still
 * clears — an operator can just re-launch instead of hand-editing the DB.
 */
export function resumeActiveWrapRuns(projects: ProjectRow[]): void {
  for (const project of projects) {
    const active = getActiveDeployRun(project.id, 'wrap');
    if (!active) continue;

    const params = readWrapLaunchParams(active.run_id);
    if (!params) {
      logger.error(
        `[wrap] boot resume: run ${active.run_id} for project ${project.id} has no recorded launch params — cannot rebuild its playbook; failing the run so its exclusivity lock clears`,
      );
      completeDeployRun(active.run_id, 'failed', new Date().toISOString());
      continue;
    }

    const orchestrator = createWrapOrchestrator(project, params);
    void orchestrator.resume().catch((err) => {
      logger.error(
        `[wrap] boot resume failed for project ${project.id} run ${active.run_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

export function createWrapRouter(): Router {
  const router = Router();

  // POST /api/wrap/launch
  //   { projectId, closingMilestoneId, nextMilestoneId, releaseVersion }
  // Starts a `wrap` deploy_run for the given project, driving the 5-step
  // milestone-wrap playbook. A fresh DeployOrchestrator is constructed per
  // call (the playbook is built with this call's specific milestone ids/
  // release version baked in — see wrapPlaybook.ts), unlike the cached
  // per-project deploy orchestrator above.
  router.post(
    '/wrap/launch',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as {
        projectId?: unknown;
        closingMilestoneId?: unknown;
        nextMilestoneId?: unknown;
        releaseVersion?: unknown;
      };
      const projectId =
        typeof body.projectId === 'string' ? body.projectId : null;
      const closingMilestoneId =
        typeof body.closingMilestoneId === 'string'
          ? body.closingMilestoneId
          : null;
      const nextMilestoneId =
        typeof body.nextMilestoneId === 'string' ? body.nextMilestoneId : null;
      const releaseVersion =
        typeof body.releaseVersion === 'string' ? body.releaseVersion : null;
      if (
        !projectId ||
        !closingMilestoneId ||
        !nextMilestoneId ||
        !releaseVersion
      ) {
        res.status(400).json({
          error:
            'projectId, closingMilestoneId, nextMilestoneId, and releaseVersion are required',
        });
        return;
      }

      const project = getProjectRowById(projectId);
      if (!project) {
        res.status(404).json({ error: `unknown project ${projectId}` });
        return;
      }
      const repoUrl = project.github_repo
        ? `https://github.com/${project.github_repo}.git`
        : project.project_dir;

      const params: WrapPlaybookInput = {
        projectId,
        closingMilestoneId,
        nextMilestoneId,
        releaseVersion,
        repoUrl,
      };
      const orchestrator = createWrapOrchestrator(project, params);

      try {
        const run = await orchestrator.startDeploy(closingMilestoneId);
        // Recorded immediately so a boot-time resume (resumeActiveWrapRuns)
        // can rebuild this exact playbook if the process restarts mid-run —
        // see recordWrapLaunchParams.
        recordWrapLaunchParams(run.run_id, params);
        res.status(202).json({ run });
      } catch (err) {
        if (err instanceof DeployRunConflictError) {
          res.status(409).json({ error: err.message });
          return;
        }
        res.status(500).json({
          error: err instanceof Error ? err.message : 'wrap launch failed',
        });
      }
    }),
  );

  // POST /api/wrap/confirm  { runId, stepId, approved }
  // Resolves an in-flight wrap run's pending confirm-gate step.
  router.post('/wrap/confirm', (req: Request, res: Response) => {
    const body = req.body as {
      runId?: unknown;
      stepId?: unknown;
      approved?: unknown;
    };
    const runId = typeof body.runId === 'string' ? body.runId : null;
    const stepId = typeof body.stepId === 'string' ? body.stepId : null;
    if (!runId || !stepId) {
      res.status(400).json({ error: 'runId and stepId are required' });
      return;
    }
    const resolved = wrapConfirmGates.resolve(
      runId,
      stepId,
      body.approved === true,
    );
    if (!resolved) {
      res.status(404).json({
        error: `no pending confirm-gate for run ${runId} step ${stepId}`,
      });
      return;
    }
    res.status(202).json({ runId, stepId, approved: body.approved === true });
  });

  // GET /api/wrap/status?projectId=...
  // The project's active wrap run if any, otherwise its most recent
  // terminal wrap run, plus its event log — mirrors GET /api/deploy/status.
  router.get('/wrap/status', (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : null;
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }
    const run = getLatestDeployRun(projectId, 'wrap') ?? null;
    const events = run ? listDeployRunEvents(run.run_id) : [];
    res.status(200).json({ run, events });
  });

  return router;
}
