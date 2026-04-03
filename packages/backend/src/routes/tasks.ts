import { Router } from 'express';
import type { Request, Response } from 'express';
import { getProjectById } from '../config';
import { getTaskCache, getActiveTaskAggregates, getLatestNonSystemEventPayload, getSetting } from '../db/queries';
import { deriveDisplayStatus } from '../tasks/TaskStatusEngine';
import type { DisplayStatus } from '../tasks/TaskStatusEngine';
import type { NotionTask } from '../notion/types';
import type { PRReviewResult } from '../github/PRReviewService';

const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

function getReviewIterationCap(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_REVIEW_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REVIEW_ITERATIONS;
}

/** Extract a brief human-readable summary from a raw session event payload (max 120 chars). */
function summarizeEvent(payload: string): string {
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
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
        const text = b.text.trim().replace(/\s+/g, ' ');
        return text.length > 120 ? text.slice(0, 117) + '…' : text;
      }
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        const label = `[${b.name}]`;
        return label.length > 120 ? label.slice(0, 117) + '…' : label;
      }
    }
  }

  if (typeof content === 'string' && content.trim().length > 0) {
    const text = content.trim().replace(/\s+/g, ' ');
    return text.length > 120 ? text.slice(0, 117) + '…' : text;
  }

  // tool_use event: { type: 'tool_use', name: '...', input: {...} }
  if (typeof p.name === 'string') {
    const label = `[${p.name}]`;
    return label.length > 120 ? label.slice(0, 117) + '…' : label;
  }

  return '';
}

export interface TaskView {
  taskId: string;
  taskName: string;
  notionStatus: string;
  displayStatus: DisplayStatus;
  priority: string;
  notionUrl: string;
  codeSession: {
    sessionId: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    lastMessage: string;
    inputTokens: number;
    outputTokens: number;
  } | null;
  pr: {
    prNumber: number;
    prUrl: string;
    title: string;
    headBranch: string;
    baseBranch: string;
    state: string;
    draft: boolean;
  } | null;
  review: {
    sessionId: string;
    status: string;
    verdict: string | null;
    summary: string | null;
    iterationCount: number;
  } | null;
}

export function createTasksRouter(): Router {
  const router = Router();

  // ── GET /api/tasks/active?projectId=<id>&boardId=<id> ────────────────────
  router.get('/tasks/active', (req: Request, res: Response) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
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

    // Read the board cache to get the list of task IDs for this board
    const boardCacheKey = `board:${boardId}`;
    const boardCacheRow = getTaskCache(boardCacheKey);
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

    const views: TaskView[] = aggregates.map((row) => {
      let notionTask: NotionTask | null = null;
      try {
        notionTask = JSON.parse(row.raw_json) as NotionTask;
      } catch {
        notionTask = null;
      }

      const notionStatus = notionTask?.status ?? '';
      const priority = ''; // NotionTask does not carry priority; default to empty

      // Build codeSession
      let codeSession: TaskView['codeSession'] = null;
      if (row.code_session_id) {
        let lastMessage = '';
        const eventPayload = getLatestNonSystemEventPayload(row.code_session_id);
        if (eventPayload) {
          lastMessage = summarizeEvent(eventPayload);
        }
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

      // Build pr
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
        };
      }

      // Build review
      let review: TaskView['review'] = null;
      let reviewVerdict: string | null = null;
      let reviewSummary: string | null = null;
      if (row.review_session_id) {
        if (row.pr_review_result) {
          try {
            const result = JSON.parse(row.pr_review_result) as PRReviewResult;
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
        };
      }

      // Derive display status
      const displayStatus = deriveDisplayStatus({
        notionStatus,
        codeSessionStatus: row.code_session_status ?? null,
        prState: row.pr_state ?? null,
        prDraft: row.pr_draft === 1,
        reviewVerdict,
        reviewIterationCount: row.pr_review_iteration ?? 0,
        reviewIterationCap: cap,
      });

      return {
        taskId: row.notion_task_id,
        taskName: notionTask?.title ?? row.notion_task_id,
        notionStatus,
        displayStatus,
        priority,
        notionUrl: notionTask?.notionUrl ?? '',
        codeSession,
        pr,
        review,
      };
    });

    res.json(views);
  });

  return router;
}
