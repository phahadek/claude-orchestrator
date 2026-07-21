import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../logger';
import { getProjectById, runtimeSettings } from '../config';
import { getProjectRepos } from '../projects/ProjectService';
import { getTaskBackend } from '../tasks/TaskBackend';
import {
  getTaskCache,
  getActiveTaskAggregates,
  clearTaskPauseReason,
  resetTaskCrashCount,
  deleteTaskCacheRow,
  getTaskRepoAssignment,
  setTaskRepoAssignment,
  getPRByNotionTaskId,
  clearTerminalPRFlags,
  getMilestoneById,
} from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { typedGetSetting } from '../config/settings';
import type { TaskAggregateRow } from '../db/queries';
import { planMove, MoveTaskError } from '../orchestration/moveTask';
import { deriveDisplayStatus } from '../tasks/TaskStatusEngine';
import type { NotionTask } from '../notion/types';
import { DependencyResolver } from '../notion/DependencyResolver';
import type { PRReviewResult } from '../github/PRReviewService';
import type { ServerMessage, TaskView } from '../ws/types';
import { parsePauseReason, deriveRecoveryDescriptor } from '../db/pauseReason';
import { computeOpsBlockingDeps, isOpsEligibleType } from '../ops/opsLoad';
import yaml from 'js-yaml';
export type { TaskView } from '../ws/types';

export interface TasksActiveResponse {
  tasks: TaskView[];
  lastRefreshedAt: number | null;
  stale: boolean;
  coldCache: boolean;
}

function getReviewIterationCap(): number {
  return typedGetSetting('max_review_iterations');
}

/**
 * Mutates `views` in place with opsDepBlocked/opsDepBlockedReason for every
 * ops-eligible task (🔧 Operational / 🔎 Investigation / 🧪 Testing) —
 * mirrors the frontend's OPS_TASK_TYPES gate so the Ops(N) checkbox can be
 * disabled up front instead of the task silently being dropped by
 * /ops/launch's worklist.executable filter. Uses the local_branches-only
 * (`fast`) merge-commit lookup — this runs on every poll of a frequently
 * refetched list, so it can't afford a GitHub round trip per dependency.
 */
async function annotateOpsDepBlocking(
  views: TaskView[],
  allTasks: NotionTask[],
  projectId: string,
): Promise<void> {
  const opsTasks = allTasks.filter((t) => isOpsEligibleType(t.type));
  if (opsTasks.length === 0) return;
  try {
    const blocking = await computeOpsBlockingDeps(
      allTasks,
      opsTasks,
      projectId,
      {
        fast: true,
      },
    );
    for (const view of views) {
      const info = blocking.get(view.taskId);
      if (!info) continue;
      view.opsDepBlocked = info.blockingDepIds.length > 0;
      view.opsDepBlockedReason =
        info.blockingDepTitles.length > 0
          ? `waiting on ${info.blockingDepTitles.join(', ')}`
          : null;
    }
  } catch {
    // ignore — views retain default (undefined) ops dep-block fields
  }
}

// ── Broadcast infrastructure ─────────────────────────────────────────────────
let taskBroadcastFn: ((msg: ServerMessage) => void) | null = null;

export function setTaskBroadcast(fn: (msg: ServerMessage) => void): void {
  taskBroadcastFn = fn;
}

// ── TaskCacheRefresher hook ───────────────────────────────────────────────────
let cacheRefresherFn:
  | ((projectId: string, skipCache?: boolean) => Promise<void>)
  | null = null;

export function setTaskCacheRefresher(
  fn: (projectId: string, skipCache?: boolean) => Promise<void>,
): void {
  cacheRefresherFn = fn;
}

/** Build a TaskView for a single notionTaskId and broadcast it as task_updated. */
export function emitTaskUpdated(notionTaskId: string): void {
  if (!taskBroadcastFn) return;
  const task = buildTaskView(notionTaskId);
  if (task) taskBroadcastFn({ type: 'task_updated', task });
}

/** Build a TaskView for a single notionTaskId from current DB state. Returns null if not found. */
function buildTaskView(notionTaskId: string): TaskView | null {
  const rows = getActiveTaskAggregates([notionTaskId]);
  if (rows.length === 0) return null;
  return buildTaskViewFromRow(rows[0], getReviewIterationCap());
}

