import './bootstrap';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import os from 'os';
import { runMigrations } from './db/schema';
import {
  db,
  dbPath,
  logDatabaseBootSummary,
  runWalTruncateCheckpointOffMainThread,
} from './db/db';
import { SessionManager } from './session/SessionManager';
import { handleMessage, setWsRouterRefreshFn } from './ws/router';
import { setTaskWriteRefreshFn } from './tasks/TaskWriteCommands';
import { sendInitialStateBurst } from './ws/initialStateBurst';
import { JsonlReader, DEFAULT_SESSIONS_DIR } from './session/JsonlReader';
import type { ServerMessage } from './ws/types';
import { permissionDenialsRouter } from './routes/rules';
import configRouter from './routes/config';
import settingsRouter, {
  loadRuntimeSettingsFromDb,
  setReviewOrchestrator as setSettingsReviewOrchestrator,
} from './routes/settings';
import {
  sessionsRouter,
  setBroadcast,
  setSessionManager,
} from './routes/sessions';
import { createPrsRouter, setPRBroadcast } from './routes/prs';
import {
  createTasksRouter,
  setTaskBroadcast,
  setTaskCacheRefresher,
} from './routes/tasks';
import { TaskCacheRefresher } from './orchestration/TaskCacheRefresher';
import { ConvergenceSnapshotJob } from './orchestration/ConvergenceSnapshotJob';
import { FlowHealthRegressionSnapshotJob } from './orchestration/FlowHealthRegressionSnapshotJob';
import { FlakyTestRollupJob } from './orchestration/FlakyTestRollupJob';
import { analyticsRouter } from './routes/analytics';
import { projectsRouter, setAutoMerger } from './routes/projects';
import { validateWsToken, isLoopbackIp } from './auth/DeviceAuth';
import { requireDeviceOrSessionRouteAuth } from './auth/SessionRouteAuth';
import {
  createPublicEnrollmentRouter,
  createGatedEnrollmentRouter,
  setEnrollmentBroadcast,
} from './auth/Enrollment';
import {
  getActiveDeviceCount,
  pruneSchedulerAudit,
  listProjectRows,
  getJobBootSchedule,
  SCHEDULER_AUDIT_KEEP_PER_JOB,
} from './db/queries';
import { importProjectsFromEnv } from './projects/projectImport';
import { GitHubClient } from './github/GitHubClient';
import { PRReviewService } from './github/PRReviewService';
import { DepthReviewService } from './github/DepthReviewService';
import { ReviewOrchestrator } from './github/ReviewOrchestrator';
import { PlanningOrchestrator } from './orchestration/PlanningOrchestrator';
import { PRMergeWatcher } from './github/PRMergeWatcher';
import { AutoMerger } from './github/AutoMerger';
import { ReviewerCommentsWatcher } from './github/ReviewerCommentsWatcher';
import { AUTO_REVIEW_ENABLED, GITHUB_TOKEN } from './config';
import { getCorporateMode } from './config/corporateMode';
import {
  getOrchestratorConfig,
  logConfigProvenanceSummary,
} from './config/appConfig';
import { createConfigStatusRouter } from './routes/configStatus';
import { AutoLauncher } from './orchestration/AutoLauncher';
import { DispatchTriggerEvaluator } from './orchestration/DispatchTriggerEvaluator';
import { StuckSessionMonitor } from './orchestration/StuckSessionMonitor';
import { PlanUsagePoller } from './orchestration/PlanUsagePoller';
import { registerUsagePoller } from './orchestration/usageAdmission';
import { OrphanedTaskSweeper } from './orchestration/OrphanedTaskSweeper';
import { StrandedOpsTaskMonitor } from './orchestration/StrandedOpsTaskMonitor';
import { DeferredBlockerSweep } from './orchestration/DeferredBlockerSweep';
import { CapabilityDispositionMiner } from './orchestration/CapabilityDispositionMiner';
import { StalledPRReconciler } from './orchestration/StalledPRReconciler';
import { ConcludedSessionArchiver } from './orchestration/ConcludedSessionArchiver';
import { SessionEventsPruner } from './orchestration/SessionEventsPruner';
import { Scheduler } from './orchestration/Scheduler';
import { register as registerWorktreeReconciler } from './orchestration/WorktreeReconciler';
import { register as registerTempClusterReconciler } from './orchestration/TempClusterReconciler';
import { register as registerDependencyCacheReconciler } from './orchestration/DependencyCacheReconciler';
import { register as registerScheduledAuditSweep } from './orchestration/ScheduledAuditSweep';
import {
  register as registerGateReconciler,
  configureGateVerification,
  configureGateItemMirrorSink,
  reattachOutstandingGateVerifications,
} from './gate/gateReconciler';
import {
  registerGateMergeConsumer,
  configureUnresolvedSourceEscalationSink,
} from './gate/gateMergeConsumer';
import { registerSeedMergeConsumer } from './seed/seedMergeConsumer';
import {
  latestDispositionEvidence,
  configureGateVerifyIntentRetireSink,
} from './gate/gateService';
import { SessionGateItemVerifier } from './gate/gateItemVerifier';
import { register as registerInvestigationReconciler } from './investigation/investigationReconciler';
import { createInvestigateRouter } from './routes/investigate';
import {
  deleteGhostSessions,
  getPRBySessionId,
  backfillStagedIntentMilestones,
} from './db/queries';
import { resolveMilestoneForSessionTask } from './projects/milestoneResolver';
import { UpdateChecker, cleanUpdatesDir } from './updater/index';
import { updateRouter, setUpdateChecker } from './routes/update';
import setupRouter, { createSetupModeGuard } from './routes/setup';
import {
  createDiagnosticsRouter,
  setScheduler,
  setAutoLauncher,
} from './routes/diagnostics';
import {
  createDeployRouter,
  createDeployBuildShaRouter,
  createWrapRouter,
  setDeployScheduler,
  setDeploySessionManager,
  resumeActiveDeployRuns,
  resumeActiveWrapRuns,
} from './routes/deploy';
import { createPlanUsageRouter, setPlanUsagePoller } from './routes/planUsage';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
  stageIntent,
  withdrawGateVerifyMirror,
} from './routes/stagedIntents';
import {
  setTestRequestLaneBroadcast,
  sweepTestRunResultsExtraction,
  EXTRACTION_SWEEP_DEFAULT_CAP,
} from './orchestration/testRequestLane';
import { createOrchestratorMcpRouter } from './mcp/orchestratorMcpServer';
import { createSessionRecordReadRouter } from './routes/sessionRecordRead';
import { createOpsJournalRouter } from './routes/opsJournal';
import { createTaskAbortRouter } from './routes/taskAbort';
import { createGateStateRouter } from './routes/gateState';
import {
  createReportStateRouter,
  reportImageBodyParser,
} from './routes/reportState';
import { createSeedStateRouter } from './routes/seedState';
import { createConvergenceRouter } from './routes/convergence';
import { createArchitectureRouter } from './routes/architecture';
import { createDesignRouter } from './routes/design';
import { createDesignContextRouter } from './routes/designContext';
import { createGroomContextRouter } from './routes/groomContext';
import { createGroomFlipRouter } from './routes/groomFlip';
import { createMergeCandidatesRouter } from './routes/mergeCandidates';
import { createOpsContextRouter } from './routes/opsContext';
import { createMilestonesRouter } from './routes/milestones';
import { createPlanningLaunchRouter } from './routes/planningLaunch';
import {
  OpsSessionLauncher,
  setOpsSessionLauncherRefreshFn,
} from './orchestration/OpsSessionLauncher';
import {
  runBootSequence,
  getActiveBootTracker,
  getReadinessState,
} from './bootSequence';
import { logger } from './logger';
import {
  handleUncaughtException,
  handleUnhandledRejection,
} from './audit/recordFault';
import { asyncErrorBoundary } from './routes/asyncHandler';
import { createResponseCompression } from './middleware/responseCompression';
import {
  setupSessionCgroup,
  reapTestsCgroupOrphans,
} from './session/sessionCgroup';

