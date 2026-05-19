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
import { JsonlReader, DEFAULT_SESSIONS_DIR } from './session/JsonlReader';
import type { ServerMessage } from './ws/types';
import { permissionEventsRouter, permissionDenialsRouter, permissionRulesRouter } from './routes/rules';
import configRouter from './routes/config';
import settingsRouter, { loadRuntimeSettingsFromDb } from './routes/settings';
import { sessionsRouter, setBroadcast } from './routes/sessions';
import { createPrsRouter, setPRBroadcast } from './routes/prs';
import { createTasksRouter, setTaskBroadcast } from './routes/tasks';
import { analyticsRouter } from './routes/analytics';
import { projectsRouter } from './routes/projects';
import { importProjectsFromEnv } from './projects/projectImport';
import { GitHubClient } from './github/GitHubClient';
import { PRReviewService } from './github/PRReviewService';
import { ReviewOrchestrator } from './github/ReviewOrchestrator';
import { PRMergeWatcher } from './github/PRMergeWatcher';
import { AUTO_REVIEW_ENABLED, AUTO_REVIEW_CONCURRENCY } from './config';
import { AutoLauncher } from './orchestration/AutoLauncher';
import { getActiveSessions, getEventsBySession, getDenialsBySession, deleteGhostSessions, getPRByNotionTaskId, getPRBySessionId, setPRReviewResult, setLastReviewedSha, setHeadSha, getSetting, setPendingPush } from './db/queries';
import { isSystemOnlyUserEvent } from './utils/eventFilters';
import { shouldAutoReview, formatReviewFeedback } from './github/reviewUtils';
import type { PRReviewResult } from './github/PRReviewService';

runMigrations();
loadRuntimeSettingsFromDb();
importProjectsFromEnv(process.env.PROJECTS);

const ghostsRemoved = deleteGhostSessions();
if (ghostsRemoved > 0) {
  console.log(`[server] cleaned up ${ghostsRemoved} ghost session(s) with no events`);
}

const rawSessionsDir = process.env.SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;
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
const prReviewService = new PRReviewService(githubClient, undefined, sessionManager);
// Constructed for its side effect: subscribes to sessionManager 'pr_opened' events.
// The reference is intentionally not retained (kept alive via the event listener).
const reviewOrchestrator = new ReviewOrchestrator(
  prReviewService, sessionManager, AUTO_REVIEW_CONCURRENCY, AUTO_REVIEW_ENABLED,
);

const PORT = parseInt(process.env.PORT ?? '3000');