// ── Row → TaskView mapping ───────────────────────────────────────────────────

function buildTaskViewFromRow(row: TaskAggregateRow, cap: number): TaskView {
  let notionTask: NotionTask | null = null;
  try {
    notionTask = JSON.parse(row.raw_json) as NotionTask;
  } catch {
    // leave as null
  }

  const notionStatus = notionTask?.status ?? '';
  const priority = notionTask?.priority ?? '';

  let codeSession: TaskView['codeSession'] = null;
  if (row.code_session_id) {
    const lastMessage = row.code_session_last_event_payload
      ? summarizeEvent(row.code_session_last_event_payload)
      : '';
    codeSession = {
      sessionId: row.code_session_id,
      status: row.code_session_status ?? '',
      sessionType: row.code_session_type ?? 'standard',
      startedAt: row.code_session_started_at ?? 0,
      endedAt: row.code_session_ended_at ?? null,
      lastMessage,
      inputTokens: row.code_session_input_tokens ?? 0,
      outputTokens: row.code_session_output_tokens ?? 0,
      context_occupancy_tokens:
        row.code_session_context_occupancy_tokens ?? undefined,
      compaction_count: row.code_session_compaction_count ?? undefined,
      model: row.code_session_model ?? null,
    };
  }

  let pr: TaskView['pr'] = null;
  if (row.pr_number != null && row.pr_url) {
    pr = {
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      title: row.pr_title ?? '',
      headBranch: row.pr_head_branch ?? '',
      baseBranch: row.pr_base_branch ?? '',
      state: row.pr_state ?? '',
      draft: row.pr_draft === 1,
      mergeState: row.pr_merge_state ?? null,
      preReviewStage: row.pr_pre_review_stage ?? null,
    };
  }

  let review: TaskView['review'] = null;
  let reviewVerdict: string | null = null;
  let reviewSummary: string | null = null;
  if (row.review_session_id) {
    // Prefer PR-level review result (GitHub flow); fall back to session-level (local-only).
    const rawReviewResult = row.pr_review_result ?? row.review_session_result;
    if (rawReviewResult) {
      try {
        const result = JSON.parse(rawReviewResult) as PRReviewResult;
        reviewVerdict = result.verdict ?? null;
        reviewSummary = result.summary ?? null;
      } catch {
        // ignore
      }
    }
    review = {
      sessionId: row.review_session_id,
      status: row.review_session_status ?? '',
      verdict: reviewVerdict,
      summary: reviewSummary,
      iterationCount: row.pr_review_iteration ?? 0,
      inputTokens: row.review_session_input_tokens ?? 0,
      outputTokens: row.review_session_output_tokens ?? 0,
    };
  }

  const pauseStruct = parsePauseReason(
    row.pr_pause_reason ?? row.session_pr_creation_failed_pause_reason ?? null,
  );

  const displayStatus = deriveDisplayStatus({
    notionStatus,
    codeSessionStatus: row.code_session_status ?? null,
    prState: row.pr_state ?? null,
    prDraft: row.pr_draft === 1,
    reviewVerdict,
    reviewIterationCount: row.pr_review_iteration ?? 0,
    reviewIterationCap: cap,
    pauseReason: pauseStruct,
  });

  const totalTokens = {
    input:
      (row.code_session_input_tokens ?? 0) +
      (row.review_session_input_tokens ?? 0),
    output:
      (row.code_session_output_tokens ?? 0) +
      (row.review_session_output_tokens ?? 0),
  };

  return {
    taskId: row.task_id,
    taskName: notionTask?.title ?? row.task_id,
    notionStatus,
    displayStatus,
    pauseReason: pauseStruct?.reason ?? null,
    pauseDetail: pauseStruct?.detail ?? null,
    priority,
    notionUrl: notionTask?.notionUrl ?? '',
    taskType: notionTask?.type ?? '',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession,
    pr,
    review,
    totalTokens,
    assignedRepo: getTaskRepoAssignment(row.task_id)?.repo ?? null,
    recoveryDescriptor: deriveRecoveryDescriptor(pauseStruct?.reason ?? null),
  };
}