runMigrations(db);
logDatabaseBootSummary();
loadRuntimeSettingsFromDb();
setupSessionCgroup();
importProjectsFromEnv(process.env.PROJECTS);

// Best-effort backfill of pre-milestone-column staged_intent rows — never
// blocks boot, and rows that don't resolve just stay in the "unattributed"
// bucket (see backfillStagedIntentMilestones in db/queries.ts).
try {
  backfillStagedIntentMilestones(resolveMilestoneForSessionTask);
} catch (err) {
  logger.error(
    `[server] staged_intent milestone backfill failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const _cm = getCorporateMode();
logger.info(
  `[corporateMode] mode=${_cm.enabled ? 'corporate' : 'personal'} envLocked=${_cm.envLocked} gates=${JSON.stringify(_cm.gates)}`,
);

const ghostsRemoved = deleteGhostSessions();
if (ghostsRemoved > 0) {
  logger.info(
    `[server] cleaned up ${ghostsRemoved} ghost session(s) with no events`,
  );
}

const rawSessionsDir =
  getOrchestratorConfig().sessions.dir || DEFAULT_SESSIONS_DIR;
const sessionsDir = rawSessionsDir.replace(/^~/, os.homedir());
const jsonlReader = new JsonlReader(sessionsDir);

if (process.env.TASK_BACKEND) {
  logger.warn(
    '[startup] TASK_BACKEND env var is deprecated and ignored. ' +
      'task_source is now configured per-project in SQLite.',
  );
}

const githubClient = new GitHubClient();

const sessionManager = new SessionManager(githubClient);
const prReviewService = new PRReviewService(
  githubClient,
  undefined,
  sessionManager,
);
const depthReviewService = new DepthReviewService(sessionManager, undefined);
prReviewService.setDepthReviewService(depthReviewService);
// Retained so push_detected handler can call consumeAutofixSha() to detect
// autofix-only pushes and suppress iteration-counter increments for them.
const reviewOrchestrator = new ReviewOrchestrator(
  prReviewService,
  sessionManager,
  AUTO_REVIEW_ENABLED,
  githubClient,
);
reviewOrchestrator.setDepthReviewService(depthReviewService);
setSettingsReviewOrchestrator(reviewOrchestrator);
const planningOrchestrator = new PlanningOrchestrator(sessionManager);
sessionManager.setPlanningTerminalChecker((sessionId) =>
  planningOrchestrator.tryTerminalizeIfComplete(sessionId),
);

// Wire sessionManager into the deploy-agentic-step spawner before any
// deploy_run resume below could reach an `agentic` step.
setDeploySessionManager(sessionManager);

// Resume-at-boot: a project's deploy_run left `running` by a self-deploy
// restart (the restart step reboots this very backend) never finalizes on
// its own — verify/report-in/record-sha only run if something re-drives
// it. Guarded and non-blocking so one project's resume failure can't stall
// the rest of boot.
try {
  resumeActiveDeployRuns(listProjectRows());
} catch (err) {
  logger.error(
    `[server] boot deploy-run resume failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

// Same reasoning as the deploy-run resume above, for the independent
// (project, 'wrap') exclusivity lock: an interrupted wrap run left
// `running` would otherwise sit orphaned forever, permanently blocking any
// future wrap launch for that project.
try {
  resumeActiveWrapRuns(listProjectRows());
} catch (err) {
  logger.error(
    `[server] boot wrap-run resume failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const PORT = getOrchestratorConfig().server.port;
logConfigProvenanceSummary();

const app = express();
// Scoped ahead of the global parser below so /api/reports (which accepts a
// base64 screenshot on POST/PATCH) gets a raised body-size limit without
// raising it for every other route — body-parser skips re-parsing a body
// it's already consumed, so the global parser becomes a no-op here.
app.use('/api/reports', reportImageBodyParser);
app.use(express.json());
app.use(createResponseCompression());
// Readiness surface — public, no token required. Distinguishes a slow boot
// (migrating / boot_steps_running) from a crashed process; only reachable at
// all once the listener has bound, which only happens after migrations
// complete, so 'migrating' is reported by direct callers of
// getReadinessState() rather than ever observed over this route itself.
app.get('/api/readiness', (_req, res) => {
  const state = getReadinessState();
  res.status(state === 'serving' ? 200 : 503).json({ state });
});
// Public enrollment routes (bootstrap, request, status) — no token required
app.use('/api/enrollment', createPublicEnrollmentRouter());
// Long-lived, loopback-only orchestrator MCP server (streamable-HTTP): the
// sole session-facing write edge for staged task-write intents and verdict
// delivery, authed by its own scoped session stage credential (never a
// device token), so it is mounted ahead of requireDeviceAuth deliberately —
// it must stay reachable only via requireSessionStageAuth, never fall back
// to the device-auth surface. Supersedes the retired POST /api/task-intents
// REST route + its sanctioned stage-task-intent.mjs CLI client.
app.use('/api', createOrchestratorMcpRouter(sessionManager));
// The own-record read (session_events + audit_log, by target session id) an
// operator-approved session.requestCapability grant materialises — same
// loopback-only, stage-credential auth as above, plus its own per-request
// granted-capability check (see routes/sessionRecordRead.ts).
app.use('/api', createSessionRecordReadRouter());
// Ops-journal read + operator-resolve surface — device-authed only; the
// dispatched-session write path (a scoped journal-write credential) has
// been retired in favor of staging journal.setState through the MCP tool
// surface above.
app.use('/api', createOpsJournalRouter());
// Device-authed-only abort route for a mis-filed Backlog task — flips it to
// Deferred and kills its bound groom session, if any (see routes/taskAbort.ts).
app.use('/api', createTaskAbortRouter(sessionManager));
// Build-identity read — public, no token required. The restart step's
// identity_capture is an unauthenticated loopback curl that must resolve
// to the running process's build SHA to prove verify against the right
// build; the SHA is a build identity, not a secret. Every other deploy
// route stays behind requireDeviceOrSessionRouteAuth via createDeployRouter().
app.use('/api', createDeployBuildShaRouter());
// Setup endpoints are public — wizard UI uses them before credentials exist
app.use('/api', setupRouter);
// Gate all other /api routes when setup has not been completed
app.use('/api', createSetupModeGuard());
// Gate the data API only. The static SPA shell (served further below) must stay
// publicly loadable: browser navigations carry no Bearer token (it lives only in
// localStorage, with no cookie/service-worker), so gating the shell globally
// returned JSON instead of the app on every fresh load/reload once a device was
// enrolled — locking all devices out. The API/WS stay gated.
app.use('/api', requireDeviceOrSessionRouteAuth);
// Auth-gated enrollment routes (approve, devices) — valid enrolled-device token required
app.use('/api/enrollment', createGatedEnrollmentRouter());
app.use('/api/permission-denials', permissionDenialsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/sessions', sessionsRouter);
// PRMergeWatcher created early so routes and sync jobs can delegate lifecycle to it.
// .start() is called later after server boots.
const prMergeWatcher = new PRMergeWatcher(
  githubClient,
  sessionManager,
  undefined,
  broadcast,
);
// After an approved verdict, the review service should trigger an immediate
// watcher-style mergeability check so we don't wait for the next 5-min poll.
prReviewService.setMergeWatcher(prMergeWatcher);
const autoMerger = new AutoMerger(
  githubClient,
  prMergeWatcher,
  broadcast,
  sessionManager,
);
prMergeWatcher.setAutoMerger(autoMerger);
prMergeWatcher.setPRReviewService(prReviewService);
prMergeWatcher.setReviewOrchestrator(reviewOrchestrator);
// Gate consumes the merge-completion signal; PRMergeWatcher stays unaware of gate state.
registerGateMergeConsumer(prMergeWatcher);
// Seed store consumes the same signal, independently of the gate.
registerSeedMergeConsumer(prMergeWatcher);
prReviewService.setAutoMerger(autoMerger);
reviewOrchestrator.setAutoMerger(autoMerger);
setAutoMerger(autoMerger);
const reviewerCommentsWatcher = new ReviewerCommentsWatcher(
  githubClient,
  sessionManager,
  broadcast,
);
// Resolve the orchestrator's own GitHub posting identity so the watcher never
// re-ingests its own disposition replies as fresh human feedback. Never
// blocks boot: a failed probe just falls back to the manual deny-list.
void GitHubClient.resolveViewerLogin(GITHUB_TOKEN).then((login) => {
  if (!login) return;
  reviewerCommentsWatcher.setSelfIdentity(login);
  logger.info(
    `[server] resolved orchestrator GitHub identity for reviewer-comment self-exclusion: @${login}`,
  );
});
app.use(
  '/api',
  createPrsRouter(
    githubClient,
    prReviewService,
    sessionManager,
    undefined,
    prMergeWatcher,
    autoMerger,
    reviewOrchestrator,
  ),
);
app.use('/api', createTasksRouter(sessionManager, reviewOrchestrator));
app.use('/api/analytics', analyticsRouter);
app.use('/api', projectsRouter);
app.use('/api', configRouter);
app.use('/api', createConfigStatusRouter());
app.use('/api', updateRouter);
app.use('/api/diagnostics', createDiagnosticsRouter());
app.use('/api', createPlanUsageRouter());
app.use(
  '/api',
  createStagedIntentsRouter(
    planningOrchestrator,
    sessionManager,
    prReviewService,
  ),
);
app.use('/api', createGateStateRouter());
app.use('/api', createReportStateRouter());
app.use('/api', createInvestigateRouter(sessionManager));
app.use('/api', createDeployRouter());
app.use('/api', createWrapRouter());
app.use('/api', createSeedStateRouter());
app.use('/api', createConvergenceRouter(sessionManager));
app.use('/api', createArchitectureRouter());
app.use('/api', createDesignRouter());
app.use('/api', createDesignContextRouter());
app.use('/api', createGroomContextRouter());
const opsSessionLauncher = new OpsSessionLauncher(sessionManager);
app.use('/api', createGroomFlipRouter(opsSessionLauncher));
app.use('/api', createMergeCandidatesRouter());
app.use('/api', createOpsContextRouter());
app.use('/api', createMilestonesRouter());
app.use('/api', createPlanningLaunchRouter(opsSessionLauncher));

// Terminal error boundary: catches rejections/throws from asyncHandler-wrapped
// route handlers that weren't already handled inside the route. Must stay
// last among router mounts — Express selects error middleware by position.
app.use(asyncErrorBoundary);

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')),
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg: ServerMessage) {
  const json = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  });
}

// Wire broadcast into the sessions router (for PATCH note/tags)
setBroadcast(broadcast);
// Wire sessionManager into the sessions router (for abort)
setSessionManager(sessionManager);
// Wire broadcast into the prs router (for merge/close events)
setPRBroadcast(broadcast);
// Wire broadcast into the tasks route (for task_updated WS messages)
setTaskBroadcast(broadcast);
// Wire broadcast into enrollment (for enrollment_request events)
setEnrollmentBroadcast(broadcast);
// Wire broadcast into the staged-intents route (for staged_intent_changed WS messages)
setStagedIntentBroadcast(broadcast);
// Wire broadcast into the test.request lane (for test_request_run_status WS messages)
setTestRequestLaneBroadcast(broadcast);

// Scheduler: constructed once, broadcast wired in, exposed to diagnostics route
const scheduler = new Scheduler();
scheduler.setBroadcast(broadcast);
setScheduler(scheduler);
setDeployScheduler(scheduler);
// Bound retention: prune scheduler_audit to last 1000 rows per job, daily
// (SCHEDULER_AUDIT_KEEP_PER_JOB rows retained per job — see db/queries.ts).
// The first-fire schedule is derived from the durable scheduler_audit
// record rather than process-registration time: an overdue job fires
// immediately, and one that's mid-interval is seeded to fire at
// last_ok_started_at + intervalMs rather than intervalMs from *this* boot
// — so a restart landing mid-interval doesn't push the next run out by a
// fresh interval — see getJobBootSchedule.
const SCHEDULER_AUDIT_PRUNER_INTERVAL_MS = 24 * 60 * 60_000;
const schedulerAuditPrunerSchedule = getJobBootSchedule(
  'scheduler_audit_pruner',
  SCHEDULER_AUDIT_PRUNER_INTERVAL_MS,
);
scheduler.register({
  name: 'scheduler_audit_pruner',
  intervalMs: SCHEDULER_AUDIT_PRUNER_INTERVAL_MS,
  runOnBoot: schedulerAuditPrunerSchedule.runOnBoot,
  initialDelayMs: schedulerAuditPrunerSchedule.initialDelayMs,
  run: async () => {
    pruneSchedulerAudit(SCHEDULER_AUDIT_KEEP_PER_JOB);
  },
});
// Scheduled WAL truncate: PASSIVE autocheckpoints already write every
// committed page back to the main database correctly on their own — what
// never happens on its own is truncation, so the WAL file sits at its
// historic high-water mark indefinitely (see runWalTruncateCheckpoint in
// db.ts for the 2026-08-17 measurement that ruled out reader overlap as the
// blocker). Hourly comfortably keeps it bounded against the measured
// hours-to-days growth to 103.5 MB between manual checkpoints.
scheduler.register({
  name: 'wal_truncate_checkpoint',
  intervalMs: 60 * 60 * 1000,
  runOnBoot: false,
  concurrency: 'skip-if-running',
  run: async () => {
    const result = await runWalTruncateCheckpointOffMainThread(dbPath);
    const bytesFreed = Math.max(
      0,
      result.walSizeBeforeBytes - result.walSizeAfterBytes,
    );
    if (result.busy) {
      // A busy checkpoint is an expected, non-error outcome — a reader held
      // the WAL open at the moment this ran. It's logged distinctly (not as
      // a success) and simply retried on the next hourly tick.
      logger.warn(
        `[wal_truncate_checkpoint] blocked by a reader (busy=1): log=${result.log} checkpointed=${result.checkpointed}, ` +
          `wal size ${result.walSizeBeforeBytes} -> ${result.walSizeAfterBytes} bytes`,
      );
      return { items_processed: 0 };
    }
    logger.info(
      `[wal_truncate_checkpoint] wal size ${result.walSizeBeforeBytes} -> ${result.walSizeAfterBytes} bytes ` +
        `[busy=0 log=${result.log} checkpointed=${result.checkpointed}]`,
    );
    return { items_processed: bytesFreed };
  },
});
// Backstop for the terminal-status reap hook in SessionManager: catches
// staged intents left behind by sessions that crashed past the hook.
scheduler.register({
  name: 'staged_intent_reaper_sweep',
  intervalMs: 30 * 60_000,
  runOnBoot: true,
  run: async () => {
    sessionManager.reapStagedIntentsBackstopSweep();
  },
});

// Broadcast all session events to every connected WS client
sessionManager.on('message', broadcast);

// ── Push-detected re-review loop ─────────────────────────────────────────────

// All push pipeline logic lives in PRMergeWatcher.handlePushDetected.
// This thin wrapper resolves the coding session → PR row and delegates.
sessionManager.on(
  'push_detected',
  ({ sessionId: codingSessionId }: { sessionId: string }) => {
    logger.info(
      `[server] push_detected from session ${codingSessionId.slice(0, 8)}`,
    );
    const prRow = getPRBySessionId(codingSessionId);
    if (!prRow || prRow.state !== 'open') {
      logger.info(
        `[server] push_detected: no open PR for session (found=${!!prRow})`,
      );
      return;
    }
    void prMergeWatcher
      .handlePushDetected(prRow)
      .catch((err: unknown) =>
        logger.error('[server] push_detected: handlePushDetected failed:', err),
      );
  },
);

wss.on('connection', (ws, req) => {
  const urlStr = req.url ?? '/ws';
  const url = new URL(urlStr, `http://${req.headers.host ?? 'localhost'}`);
  const token = url.searchParams.get('token');
  const device = validateWsToken(token);

  if (!device) {
    // Bootstrap: allow connection when no devices are enrolled yet
    const deviceCount = getActiveDeviceCount();
    if (deviceCount > 0) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    // Bootstrap window is loopback-only to prevent enrollment hijack from the network.
    const remoteAddr = req.socket.remoteAddress ?? '';
    if (!isLoopbackIp(remoteAddr)) {
      ws.close(4003, 'Bootstrap only available on localhost');
      return;
    }
  }

  logger.info('[WS] client connected');

  // Send existing active (non-archived) sessions to the new client so the UI populates on load.
  // session_status messages in this burst carry replay: true so the frontend can suppress
  // notification firing — otherwise every backend restart re-fires notifications for every
  // historical non-archived session.
  sendInitialStateBurst(
    (msg) => ws.send(JSON.stringify(msg)),
    getActiveBootTracker(),
  );
  ws.send(
    JSON.stringify({
      type: 'plan_usage',
      usage: planUsagePoller.getCache(),
    } satisfies ServerMessage),
  );

  ws.on('message', (data) =>
    handleMessage(ws, data.toString(), sessionManager),
  );
  ws.on('close', () => logger.info('[WS] client disconnected'));
});

// AutoLauncher is constructed up-front; pollOnce() is called during boot after
// orphan resume, and the Scheduler drives subsequent periodic polls.
const autoLauncher = new AutoLauncher(sessionManager, broadcast);
setAutoLauncher(autoLauncher);

// DispatchTriggerEvaluator: sibling to AutoLauncher — scans armed flows
// (groom/ops/design) across all projects' non-Done milestones and dispatches
// planning sessions via dispatchPlanningFlow. Only the groom candidate
// predicate is wired so far; ops/design land in a sibling task.
const dispatchTriggerEvaluator = new DispatchTriggerEvaluator(
  sessionManager,
  opsSessionLauncher,
);

// TaskCacheRefresher: background loop that keeps per-project board caches warm.
// Handlers always serve from cache; the refresher populates it on an interval.
const taskCacheRefresher = new TaskCacheRefresher(broadcast);
setTaskCacheRefresher((projectId, skipCache) =>
  taskCacheRefresher.refreshProjectById(projectId, skipCache),
);
setWsRouterRefreshFn((projectId, skipCache) =>
  taskCacheRefresher.refreshProjectById(projectId, skipCache),
);
setTaskWriteRefreshFn((projectId, skipCache) =>
  taskCacheRefresher.refreshProjectById(projectId, skipCache),
);
setOpsSessionLauncherRefreshFn((projectId, skipCache) =>
  taskCacheRefresher.refreshProjectById(projectId, skipCache),
);

// Auto-updater: polls GitHub Releases on startup + every 24h
const updateChecker = new UpdateChecker(broadcast);
setUpdateChecker(updateChecker, broadcast);
cleanUpdatesDir();

// Stuck-session timer: notify → pause → hard-stop. Wires itself to SessionManager
// events on construction; lifetime tied to the process.
const stuckSessionMonitor = new StuckSessionMonitor(
  sessionManager,
  broadcast,
  githubClient,
);

// Plan-usage poller: reads Claude subscription 5-hour/weekly usage every 60s
// for display in the top bar. Degrades to `{ available: false }` when the
// device is on an API key or the OAuth token can't be read.
const planUsagePoller = new PlanUsagePoller(broadcast);
setPlanUsagePoller(planUsagePoller);
registerUsagePoller(planUsagePoller);

// Orphaned-task sweep: finds tasks stuck at In Progress with no live session.
// enqueueFeedback is wired so idle sessions without a PR are nudged via the
// feedback inbox rather than reverted or sent a raw mid-teardown stdin write.
const orphanedTaskSweeper = new OrphanedTaskSweeper(broadcast, {
  enqueueFeedback: (sessionId, source, payload) =>
    sessionManager.enqueueFeedback(sessionId, source, payload),
});

// Stranded-ops detector: surfaces (never reverts) an Investigation/Operational
// task whose ops_journal has advanced past pending but then stalled with no
// live session and no pending operator decision — the gap OrphanedTaskSweeper's
// exemption for such tasks otherwise leaves permanently unobserved.
const strandedOpsTaskMonitor = new StrandedOpsTaskMonitor();

// Deferred-blocker sweep: periodic catch-all for a Ready (or other
// non-terminal) task whose Depends On names an already-⏭️-Deferred task —
// catches the pre-existing backlog and any case the write-path hook
// (TaskWriteCommands.surfaceDependentsOfDeferredTask) misses.
const deferredBlockerSweep = new DeferredBlockerSweep();

// Capability-disposition-trail miner: files a 🔎 Investigation task (never a
// ready denylist decision) for any capability with 5+ operator denials
// across 2+ tasks and zero approvals ever recorded — see
// audit/capabilityDispositionMining.ts.
const capabilityDispositionMiner = new CapabilityDispositionMiner();

const sessionEventsPruner = new SessionEventsPruner();

// Convergence snapshot: samples the live milestone convergence every 5
// minutes and writes a durable burndown row only when it changes.
const convergenceSnapshotJob = new ConvergenceSnapshotJob();

// Flow-health regression snapshot: daily trailing-7-day median wall-clock
// for 'standard' code sessions, written only when it changes.
const flowHealthRegressionSnapshotJob = new FlowHealthRegressionSnapshotJob();

// Flaky-test rollup: recomputes flagged_flaky_tests_rollup for every project
// every 15 minutes so lane-health reads a precomputed table instead of
// scanning full test_run_results history on the request path.
const flakyTestRollupJob = new FlakyTestRollupJob();

const stalledPRReconciler = new StalledPRReconciler(broadcast);
stalledPRReconciler.setReviewOrchestrator(reviewOrchestrator);
stalledPRReconciler.setSessionManager(sessionManager);
stalledPRReconciler.setGitHubClient(githubClient);

// Concluded-session archiver: registers with Scheduler for cadence management.
const concludedSessionArchiver = new ConcludedSessionArchiver(broadcast);
concludedSessionArchiver.register(scheduler);
planningOrchestrator.register(scheduler);
prMergeWatcher.register(scheduler);
reviewerCommentsWatcher.register(scheduler);
updateChecker.register(scheduler);

// Register all periodic sweepers with the Scheduler.
autoLauncher.register(scheduler);
dispatchTriggerEvaluator.register(scheduler);
opsSessionLauncher.register(scheduler);
// Local-branch merge sweep — independent of GitHub/PRMergeWatcher so
// local-only projects (no PR) still get approved branches squash-merged.
autoMerger.register(scheduler);
orphanedTaskSweeper.register(scheduler);
strandedOpsTaskMonitor.register(scheduler);
deferredBlockerSweep.register(scheduler);
capabilityDispositionMiner.register(scheduler);
stalledPRReconciler.register(scheduler);
taskCacheRefresher.register(scheduler);
sessionEventsPruner.register(scheduler);
stuckSessionMonitor.register(scheduler);
planUsagePoller.register(scheduler);
convergenceSnapshotJob.register(scheduler);
flowHealthRegressionSnapshotJob.register(scheduler);
flakyTestRollupJob.register(scheduler);
registerWorktreeReconciler(scheduler);
registerTempClusterReconciler(scheduler);
registerDependencyCacheReconciler(scheduler);
// Daily base-branch dependency/license-audit sweep — independent of any PR,
// closes the gap the per-PR analyze gate's diff-triggered skip leaves for
// manifests no PR ever touches.
registerScheduledAuditSweep(scheduler);
// Drains whatever the boot-time extraction sweep's cap left behind (see
// EXTRACTION_SWEEP_BOOT_CAP in bootSequence.ts) — a few runs per tick rather
// than one unbounded inline pass, so a large backlog never blocks boot or a
// single scheduler tick.
scheduler.register({
  name: 'test_run_results_extraction_drain',
  intervalMs: 5 * 60_000,
  runOnBoot: false,
  concurrency: 'skip-if-running',
  run: async () => {
    const result = await sweepTestRunResultsExtraction({
      cap: EXTRACTION_SWEEP_DEFAULT_CAP,
    });
    if (result.remaining > 0) {
      logger.info(
        `[test_run_results_extraction_drain] processed ${result.processed}, ${result.remaining} still pending`,
      );
    }
    return { items_processed: result.processed };
  },
});
// Periodic counterpart to resumeOrphanSessions' boot-only reap of the
// backend's own main/ cgroup: a process that gets reparented to ppid=1 (a
// daemonizing grandchild that escaped a session/test-lane placement) mid
// uptime was previously invisible to any sweep until the next restart —
// exactly the gap that let a leaked test.request subprocess swap the host
// unbounded for the incident this job exists to close.
scheduler.register({
  name: 'main_cgroup_orphan_sweep',
  intervalMs: 10 * 60_000,
  runOnBoot: false,
  concurrency: 'skip-if-running',
  run: async () => {
    const reaped = sessionManager.reapMainCgroupOrphans();
    return { items_processed: reaped };
  },
});
// Same sweep, scoped to the tests/ cgroup: a temp postgres cluster (or any
// other test-lane subprocess) spawned under tests/<runId>/ whose owning
// pytest/test-request worker dies before teardown re-parents to init but is
// invisible to main_cgroup_orphan_sweep, which only ever scans main/. See
// reapTestsCgroupOrphans for the additional owning-session check this sweep
// applies that the main/ one doesn't need.
scheduler.register({
  name: 'tests_cgroup_orphan_sweep',
  intervalMs: 10 * 60_000,
  runOnBoot: false,
  concurrency: 'skip-if-running',
  run: async () => {
    const reaped = await reapTestsCgroupOrphans();
    return { items_processed: reaped };
  },
});
// Session-map reconciler: defense-in-depth sweep dropping stale in-memory
// this.sessions entries whose DB row is terminal or missing, so a slot leak
// from any (known or future) code path self-heals without operator
// intervention. Same cadence pattern as registerWorktreeReconciler above.
scheduler.register({
  name: 'session_map_reconciler',
  intervalMs: 30 * 60_000,
  runOnBoot: true,
  concurrency: 'skip-if-running',
  run: async () => {
    const { dropped } = sessionManager.reconcileSessionsMap();
    return { items_processed: dropped };
  },
});
// Session liveness reconciler: the DB → OS mirror of session_map_reconciler
// above. That sweep only ever drops a stale in-memory entry once the DB row
// is already terminal; this one terminalizes a non-terminal planning
// session row whose OS subprocess does not exist, then drops its in-memory
// entry too — so the two sweeps can't leave a session stranded in the gap
// where each defers to the other's axis. Same cadence pattern.
scheduler.register({
  name: 'session_liveness_reconciler',
  intervalMs: 10 * 60_000,
  runOnBoot: true,
  concurrency: 'skip-if-running',
  run: async () => {
    const { reconciled, examined, alive } =
      sessionManager.reconcilePlanningSessionLiveness();
    return {
      items_processed: reconciled.length,
      examined,
      alive,
      terminalized: reconciled.length,
    };
  },
});
// Non-planning counterpart to session_liveness_reconciler above: covers
// standard/review/depth_review session rows, which have no other periodic
// OS-process-liveness sweep — StuckSessionMonitor requires a 'result' event
// to exist, and resumeOrphanSessions only runs on backend boot. Same
// cadence pattern.
scheduler.register({
  name: 'non_planning_session_liveness_reconciler',
  intervalMs: 10 * 60_000,
  runOnBoot: true,
  concurrency: 'skip-if-running',
  run: async () => {
    const { reconciled, examined, alive } =
      sessionManager.reconcileNonPlanningSessionLiveness();
    return {
      items_processed: reconciled.length,
      examined,
      alive,
      terminalized: reconciled.length,
    };
  },
});
// Orphan-process reconciler: the OS → DB mirror of session_map_reconciler
// and the fourth cell in the coverage matrix — a claude process whose
// session row is already terminal (or missing) and whose in-memory map
// entry is gone is invisible to session_map_reconciler (iterates the map)
// and both liveness reconcilers above (iterate non-terminal rows). This
// sweep enumerates the OS process table directly and reaps that process,
// never writing a session status itself. Same cadence pattern.
scheduler.register({
  name: 'orphan_process_reconciler',
  intervalMs: 10 * 60_000,
  runOnBoot: true,
  concurrency: 'skip-if-running',
  run: async () => {
    const { examined, reaped, skippedByGrace, survivedEscalation } =
      await sessionManager.reconcileOrphanProcesses();
    return {
      items_processed: reaped,
      examined,
      reaped,
      skippedByGrace,
      survivedEscalation,
    };
  },
});
// MCP-unreachable reconciler: detects a live session whose orchestrator MCP
// server never connected (the CLI-side stall — see
// SessionManager.reconcileMcpUnreachableSessions's doc comment) and
// recovers it with a bounded in-place respawn, never a termination. Same
// cadence pattern as the liveness reconcilers above.
scheduler.register({
  name: 'mcp_unreachable_reconciler',
  intervalMs: 10 * 60_000,
  runOnBoot: true,
  concurrency: 'skip-if-running',
  run: async () => {
    const { detected, respawned, exhausted } =
      await sessionManager.reconcileMcpUnreachableSessions();
    return {
      items_processed: detected.length,
      detected: detected.length,
      respawned: respawned.length,
      exhausted: exhausted.length,
    };
  },
});
// Undelivered-inbox retry sweep: a session_feedback_inbox item whose sole
// enqueue-time delivery attempt was deferred by respawnSession's
// memory-admission gate has no periodic retry short of a backend restart
// (reconcileInboxAtBoot) or the session already having an open PR
// (redeliverUndeliveredFeedback via StalledPRReconciler) — this sweep covers
// every other non-terminal session. skip-if-running so a drain that's
// itself memory-deferred can't pile up. Same cadence pattern as the
// reconcilers above.
scheduler.register({
  name: 'undelivered_inbox_retry_sweep',
  intervalMs: 10 * 60_000,
  runOnBoot: false,
  concurrency: 'skip-if-running',
  run: async () => {
    const { itemsProcessed } = await sessionManager.sweepUndeliveredInbox();
    return { items_processed: itemsProcessed };
  },
});
// Gate-verification reconciler: runnability/readiness reconcile on every
// tick; auto-run verification drives the same wired verifier, gated by the
// global gate_verification_enabled master switch and, per item, by that
// item's milestone's (milestone, 'gate-verify') arm. The same config is
// also stashed via configureGateVerification for the sibling manual-dispatch
// surface (an operator-triggered /gate verify) to read back and invoke
// directly on selected items.
const gateVerificationOptions = {
  verifier: new SessionGateItemVerifier(sessionManager),
  concurrency: {
    maxDispatchAttempts: 3,
    maxFixAttempts: 3,
  },
};
registerGateReconciler(scheduler, gateVerificationOptions);
configureGateVerification(gateVerificationOptions);

// Investigate reconciler: scans committed investigation reports with no
// live non-terminal session and auto-dispatches them, gated per report by
// that report's milestone's (milestone, 'investigate') arm. Also registers
// the report-resolve watcher, which runs unconditionally. Mirrors the
// gate-verification reconciler wired just above.
registerInvestigationReconciler(scheduler, sessionManager);

// Gate-item mirror sink: surfaces two states that would otherwise be
// invisible outside GateReadinessPanel as `gate.verify` staged intents in
// the Decision Inbox — every runnable Human-Observation gate_item
// (origin: 'mirror', no headless session can judge rendered UI) and every
// Prod-Mutating gate_item held at pending-approval (origin: 'consent', the
// operator's consent gate). See gateReconciler.reconcileHumanObservationMirrors,
// run every reconcile tick.
configureGateItemMirrorSink({
  stageMirror(item, origin) {
    stageIntent(
      'gate.verify',
      origin === 'consent'
        ? {
            gateItemId: item.id,
            origin: 'consent',
            evidence: latestDispositionEvidence(item),
          }
        : { gateItemId: item.id, origin: 'mirror' },
      item.project,
      null,
      null,
      origin === 'consent'
        ? `Prod-Mutating (pending approval): ${item.text}`
        : `Human-Observation: ${item.text}`,
      null,
      null,
      item.milestone,
      null,
    );
  },
  retireMirror(intentId, reason) {
    withdrawGateVerifyMirror(intentId, reason);
  },
});

// Genuine gate.verify intent retire sink: when a gate item resolves through
// the direct GateReadinessPanel Pass/Fail/Defer/reject/reopen path while a
// live (staged/approved) verify-session-backed `gate.verify` intent still
// exists for it, that intent is stranded at `state==='staged'` forever
// unless retired here — checkTerminal refuses to conclude a session while
// any of its own intents remain staged. Reuses the same withdraw mechanism
// as the mirror/consent retire pass above, followed by an explicit
// checkTerminal call — the session_id makes it recoverable, unlike a
// mirror/consent intent's session_id=null.
configureGateVerifyIntentRetireSink({
  retireGenuineIntent(intentId, sessionId, reason) {
    withdrawGateVerifyMirror(intentId, reason);
    planningOrchestrator.checkTerminal(sessionId);
  },
});

// Merge-commit backfill escalation sink: once catchUpMergeCommits' unresolved-
// attempt count for a source crosses its ceiling, stage a `gate.verify`
// mirror (origin: 'unresolved-source') into the Decision Inbox instead of
// retrying forever — surfaced regardless of the gate_item's own state (it
// may never have reached `runnable`). Retirement is handled generically by
// reconcileHumanObservationMirrors above once the source resolves or the
// item terminates. See gateMergeConsumer.escalateUnresolvedSource.
configureUnresolvedSourceEscalationSink({
  stage(item, evidence) {
    stageIntent(
      'gate.verify',
      { gateItemId: item.id, origin: 'unresolved-source', evidence },
      item.project,
      null,
      null,
      `Unresolved merge commit: ${item.text}`,
      null,
      null,
      item.milestone,
      null,
    );
  },
});

void runBootSequence({
  jsonlReader,
  sessionManager,
  planningOrchestrator,
  stuckSessionMonitor,
  autoMerger,
  githubClient,
  autoLauncher,
  scheduler,
  sessionEventsPruner,
  stalledPRReconciler,
  gateVerifyReconciler: {
    reattachOutstanding: reattachOutstandingGateVerifications,
  },
  server,
  port: PORT,
  broadcast,
});

async function gracefulShutdown(signal: string, exitCode = 0) {
  logger.info(`[server] ${signal} received — shutting down`);
  stuckSessionMonitor.stop();
  await scheduler.stopAll({ drain: true, timeoutMs: 15_000 });
  wss.close();
  await sessionManager.shutdownAll();
  server.close();
  db.close();
  process.exit(exitCode);
}

function shutdownWithTimeout(signal: string, exitCode = 0) {
  gracefulShutdown(signal, exitCode).catch(logger.error);
  setTimeout(() => {
    logger.error('[server] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdownWithTimeout('SIGTERM'));
process.on('SIGINT', () => shutdownWithTimeout('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.error('[server] unhandledRejection:', err);
  handleUnhandledRejection(err);
});
process.on('uncaughtException', (err) => {
  logger.error('[server] uncaughtException — initiating graceful shutdown', {
    message: err.message,
    stack: err.stack,
    name: err.name,
  });
  handleUncaughtException(err, shutdownWithTimeout);
});
