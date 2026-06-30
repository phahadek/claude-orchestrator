import './bootstrap';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import os from 'os';
import { runMigrations } from './db/schema';
import { db } from './db/db';
import { SessionManager } from './session/SessionManager';
import { handleMessage, setWsRouterRefreshFn } from './ws/router';
import { sendInitialStateBurst } from './ws/initialStateBurst';
import { JsonlReader, DEFAULT_SESSIONS_DIR } from './session/JsonlReader';
import type { ServerMessage } from './ws/types';
import {
  permissionEventsRouter,
  permissionDenialsRouter,
} from './routes/rules';
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
import { analyticsRouter } from './routes/analytics';
import { projectsRouter, setAutoMerger } from './routes/projects';
import {
  requireDeviceAuth,
  validateWsToken,
  isLoopbackIp,
} from './auth/DeviceAuth';
import {
  createPublicEnrollmentRouter,
  createGatedEnrollmentRouter,
  setEnrollmentBroadcast,
} from './auth/Enrollment';
import { getActiveDeviceCount, pruneSchedulerAudit } from './db/queries';
import { importProjectsFromEnv } from './projects/projectImport';
import { GitHubClient } from './github/GitHubClient';
import { PRReviewService } from './github/PRReviewService';
import { ReviewOrchestrator } from './github/ReviewOrchestrator';
import { PRMergeWatcher } from './github/PRMergeWatcher';
import { AutoMerger } from './github/AutoMerger';
import { ReviewerCommentsWatcher } from './github/ReviewerCommentsWatcher';
import { AUTO_REVIEW_ENABLED } from './config';
import { getCorporateMode } from './config/corporateMode';
import { getOrchestratorConfig } from './config/appConfig';
import { AutoLauncher } from './orchestration/AutoLauncher';
import { StuckSessionMonitor } from './orchestration/StuckSessionMonitor';
import { OrphanedTaskSweeper } from './orchestration/OrphanedTaskSweeper';
import { StalledPRReconciler } from './orchestration/StalledPRReconciler';
import { ConcludedSessionArchiver } from './orchestration/ConcludedSessionArchiver';
import { SessionEventsPruner } from './orchestration/SessionEventsPruner';
import { Scheduler } from './orchestration/Scheduler';
import { register as registerWorktreeReconciler } from './orchestration/WorktreeReconciler';
import { deleteGhostSessions, getPRBySessionId } from './db/queries';
import { UpdateChecker, cleanUpdatesDir } from './updater/index';
import { updateRouter, setUpdateChecker } from './routes/update';
import setupRouter, { createSetupModeGuard } from './routes/setup';
import { createDiagnosticsRouter, setScheduler } from './routes/diagnostics';
import { runBootSequence, getActiveBootTracker } from './bootSequence';
import { logger } from './logger';

runMigrations(db);
loadRuntimeSettingsFromDb();
importProjectsFromEnv(process.env.PROJECTS);

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
// Retained so push_detected handler can call consumeAutofixSha() to detect
// autofix-only pushes and suppress iteration-counter increments for them.
const reviewOrchestrator = new ReviewOrchestrator(
  prReviewService,
  sessionManager,
  AUTO_REVIEW_ENABLED,
  githubClient,
);
setSettingsReviewOrchestrator(reviewOrchestrator);

const PORT = getOrchestratorConfig().server.port;

const app = express();
app.use(express.json());
// Public enrollment routes (bootstrap, request, status) — no token required
app.use('/api/enrollment', createPublicEnrollmentRouter());
// Setup endpoints are public — wizard UI uses them before credentials exist
app.use('/api', setupRouter);
// Gate all other /api routes when setup has not been completed
app.use('/api', createSetupModeGuard());
// Gate the data API only. The static SPA shell (served further below) must stay
// publicly loadable: browser navigations carry no Bearer token (it lives only in
// localStorage, with no cookie/service-worker), so gating the shell globally
// returned JSON instead of the app on every fresh load/reload once a device was
// enrolled — locking all devices out. The API/WS stay gated.
app.use('/api', requireDeviceAuth);
// Auth-gated enrollment routes (approve, devices) — valid enrolled-device token required
app.use('/api/enrollment', createGatedEnrollmentRouter());
app.use('/api/permission-events', permissionEventsRouter);
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
prReviewService.setAutoMerger(autoMerger);
setAutoMerger(autoMerger);
const reviewerCommentsWatcher = new ReviewerCommentsWatcher(
  githubClient,
  sessionManager,
  broadcast,
);
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
app.use('/api', createTasksRouter());
app.use('/api/analytics', analyticsRouter);
app.use('/api', projectsRouter);
app.use('/api', configRouter);
app.use('/api', updateRouter);
app.use('/api/diagnostics', createDiagnosticsRouter());
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