const TOOL_MAX = 80;

function extractToolArg(name: string, input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      const p = str(input.file_path);
      return p ? (p.replace(/\\/g, '/').split('/').pop() ?? p) : '';
    }
    case 'Bash':
      return str(input.command).trim().split(/\s+/)[0] ?? '';
    case 'Grep':
      return str(input.pattern);
    case 'Glob':
      return str(input.pattern);
    case 'Agent':
      return str(input.description);
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
      return str(input.query);
    default:
      return '';
  }
}

function formatToolCall(name: string, input: unknown): string {
  const inputObj =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const arg = extractToolArg(name, inputObj);
  const label = arg ? `${name}(${arg})` : name;
  return label.length > TOOL_MAX ? label.slice(0, TOOL_MAX - 1) + '…' : label;
}

/** Extract a brief human-readable summary from a raw session event payload (max 120 chars). */
export function summarizeEvent(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload.slice(0, 120);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return String(parsed).slice(0, 120);
  }

  const p = parsed as Record<string, unknown>;

  // Assistant text event: { type: 'assistant', message: { content: [...] } }
  const msg = p.message as Record<string, unknown> | undefined;
  const content = msg?.content ?? p.content;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (
        b.type === 'text' &&
        typeof b.text === 'string' &&
        b.text.trim().length > 0
      ) {
        const text = b.text.trim().replace(/\s+/g, ' ');
        return text.length > 120 ? text.slice(0, 117) + '…' : text;
      }
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        return formatToolCall(b.name, b.input);
      }
    }
  }

  if (typeof content === 'string' && content.trim().length > 0) {
    const text = content.trim().replace(/\s+/g, ' ');
    return text.length > 120 ? text.slice(0, 117) + '…' : text;
  }

  // tool_use event: { type: 'tool_use', name: '...', input: {...} }
  if (typeof p.name === 'string') {
    return formatToolCall(p.name, p.input);
  }

  return '';
}

interface SessionManagerLike {
  sendOrResume(sessionId: string, text: string): Promise<string | null>;
  findLiveSessionIdForTask(taskId: string): string | undefined;
  abortSession(sessionId: string): Promise<void>;
}

interface ReviewOrchestratorLike {
  runAutofixPipeline(
    prNumber: number,
    repo: string,
    taskId: string | null,
  ): Promise<{ success: boolean; summary: string }>;
}

// ── Shared recovery executors ────────────────────────────────────────────────
// Single implementation of each Needs-Attention recovery action. Used by the
// unified POST /tasks/:taskId/recover endpoint and by the deprecated
// POST /tasks/:taskId/unblock + POST /prs/:prNumber/unpark aliases, so there is
// exactly one code path per action instead of duplicated logic.

/**
 * redispatch — clear the sticky pause + crash count, drop the stale task-cache
 * row, evict/abort any lingering live session for the task, and set the task
 * back to Ready. This is the clear-pause primitive the legacy `unblock`
 * endpoint performed. Rejects if `backend.updateStatus` rejects.
 *
 * Evicting the live session before setting Ready matters because a stalled or
 * hung session can otherwise survive in SessionManager's in-memory map
 * indefinitely, causing AutoLauncher to skip every relaunch attempt with
 * "live session already exists".
 */
async function executeRedispatch(
  backend: Awaited<ReturnType<typeof getTaskBackend>>,
  taskId: string,
  sessionManager?: SessionManagerLike,
): Promise<void> {
  clearTaskPauseReason(taskId);
  resetTaskCrashCount(taskId);
  deleteTaskCacheRow(taskId);

  const liveSessionId = sessionManager?.findLiveSessionIdForTask(taskId);
  if (liveSessionId) {
    await sessionManager!.abortSession(liveSessionId);
  }

  await backend.updateStatus(taskId, '🗂️ Ready', { source: 'orchestrator' });
  emitTaskUpdated(taskId);
  if (taskBroadcastFn) {
    taskBroadcastFn({
      type: 'task_status_changed',
      notionTaskId: taskId,
      newStatus: '🗂️ Ready',
    });
  }
}

