import './bootstrap';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import os from 'os';
import { runMigrations } from './db/schema';
import { db } from './db/db';
import { SessionManager } from './session/SessionManager';
import { handleMessage } from './ws/router';
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
import { createTasksRouter, setTaskBroadcast } from './routes/tasks';
import { analyticsRouter } from './routes/analytics';
import { projectsRouter, setAutoMerger } from './routes/projects';
import { requireDeviceAuth, validateWsToken } from './auth/DeviceAuth';
import {
  createEnrollmentRouter,
  setEnrollmentBroadcast,
} from './auth/Enrollment';
import { getActiveDeviceCount } from './db/queries';
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
import { ConcludedSessionArchiver } from './orchestration/ConcludedSessionArchiver';
import { deleteGhostSessions, getPRBySessionId } from './db/queries';
import { UpdateChecker, cleanUpdatesDir } from './updater/index';
import { updateRouter, setUpdateChecker } from './routes/update';
import { runPRBootSweep } from './github/PRBootSweep';
import { runBootIdleReconciliation } from './session/bootIdleReconciliation';
import setupRouter, { createSetupModeGuard } from './routes/setup';

runMigrations(db);
loadRuntimeSettingsFromDb();
importProjectsFromEnv(process.env.PROJECTS);

const _cm = getCorporateMode();
console.log(
  `[corporateMode] mode=${_cm.enabled ? 'corporate' : 'personal'} envLocked=${_cm.envLocked} gates=${JSON.stringify(_cm.gates)}`,
);

const ghostsRemoved = deleteGhostSessions();
if (ghostsRemoved > 0) {
  console.log(
    `[server] cleaned up ${ghostsRemoved} ghost session(s) with no events`,
  );
}

const rawSessionsDir =
  getOrchestratorConfig().sessions.dir || DEFAULT_SESSIONS_DIR;
const sessionsDir = rawSessionsDir.replace(/^~/, os.homedir());
const jsonlReader = new JsonlReader(sessionsDir);

if (process.env.TASK_BACKEND) {
  console.warn(
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
// Enrollment endpoints are public — mount before the device auth middleware
app.use('/api/enrollment', createEnrollmentRouter());
// Setup endpoints are public — wizard UI uses them before credentials exist
app.use('/api', setupRouter);
// Gate all other /api routes when setup has not been completed
app.use('/api', createSetupModeGuard());
app.use(requireDeviceAuth);
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
  ),
);
app.use('/api', createTasksRouter());
app.use('/api/analytics', analyticsRouter);
app.use('/api', projectsRouter);
app.use('/api', configRouter);
app.use('/api', updateRouter);
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

// Broadcast all session events to every connected WS client
sessionManager.on('message', broadcast);

// ── Push-detected re-review loop ─────────────────────────────────────────────

// All push pipeline logic lives in PRMergeWatcher.handlePushDetected.
// This thin wrapper resolves the coding session → PR row and delegates.
sessionManager.on(
  'push_detected',
  ({ sessionId: codingSessionId }: { sessionId: string }) => {
    console.log(
      `[server] push_detected from session ${codingSessionId.slice(0, 8)}`,
    );
    const prRow = getPRBySessionId(codingSessionId);
    if (!prRow || prRow.state !== 'open') {
      console.log(
        `[server] push_detected: no open PR for session (found=${!!prRow})`,
      );
      return;
    }
    void prMergeWatcher.handlePushDetected(prRow);
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
  }

  console.log('[WS] client connected');

  // Send existing active (non-archived) sessions to the new client so the UI populates on load.
  // session_status messages in this burst carry replay: true so the frontend can suppress
  // notification firing — otherwise every backend restart re-fires notifications for every
  // historical non-archived session.
  sendInitialStateBurst((msg) => ws.send(JSON.stringify(msg)));

  ws.on('message', (data) =>
    handleMessage(ws, data.toString(), sessionManager),
  );
  ws.on('close', () => console.log('[WS] client disconnected'));
});

// AutoLauncher is constructed up-front so it can be referenced during shutdown,
// but .start() runs only after orphan resume so the two don't race on slot
// reservations (orphan resume reserves slots from this.sessions.size).
const autoLauncher = new AutoLauncher(sessionManager, broadcast);

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

// Orphaned-task sweep: runs at the auto-launch poll interval, finds tasks stuck
// at In Progress with no live session and reverts them to Ready.
// sendOrResume is wired so idle sessions without a PR are nudged rather than reverted.
const orphanedTaskSweeper = new OrphanedTaskSweeper(broadcast, {
  sendOrResume: (sessionId, text) =>
    sessionManager.sendOrResume(sessionId, text),
});

// Concluded-session archiver: periodically archives sessions that have been
// in a terminal state longer than the configured grace period.
const concludedSessionArchiver = new ConcludedSessionArchiver(broadcast);

jsonlReader
  .importAll()
  .then(async () => {
    jsonlReader.backfillTokens();

    await sessionManager
      .resumeOrphanSessions()
      .catch((err: unknown) =>
        console.warn(
          '[server] orphan session resume failed:',
          (err as Error).message,
        ),
      );

    stuckSessionMonitor.rehydrate();
    stuckSessionMonitor.startScan();
    autoMerger.rehydrate();

    runPRBootSweep(githubClient)
      .then(() => runBootIdleReconciliation())
      .catch((err: unknown) =>
        console.warn('[server] PR boot sweep failed:', (err as Error).message),
      );

    prMergeWatcher.start();
    reviewerCommentsWatcher.start();

    await autoLauncher
      .start()
      .catch((err: unknown) =>
        console.warn(
          '[server] auto-launcher start failed:',
          (err as Error).message,
        ),
      );

    orphanedTaskSweeper.start();
    concludedSessionArchiver.start();
    updateChecker.start();

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[server] listening on port ${PORT}`);
      console.log('[server] LAN access enabled — device auth required');
    });
  })
  .catch((err: unknown) => {
    console.error('[server] JSONL import failed:', err);
    process.exit(1);
  });

async function gracefulShutdown(signal: string) {
  console.log(`[server] ${signal} received — shutting down`);
  autoLauncher.stop();
  stuckSessionMonitor.stop();
  orphanedTaskSweeper.stop();
  concludedSessionArchiver.stop();
  updateChecker.stop();
  reviewerCommentsWatcher.stop();
  wss.close();
  await sessionManager.shutdownAll();
  server.close();
  db.close();
  process.exit(0);
}

function shutdownWithTimeout(signal: string) {
  gracefulShutdown(signal).catch(console.error);
  setTimeout(() => {
    console.error('[server] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdownWithTimeout('SIGTERM'));
process.on('SIGINT', () => shutdownWithTimeout('SIGINT'));