const app = express();
app.use(express.json());
app.use('/api/permission-events', permissionEventsRouter);
app.use('/api/permission-denials', permissionDenialsRouter);
app.use('/api/permission-rules', permissionRulesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/sessions', sessionsRouter);
// PRMergeWatcher created early so routes and sync jobs can delegate lifecycle to it.
// .start() is called later after server boots.
const prMergeWatcher = new PRMergeWatcher(githubClient, sessionManager, undefined, broadcast);
// After an approved verdict, the review service should trigger an immediate
// watcher-style mergeability check so we don't wait for the next 5-min poll.
prReviewService.setMergeWatcher(prMergeWatcher);
app.use('/api', createPrsRouter(githubClient, prReviewService, sessionManager, undefined, prMergeWatcher));
app.use('/api', createTasksRouter());
app.use('/api/analytics', analyticsRouter);
app.use('/api', projectsRouter);
app.use('/api', configRouter);
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
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
// Wire broadcast into the prs router (for merge/close events)
setPRBroadcast(broadcast);
// Wire broadcast into the tasks route (for task_updated WS messages)
setTaskBroadcast(broadcast);

// Broadcast all session events to every connected WS client
sessionManager.on('message', broadcast);

// ── Push-detected re-review loop ─────────────────────────────────────────────

const PUSH_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REVIEW_ITERATIONS = 3;
const pendingReReviews = new Set<string>();

function getMaxReviewIterations(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_REVIEW_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REVIEW_ITERATIONS;
}


sessionManager.on('push_detected', ({ sessionId: codingSessionId }: { sessionId: string }) => {
  console.log(`[server] push_detected from session ${codingSessionId.slice(0, 8)}`);
  if (!AUTO_REVIEW_ENABLED) { console.log('[server] push_detected: auto-review disabled'); return; }
  if (pendingReReviews.has(codingSessionId)) { console.log('[server] push_detected: already pending for this session'); return; }

  const prRow = getPRBySessionId(codingSessionId);
  if (!prRow || prRow.state !== 'open') { console.log(`[server] push_detected: no open PR for session (found=${!!prRow})`); return; }
  if (!prRow.review_session_id) {
    // Initial review hasn't started yet — queue the push so it triggers
    // re-review after the initial review session is established.
    setPendingPush(prRow.pr_number, prRow.repo, 1);
    console.log(`[server] push_detected for PR #${prRow.pr_number} before review session established — queued as pending_push`);
    return;
  }

  pendingReReviews.add(codingSessionId);

  void (async () => {
    let headSha = prRow.head_sha;
    let fetchError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const freshPR = await githubClient.fetchPR(prRow.repo, prRow.pr_number);
        headSha = freshPR.headSha;
        fetchError = undefined;
        if (headSha !== prRow.head_sha) {
          setHeadSha(prRow.pr_number, prRow.repo, headSha);
        }
        break;
      } catch (e) {
        fetchError = e;
        if (attempt === 0) {
          console.warn(`[server] fetch PR #${prRow.pr_number} failed (attempt 1), retrying...`);
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
    if (fetchError) {
      console.warn(`[server] failed to fetch latest PR state for #${prRow.pr_number} after retry:`, fetchError);
    }

    const maxIter = getMaxReviewIterations();

    // Escalation cap reached — emit review_escalated before bailing out.
    // shouldAutoReview() also catches this, but it returns a plain boolean
    // with no way to distinguish cap-reached vs same-SHA, so we check explicitly.
    if (prRow.review_iteration >= maxIter) {
      const message = `Review loop for PR #${prRow.pr_number} reached ${maxIter} iterations without approval. Manual intervention needed.`;
      console.warn(`[server] ${message}`);
      sessionManager.emit('message', {
        type: 'review_escalated',
        prNumber: prRow.pr_number,
        repo: prRow.repo,
        message,
      });
      pendingReReviews.delete(codingSessionId);
      return;
    }

    const autoReviewOk = shouldAutoReview(
      { reviewIteration: prRow.review_iteration, headSha, lastReviewedSha: prRow.last_reviewed_sha },
      maxIter,
    );
    console.log(`[server] shouldAutoReview: iter=${prRow.review_iteration}/${maxIter} head=${headSha?.slice(0,7)} lastReviewed=${prRow.last_reviewed_sha?.slice(0,7)} → ${autoReviewOk}`);
    if (!autoReviewOk) {
      pendingReReviews.delete(codingSessionId);
      return;
    }

    const iteration = prRow.review_iteration + 1;
    try {
      let result: PRReviewResult;
      try {
        result = await Promise.race([
          prReviewService.reReviewPR(prRow.pr_number, prRow.repo),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Re-review timed out')), PUSH_REVIEW_TIMEOUT_MS),
          ),
        ]);
      } catch (e) {
        const summary = e instanceof Error ? e.message : String(e);
        console.error(`[server] re-review failed for PR #${prRow.pr_number}:`, e);
        setPRReviewResult(prRow.pr_number, prRow.repo, JSON.stringify({ verdict: 'error', summary, dimensions: [] }));
        sessionManager.emit('message', {
          type: 'review_verdict',
          prNumber: prRow.pr_number,
          repo: prRow.repo,
          verdict: 'error',
          summary,
          iteration,
        });
        return;
      }

      setLastReviewedSha(prRow.pr_number, prRow.repo, headSha);
      sessionManager.emit('message', {
        type: 'review_verdict',
        prNumber: prRow.pr_number,
        repo: prRow.repo,
        verdict: result.verdict,
        summary: result.summary,
        iteration,
      });

      if (result.verdict === 'needs_changes') {
        try {
          await sessionManager.sendOrResume(codingSessionId, formatReviewFeedback(result, iteration));
        } catch (e) {
          console.warn(`[server] Failed to deliver review feedback to session ${codingSessionId}:`, e);
        }
      } else if (result.verdict === 'incomplete') {
        const message = `Review for PR #${prRow.pr_number} returned an incomplete verdict — the reviewer could not assess the PR. Manual intervention needed.`;
        console.warn(`[server] ${message}`);
        sessionManager.emit('message', {
          type: 'review_incomplete',
          prNumber: prRow.pr_number,
          repo: prRow.repo,
          message,
        });
      }
    } finally {
      pendingReReviews.delete(codingSessionId);
    }
  })();
});

wss.on('connection', (ws) => {
  console.log('[WS] client connected');

  // Send existing active (non-archived) sessions to the new client so the UI populates on load
  for (const s of getActiveSessions()) {
    const tags = s.tags ? (() => { try { return JSON.parse(s.tags) as string[]; } catch { return undefined; } })() : undefined;
    const reviewPr = s.session_type === 'review' && s.notion_task_id
      ? (getPRByNotionTaskId(s.notion_task_id) ?? undefined)
      : undefined;
    const prNumber = reviewPr?.pr_number;
    const codeSessionId = reviewPr?.session_id ?? undefined;
    ws.send(JSON.stringify({
      type: 'session_started',
      sessionId: s.session_id,
      taskName: s.task_name ?? s.notion_task_url ?? s.session_id.slice(0, 8),
      notionTaskUrl: s.notion_task_url ?? '',
      ...(s.started_at != null && { started_at: s.started_at }),
      ...(s.ended_at != null && { ended_at: s.ended_at }),
      archived: s.archived === 1,
      favorited: s.favorited === 1,
      project_id: s.project_id,
      sessionType: s.session_type,
      ...(prNumber != null && { prNumber }),
      ...(codeSessionId != null && { codeSessionId }),
      note: s.note ?? null,
      tags,
      totalInputTokens: s.total_input_tokens ?? 0,
      totalOutputTokens: s.total_output_tokens ?? 0,
      model: s.model ?? null,
      ...(s.pr_url != null && { prUrl: s.pr_url }),
    } satisfies ServerMessage));
    ws.send(JSON.stringify({
      type: 'session_status',
      sessionId: s.session_id,
      status: s.status,
    } satisfies ServerMessage));

    // Send stored events so the transcript populates.
    // Skip user events that contain only system-injected content — they are
    // stored in the DB for debugging but are noise in the transcript UI.
    for (const ev of getEventsBySession(s.session_id)) {
      if (isSystemOnlyUserEvent(ev.payload)) continue;
      ws.send(JSON.stringify({
        type: 'session_event',
        sessionId: s.session_id,
        eventType: ev.event_type as 'text' | 'tool_use' | 'tool_result' | 'system' | 'user_message',
        content: ev.payload,
        ...(ev.message_id != null && { messageId: ev.message_id }),
      } satisfies ServerMessage));
    }

    // Send stored permission denials so SessionDetail shows them after reconnect
    const denials = getDenialsBySession(s.session_id);
    if (denials.length > 0) {
      ws.send(JSON.stringify({
        type: 'permission_denials',
        sessionId: s.session_id,
        denials: denials.map((d) => ({
          tool_name: d.tool_name,
          tool_use_id: d.tool_use_id,
          tool_input: JSON.parse(d.tool_input) as Record<string, unknown>,
        })),
      } satisfies ServerMessage));
    }
  }

  ws.on('message', (data) => handleMessage(ws, data.toString(), sessionManager));
  ws.on('close', () => console.log('[WS] client disconnected'));
});

// AutoLauncher is constructed up-front so it can be referenced during shutdown,
// but .start() runs only after orphan resume so the two don't race on slot
// reservations (orphan resume reserves slots from this.sessions.size).
const autoLauncher = new AutoLauncher(sessionManager, broadcast);

jsonlReader.importAll().then(async () => {
  jsonlReader.backfillTokens();

  await sessionManager.resumeOrphanSessions().catch((err: unknown) =>
    console.warn('[server] orphan session resume failed:', (err as Error).message)
  );

  prMergeWatcher.start();

  await autoLauncher.start().catch((err: unknown) =>
    console.warn('[server] auto-launcher start failed:', (err as Error).message)
  );

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on port ${PORT}`);
    console.log('[server] LAN access enabled — no authentication');
  });
}).catch((err: unknown) => {
  console.error('[server] JSONL import failed:', err);
  process.exit(1);
});

async function gracefulShutdown(signal: string) {
  console.log(`[server] ${signal} received — shutting down`);
  autoLauncher.stop();
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