/**
 * rerun — clear terminal PR flags (pause + pre-review stage) and re-enqueue the
 * pre-review/autofix pipeline so the PR can recover without being merged. This
 * is the primitive the legacy `unpark` endpoint performed. The pipeline runs
 * fire-and-forget.
 */
export function executeRerunPipeline(
  prNumber: number,
  repo: string,
  taskId: string | null,
  reviewOrchestrator?: ReviewOrchestratorLike,
): void {
  clearTerminalPRFlags(prNumber, repo, 'human_unpark');
  if (reviewOrchestrator) {
    void reviewOrchestrator
      .runAutofixPipeline(prNumber, repo, taskId)
      .catch((err: unknown) =>
        logger.error('[recover] rerun pipeline failed:', err),
      );
  }
  if (taskId) emitTaskUpdated(taskId);
}

export function createTasksRouter(
  sessionManager?: SessionManagerLike,
  reviewOrchestrator?: ReviewOrchestratorLike,
): Router {
  const router = Router();

  // ── GET /api/tasks/export?format=yaml&projectId=<id>&boardId=<id> ────────
  router.get('/tasks/export', (req: Request, res: Response) => {
    const format =
      typeof req.query.format === 'string' ? req.query.format : 'yaml';
    if (format !== 'yaml') {
      res.status(400).json({ error: 'Only format=yaml is supported' });
      return;
    }

    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
    const project = projectId ? getProjectById(projectId) : null;
    const boardId = project
      ? typeof req.query.boardId === 'string' && req.query.boardId
        ? req.query.boardId
        : project.boardId
      : typeof req.query.boardId === 'string'
        ? req.query.boardId
        : '';

    if (!boardId) {
      res
        .status(400)
        .json({ error: 'boardId or projectId query param is required' });
      return;
    }

    const cacheKey = `board:${boardId}`;
    const boardCacheRow = getTaskCache(cacheKey);
    if (!boardCacheRow) {
      res
        .status(404)
        .json({ error: 'Board not found in cache. Fetch tasks first.' });
      return;
    }

    let notionTasks: NotionTask[];
    try {
      notionTasks = JSON.parse(boardCacheRow.raw_json) as NotionTask[];
    } catch {
      res.status(500).json({ error: 'Failed to parse board cache' });
      return;
    }

    const exportedTasks = notionTasks
      .filter((t) => !t.status.includes('Deferred'))
      .map((t) => ({
        id: t.id,
        name: t.title,
        status: t.status.replace(/^[^\s]+ /, ''), // strip emoji prefix
        priority: t.priority?.replace(/^[^\s]+ /, '') ?? '',
        type: t.type ?? 'Code',
        depends_on: t.dependsOn ?? [],
        pr_url: t.prUrl ?? null,
        context: '',
        acceptance_criteria: '',
        files_affected: [],
        notes: '',
      }));

    const output = yaml.dump(
      { board_id: boardId, tasks: exportedTasks },
      { lineWidth: 120 },
    );

    res.setHeader('Content-Type', 'application/yaml');
    res.send(output);
  });

  // ── GET /api/tasks/non-milestone?projectId=<id> ─────────────────────────
  router.get('/tasks/non-milestone', async (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) {
      res.status(400).json({ error: 'projectId query param is required' });
      return;
    }

    const project = getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }

    const cacheKey = `non_milestone:${projectId}`;
    const cacheRow = getTaskCache(cacheKey);
    if (!cacheRow) {
      res.json([]);
      return;
    }

    let notionTasks: NotionTask[];
    try {
      notionTasks = JSON.parse(cacheRow.raw_json) as NotionTask[];
    } catch {
      res.json([]);
      return;
    }

    const taskIds = notionTasks.map((t) => t.id);
    const aggregates = getActiveTaskAggregates(taskIds);
    const cap = getReviewIterationCap();
    const views: TaskView[] = aggregates
      .map((row) => buildTaskViewFromRow(row, cap))
      .filter((v) => !v.notionStatus.includes('Deferred'));

    // Resolve blocked status from the full non-milestone task list
    try {
      const resolver = new DependencyResolver();
      const resolved = resolver.resolve(notionTasks);
      const resolvedMap = new Map(resolved.map((r) => [r.task.id, r]));
      for (const view of views) {
        const r = resolvedMap.get(view.taskId);
        if (r) {
          view.blocked = r.blocked;
          view.blockerNames = r.blockers.map((b) => b.title);
          view.wave = r.wave;
        }
      }
    } catch {
      // ignore — views retain their default blocked: false
    }

    await annotateOpsDepBlocking(views, notionTasks, projectId);

    res.json(views);
  });

  // ── GET /api/tasks/active?projectId=<id>&boardId=<id> ────────────────────
  router.get('/tasks/active', async (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) {
      res.status(400).json({ error: 'projectId query param is required' });
      return;
    }

    const project = getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }

    // Determine boardId: prefer explicit query param, fall back to project default
    const boardId =
      typeof req.query.boardId === 'string' && req.query.boardId
        ? req.query.boardId
        : project.boardId;

    // Read the board cache to get the list of task IDs for this board.
    // boardId is the DB milestone UUID, matching the write-side cache key.
    const cacheKey = `board:${boardId}`;
    const boardCacheRow = getTaskCache(cacheKey);

    // Cold cache: no data yet — return immediately without blocking on Notion.
    if (!boardCacheRow) {
      const response: TasksActiveResponse = {
        tasks: [],
        lastRefreshedAt: null,
        stale: false,
        coldCache: true,
      };
      res.json(response);
      return;
    }

    let allBoardTasks: NotionTask[];
    try {
      allBoardTasks = JSON.parse(boardCacheRow.raw_json) as NotionTask[];
    } catch {
      allBoardTasks = [];
    }
    const taskIds = allBoardTasks.map((t) => t.id);

    const aggregates = getActiveTaskAggregates(taskIds);
    const cap = getReviewIterationCap();
    const views: TaskView[] = aggregates
      .map((row) => buildTaskViewFromRow(row, cap))
      .filter((v) => !v.notionStatus.includes('Deferred'));

    // Resolve blocked status from the full board task list
    try {
      const resolver = new DependencyResolver();
      const resolved = resolver.resolve(allBoardTasks);
      const resolvedMap = new Map(resolved.map((r) => [r.task.id, r]));
      for (const view of views) {
        const r = resolvedMap.get(view.taskId);
        if (r) {
          view.blocked = r.blocked;
          view.blockerNames = r.blockers.map((b) => b.title);
          view.wave = r.wave;
        }
      }
    } catch {
      // ignore — views retain their default blocked: false
    }

    await annotateOpsDepBlocking(views, allBoardTasks, projectId);

    const stale =
      Date.now() - boardCacheRow.fetched_at >
      runtimeSettings.task_cache_refresh_interval_ms * 2;

    const response: TasksActiveResponse = {
      tasks: views,
      lastRefreshedAt: boardCacheRow.fetched_at,
      stale,
      coldCache: false,
    };
    res.json(response);
  });

  // ── POST /api/tasks/refresh ──────────────────────────────────────────────
  router.post('/tasks/refresh', (req: Request, res: Response) => {
    const body = req.body as { projectId?: unknown };
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }
    const project = getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }
    // Trigger background refresh — returns 202 immediately; broadcasts task_cache_updated when done.
    if (cacheRefresherFn) {
      void cacheRefresherFn(projectId, true).catch((err: unknown) => {
        logger.warn(
          `[tasks] /refresh background error for ${projectId}: ${String(err)}`,
        );
      });
    }
    res.status(202).json({ ok: true, message: 'Refresh queued' });
  });

  // ── POST /api/tasks/:taskId/unblock ─────────────────────────────────────
  // @deprecated Superseded by POST /tasks/:taskId/recover (redispatch action).
  // Retained as a thin alias over the shared redispatch executor for the current
  // frontend; the unified /recover endpoint is the canonical recovery interface.
  router.post('/tasks/:taskId/unblock', async (req: Request, res: Response) => {
    const taskId = String(req.params.taskId);
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : null;

    if (!projectId) {
      res.status(422).json({ error: 'projectId is required' });
      return;
    }

    let backend: Awaited<ReturnType<typeof getTaskBackend>>;
    try {
      backend = getTaskBackend(projectId);
    } catch {
      res
        .status(422)
        .json({ error: `Cannot resolve backend for project '${projectId}'` });
      return;
    }

    try {
      await executeRedispatch(backend, taskId, sessionManager);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to update status',
      });
      return;
    }

    recordEvent({
      event_type: 'task_unblocked',
      actor_type: 'human',
      project_id: projectId,
      task_id: taskId,
      payload: { taskId, projectId },
    });

    res.json({ ok: true, newStatus: '🗂️ Ready' });
  });

  // ── POST /api/tasks/:taskId/assign-repo ────────────────────────────────────
  router.post('/tasks/:taskId/assign-repo', (req: Request, res: Response) => {
    const taskId = String(req.params.taskId);
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const body = req.body as { repo?: unknown };
    const repo = typeof body.repo === 'string' ? body.repo.trim() : null;

    if (!projectId) {
      res.status(422).json({ error: 'projectId is required' });
      return;
    }
    if (!repo) {
      res.status(422).json({ error: 'repo is required' });
      return;
    }

    const project = getProjectById(projectId);
    if (!project) {
      res.status(422).json({ error: `Project '${projectId}' not found` });
      return;
    }

    const allowedRepos = getProjectRepos(project);
    try {
      setTaskRepoAssignment(taskId, projectId, repo, 'human', allowedRepos);
    } catch (err) {
      res
        .status(422)
        .json({ error: err instanceof Error ? err.message : 'Invalid repo' });
      return;
    }

    emitTaskUpdated(taskId);

    res.json({ ok: true, repo });
  });

  // ── GET /api/tasks/:taskId/page?projectId=<id> ──────────────────────────────
  // Read-only fetch of the task's full spec body as markdown, uniform across sources.
  router.get('/tasks/:taskId/page', async (req: Request, res: Response) => {
    const taskId = String(req.params.taskId);
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';

    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    let backend: ReturnType<typeof getTaskBackend>;
    try {
      backend = getTaskBackend(projectId);
    } catch {
      res
        .status(400)
        .json({ error: `Cannot resolve backend for project '${projectId}'` });
      return;
    }

    try {
      const markdown = await backend.fetchTaskPage(taskId);
      res.json({ markdown });
    } catch (err) {
      res.status(404).json({
        error: err instanceof Error ? err.message : `task not found: ${taskId}`,
      });
    }
  });

  // ── POST /api/tasks/move-preview ────────────────────────────────────────────
  // Read-only preview for the move confirm UI: runs the same planMove used by
  // TaskWriteCommands.moveTask (via the source milestone's dependency graph) so
  // the operator sees the cascade set or refusal reason before staging a
  // task.move intent through the general staged-intent surface.
  router.post('/tasks/move-preview', async (req: Request, res: Response) => {
    const body = req.body as {
      projectId?: unknown;
      taskId?: unknown;
      sourceMilestoneId?: unknown;
      targetMilestoneId?: unknown;
    };
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const taskId = typeof body.taskId === 'string' ? body.taskId : '';
    const sourceMilestoneId =
      typeof body.sourceMilestoneId === 'string' ? body.sourceMilestoneId : '';
    const targetMilestoneId =
      typeof body.targetMilestoneId === 'string' ? body.targetMilestoneId : '';

    if (!projectId || !taskId || !sourceMilestoneId || !targetMilestoneId) {
      res.status(400).json({
        error:
          'projectId, taskId, sourceMilestoneId and targetMilestoneId are required',
      });
      return;
    }

    const sourceMilestone = getMilestoneById(sourceMilestoneId);
    const targetMilestone = getMilestoneById(targetMilestoneId);
    if (!sourceMilestone || !targetMilestone) {
      res.status(404).json({ error: 'unknown milestone' });
      return;
    }

    let backend: ReturnType<typeof getTaskBackend>;
    try {
      backend = getTaskBackend(projectId);
    } catch {
      res
        .status(400)
        .json({ error: `Cannot resolve backend for project '${projectId}'` });
      return;
    }

    try {
      const sourceGraph = (
        await backend.fetchReadyTasks(sourceMilestone.id, true)
      ).map((r) => ({ id: r.task.id, dependsOn: r.task.dependsOn }));

      const plan = planMove({
        taskId,
        sourceMilestoneTasks: sourceGraph,
        isLaterMove:
          targetMilestone.display_order > sourceMilestone.display_order,
      });

      res.json({
        ok: true,
        isLaterMove:
          targetMilestone.display_order > sourceMilestone.display_order,
        cascadeSet: plan.cascadeSet,
        droppedEdges: plan.droppedEdges,
      });
    } catch (err) {
      if (err instanceof MoveTaskError) {
        res.status(409).json({ ok: false, error: err.message });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to preview move',
      });
    }
  });

  // ── POST /api/tasks/:taskId/recover ─────────────────────────────────────────
  // Generalized recovery endpoint: derives the action from the current pause reason
  // and executes redispatch / rerun / resume accordingly.
  router.post('/tasks/:taskId/recover', async (req: Request, res: Response) => {
    const taskId = String(req.params.taskId);
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : null;

    if (!projectId) {
      res.status(422).json({ error: 'projectId is required' });
      return;
    }

    // Load current task state to read pause reason
    const rows = getActiveTaskAggregates([taskId]);
    const row = rows[0] ?? null;
    const pauseStruct = row
      ? parsePauseReason(
          row.pr_pause_reason ??
            row.session_pr_creation_failed_pause_reason ??
            null,
        )
      : null;

    const descriptor = deriveRecoveryDescriptor(pauseStruct?.reason ?? null);

    if (!descriptor.available || !descriptor.action) {
      res.status(422).json({
        error: 'No recovery action available for this task',
        pauseReason: pauseStruct?.reason ?? null,
      });
      return;
    }

    const action = descriptor.action;

    try {
      if (action === 'redispatch') {
        let backend: Awaited<ReturnType<typeof getTaskBackend>>;
        try {
          backend = getTaskBackend(projectId);
        } catch {
          res.status(422).json({
            error: `Cannot resolve backend for project '${projectId}'`,
          });
          return;
        }

        await executeRedispatch(backend, taskId, sessionManager);
      } else if (action === 'rerun') {
        const prRow = getPRByNotionTaskId(taskId);
        if (!prRow) {
          res.status(422).json({
            error: 'No PR found for this task — cannot rerun pipeline',
          });
          return;
        }

        executeRerunPipeline(
          prRow.pr_number,
          prRow.repo,
          taskId,
          reviewOrchestrator,
        );
      } else if (action === 'resume') {
        const sessionId = row?.code_session_id ?? null;
        if (!sessionId) {
          res.status(422).json({
            error: 'No code session found for this task — cannot resume',
          });
          return;
        }

        // Clear PR-level pause so the task transitions away from needs_attention
        const prRow = getPRByNotionTaskId(taskId);
        if (prRow) {
          clearTerminalPRFlags(prRow.pr_number, prRow.repo, 'human_unpark');
        }

        if (sessionManager) {
          await sessionManager.sendOrResume(
            sessionId,
            'Recovery requested. Please review the current state and continue working on the task.',
          );
        }

        emitTaskUpdated(taskId);
      }
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Recovery action failed',
      });
      return;
    }

    recordEvent({
      event_type: 'task_recovered',
      actor_type: 'human',
      project_id: projectId,
      task_id: taskId,
      payload: { taskId, projectId, action },
    });

    res.json({ ok: true, action });
  });

  // ── PATCH /api/tasks/:id/status ──────────────────────────────────────────
  router.patch('/tasks/:id/status', async (req: Request, res: Response) => {
    const taskId = String(req.params.id);
    const body = req.body as { status?: unknown; projectId?: unknown };
    const status = typeof body.status === 'string' ? body.status : null;
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;

    if (!status) {
      res.status(400).json({ error: 'status is required' });
      return;
    }
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    try {
      await getTaskBackend(projectId).updateStatus(taskId, status, {
        source: 'human',
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to update status',
      });
    }
  });

  return router;
}