// Scheduler: constructed once, broadcast wired in, exposed to diagnostics route
const scheduler = new Scheduler();
scheduler.setBroadcast(broadcast);
setScheduler(scheduler);
// Bound retention: prune scheduler_audit to last 1000 rows per job, daily.
scheduler.register({
  name: 'scheduler_audit_pruner',
  intervalMs: 24 * 60 * 60_000,
  runOnBoot: false,
  run: async () => {
    pruneSchedulerAudit(1000);
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
    void prMergeWatcher.handlePushDetected(prRow).catch((err: unknown) =>
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

  ws.on('message', (data) =>
    handleMessage(ws, data.toString(), sessionManager),
  );
  ws.on('close', () => logger.info('[WS] client disconnected'));
});

// AutoLauncher is constructed up-front; pollOnce() is called during boot after
// orphan resume, and the Scheduler drives subsequent periodic polls.
const autoLauncher = new AutoLauncher(sessionManager, broadcast);

// TaskCacheRefresher: background loop that keeps per-project board caches warm.
// Handlers always serve from cache; the refresher populates it on an interval.
const taskCacheRefresher = new TaskCacheRefresher(broadcast);
setTaskCacheRefresher((projectId, skipCache) =>
  taskCacheRefresher.refreshProjectById(projectId, skipCache),
);
setWsRouterRefreshFn((projectId, skipCache) =>
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

// Orphaned-task sweep: finds tasks stuck at In Progress with no live session.
// sendOrResume is wired so idle sessions without a PR are nudged rather than reverted.
const orphanedTaskSweeper = new OrphanedTaskSweeper(broadcast, {
  sendOrResume: (sessionId, text) =>
    sessionManager.sendOrResume(sessionId, text),
});

const sessionEventsPruner = new SessionEventsPruner();

const stalledPRReconciler = new StalledPRReconciler(broadcast);
stalledPRReconciler.setReviewOrchestrator(reviewOrchestrator);

// Concluded-session archiver: registers with Scheduler for cadence management.
const concludedSessionArchiver = new ConcludedSessionArchiver(broadcast);
concludedSessionArchiver.register(scheduler);
prMergeWatcher.register(scheduler);
reviewerCommentsWatcher.register(scheduler);
updateChecker.register(scheduler);

// Register all periodic sweepers with the Scheduler.
autoLauncher.register(scheduler);
orphanedTaskSweeper.register(scheduler);
stalledPRReconciler.register(scheduler);
taskCacheRefresher.register(scheduler);
sessionEventsPruner.register(scheduler);
stuckSessionMonitor.register(scheduler);
registerWorktreeReconciler(scheduler);

void runBootSequence({
  jsonlReader,
  sessionManager,
  stuckSessionMonitor,
  autoMerger,
  githubClient,
  autoLauncher,
  scheduler,
  sessionEventsPruner,
  stalledPRReconciler,
  server,
  port: PORT,
  broadcast,
});

async function gracefulShutdown(signal: string) {
  logger.info(`[server] ${signal} received — shutting down`);
  stuckSessionMonitor.stop();
  await scheduler.stopAll({ drain: true, timeoutMs: 15_000 });
  wss.close();
  await sessionManager.shutdownAll();
  server.close();
  db.close();
  process.exit(0);
}

function shutdownWithTimeout(signal: string) {
  gracefulShutdown(signal).catch(logger.error);
  setTimeout(() => {
    logger.error('[server] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdownWithTimeout('SIGTERM'));
process.on('SIGINT', () => shutdownWithTimeout('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.error('[server] unhandledRejection:', err);
});
