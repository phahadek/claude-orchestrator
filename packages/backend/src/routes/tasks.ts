import { Router } from 'express';
import type { Request, Response } from 'express';
import { getProjectById } from '../config';
import { ProjectService } from '../projects/ProjectService';
import {
  getTaskCache,
  getActiveTaskAggregates,
  getLatestNonSystemEventPayload,
  getSetting,
} from '../db/queries';
import type { TaskAggregateRow } from '../db/queries';
import { deriveDisplayStatus } from '../tasks/TaskStatusEngine';
import type { NotionTask } from '../notion/types';
import { DependencyResolver } from '../notion/DependencyResolver';
import type { PRReviewResult } from '../github/PRReviewService';
import type { ServerMessage, TaskView } from '../ws/types';
import type { PauseReason } from '../db/types';
import yaml from 'js-yaml';
export type { TaskView } from '../ws/types';

/**
 * The frontend sends milestone row ids as `boardId` after the milestone schema migration.
 * Resolve to the milestone's `source_id` (the Notion database id) for cache key lookup.
 * Falls back to the input value when no matching milestone exists (back-compat for callers
 * that still pass a raw source_id).
 */
function resolveBoardCacheKey(boardId: string): string {
  const milestone = ProjectService.getMilestone(boardId);
  if (milestone?.sourceId) return milestone.sourceId;
  return boardId;
}

const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

function getReviewIterationCap(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_REVIEW_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_REVIEW_ITERATIONS;
}

// ── Broadcast infrastructure ─────────────────────────────────────────────────
let taskBroadcastFn: ((msg: ServerMessage) => void) | null = null;

export function setTaskBroadcast(fn: (msg: ServerMessage) => void): void {
  taskBroadcastFn = fn;
}

/** Build a TaskView for a single notionTaskId and broadcast it as task_updated. */
export function emitTaskUpdated(notionTaskId: string): void {
  if (!taskBroadcastFn) return;
  const task = buildTaskView(notionTaskId);
  if (task) taskBroadcastFn({ type: 'task_updated', task });
}

/** Build a TaskView for a single notionTaskId from current DB state. Returns null if not found. */
export function buildTaskView(notionTaskId: string): TaskView | null {
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
    let lastMessage = '';
    const eventPayload = getLatestNonSystemEventPayload(row.code_session_id);
    if (eventPayload) lastMessage = summarizeEvent(eventPayload);
    codeSession = {
      sessionId: row.code_session_id,
      status: row.code_session_status ?? '',
      startedAt: row.code_session_started_at ?? 0,
      endedAt: row.code_session_ended_at ?? null,
      lastMessage,
      inputTokens: row.code_session_input_tokens ?? 0,
      outputTokens: row.code_session_output_tokens ?? 0,
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

  const pauseReason = (row.pr_pause_reason ?? null) as PauseReason | null;

  const displayStatus = deriveDisplayStatus({
    notionStatus,
    codeSessionStatus: row.code_session_status ?? null,
    prState: row.pr_state ?? null,
    prDraft: row.pr_draft === 1,
    reviewVerdict,
    reviewIterationCount: row.pr_review_iteration ?? 0,
    reviewIterationCap: cap,
    pauseReason,
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
    taskId: row.notion_task_id,
    taskName: notionTask?.title ?? row.notion_task_id,
    notionStatus,
    displayStatus,
    pauseReason,
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

export function createTasksRouter(): Router {
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

    const cacheKey = `board:${resolveBoardCacheKey(boardId)}`;
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

  // ── GET /api/tasks/active?projectId=<id>&boardId=<id> ────────────────────
  router.get('/tasks/active', (req: Request, res: Response) => {
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
    // boardId arrives as the milestone row id; resolve to the underlying source_id.
    const cacheKey = `board:${resolveBoardCacheKey(boardId)}`;
    const boardCacheRow = getTaskCache(cacheKey);
    let taskIds: string[] = [];

    if (boardCacheRow) {
      try {
        const tasks = JSON.parse(boardCacheRow.raw_json) as NotionTask[];
        taskIds = tasks.map((t) => t.id);
      } catch {
        taskIds = [];
      }
    }

    const aggregates = getActiveTaskAggregates(taskIds);
    const cap = getReviewIterationCap();
    const views: TaskView[] = aggregates
      .map((row) => buildTaskViewFromRow(row, cap))
      .filter((v) => !v.notionStatus.includes('Deferred'));

    // Resolve blocked status from the full board task list
    if (boardCacheRow) {
      try {
        const allBoardTasks = JSON.parse(
          boardCacheRow.raw_json,
        ) as NotionTask[];
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
    }

    res.json(views);
  });

  return router;
}
