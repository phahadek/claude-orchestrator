import { Router } from 'express';
import type { Request, Response } from 'express';
import { db } from '../db/db';
import { calculateCost, categoryForSessionType } from '../utils/usage';
import { normalizeBoardId } from '../tasks/taskId';
import { getCachedType } from '../tasks/TaskWriteCommands';

export const analyticsRouter = Router();

// Registered once at module load — better-sqlite3 dedupes by name, so this
// is safe even if the module is imported more than once.
db.function('normalize_board_id', (taskId: string | null) =>
  taskId != null ? normalizeBoardId(taskId) : null,
);

const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Resolves a milestone id to the set of normalized board ids on its board
 * cache, so callers can scope a sessions-table query by milestone even
 * though sessions only carry task_id, not a milestone column. Board cache
 * is keyed on the DB milestone UUID (matching getMergeReadyPRs in
 * db/queries.ts), and its raw_json is the same Notion-task-id shape that
 * write path stores. Returns null when the milestone doesn't exist (or
 * belongs to a different project than the one requested) so callers can
 * distinguish "no filter" from "filter matched nothing".
 */
function resolveMilestoneBoardIds(
  milestoneId: string,
  projectId: string | null,
): string[] | null {
  const milestone = db
    .prepare(`SELECT id, project_id FROM milestones WHERE id = ?`)
    .get(milestoneId) as { id: string; project_id: string } | undefined;
  if (!milestone) return null;
  if (projectId && milestone.project_id !== projectId) return null;

  const boardCache = db
    .prepare(`SELECT raw_json FROM task_cache WHERE task_id = ?`)
    .get(`board:${milestoneId}`) as { raw_json: string } | undefined;
  if (!boardCache) return [];

  try {
    const tasks = JSON.parse(boardCache.raw_json) as { id: string }[];
    return tasks.map((t) => normalizeBoardId(`notion:${t.id}`));
  } catch {
    return [];
  }
}

interface TaskRollupRow {
  boardId: string | null;
  taskId: string | null;
  taskName: string | null;
  taskType: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCost: number;
}

interface SessionTypeRow {
  sessionType: string;
  category: 'planning' | 'execution';
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCost: number;
}

interface TokenAnalyticsResponse {
  range: { from: number; to: number };
  taskRollups: TaskRollupRow[];
  sessionTypeBreakdown: SessionTypeRow[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    totalCost: number;
    sessionCount: number;
  };
}

// GET /api/analytics/tokens
// Query params: projectId (string), from (ms epoch), to (ms epoch) — from/to
// default to a trailing 30-day window when omitted, so every query is
// bounded by a date range in addition to project_id, never an unbounded scan.
analyticsRouter.get('/tokens', (req: Request, res: Response) => {
  const projectId =
    typeof req.query.projectId === 'string' ? req.query.projectId : null;
  const milestoneId =
    typeof req.query.milestoneId === 'string' ? req.query.milestoneId : null;
  const toMs =
    typeof req.query.to === 'string' && !isNaN(parseInt(req.query.to, 10))
      ? parseInt(req.query.to, 10)
      : Date.now();
  const fromMs =
    typeof req.query.from === 'string' && !isNaN(parseInt(req.query.from, 10))
      ? parseInt(req.query.from, 10)
      : toMs - DEFAULT_RANGE_MS;

  const whereClauses = ['started_at >= ?', 'started_at <= ?'];
  const params: (string | number)[] = [fromMs, toMs];
  if (projectId) {
    whereClauses.push('project_id = ?');
    params.push(projectId);
  }
  if (milestoneId) {
    const boardIds = resolveMilestoneBoardIds(milestoneId, projectId);
    if (boardIds === null || boardIds.length === 0) {
      res.json({
        range: { from: fromMs, to: toMs },
        taskRollups: [],
        sessionTypeBreakdown: [],
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          sessionCount: 0,
        },
      });
      return;
    }
    whereClauses.push(
      `normalize_board_id(task_id) IN (${boardIds.map(() => '?').join(', ')})`,
    );
    params.push(...boardIds);
  }
  const whereSql = whereClauses.join(' AND ');

  // Summed in SQL (SUM/COUNT), never a row-level SELECT * fetched into JS
  // before summation. Grouping by (task_id, session_type, model) instead of
  // the caller-facing rollup keys (normalized board id, category) keeps
  // per-row cost pricing — which depends on model — correct before the JS
  // layer folds groups into the two response shapes below.
  const rows = db
    .prepare(
      `
      SELECT
        normalize_board_id(task_id) AS board_id,
        MAX(task_id) AS task_id,
        MAX(task_name) AS task_name,
        session_type,
        model,
        COUNT(*) AS session_count,
        SUM(total_input_tokens) AS input_tokens,
        SUM(total_output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens
      FROM sessions
      WHERE ${whereSql}
      GROUP BY board_id, session_type, model
    `,
    )
    .all(...params) as {
    board_id: string | null;
    task_id: string | null;
    task_name: string | null;
    session_type: string;
    model: string | null;
    session_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  }[];

  const taskRollups = new Map<string, TaskRollupRow>();
  const sessionTypes = new Map<string, SessionTypeRow>();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    sessionCount: 0,
  };

  for (const row of rows) {
    const cost = calculateCost(
      row.input_tokens ?? 0,
      row.output_tokens ?? 0,
      row.model,
      row.cache_read_tokens ?? 0,
      row.cache_creation_tokens ?? 0,
    );

    const rollupKey = row.board_id ?? '(none)';
    const rollup = taskRollups.get(rollupKey) ?? {
      boardId: row.board_id,
      taskId: row.task_id,
      taskName: row.task_name,
      taskType: row.task_id ? getCachedType(row.task_id) : null,
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCost: 0,
    };
    rollup.sessionCount += row.session_count;
    rollup.inputTokens += row.input_tokens ?? 0;
    rollup.outputTokens += row.output_tokens ?? 0;
    rollup.cacheReadTokens += row.cache_read_tokens ?? 0;
    rollup.cacheCreationTokens += row.cache_creation_tokens ?? 0;
    rollup.totalCost += cost;
    taskRollups.set(rollupKey, rollup);

    const category = categoryForSessionType(row.session_type);
    const typeEntry = sessionTypes.get(row.session_type) ?? {
      sessionType: row.session_type,
      category,
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCost: 0,
    };
    typeEntry.sessionCount += row.session_count;
    typeEntry.inputTokens += row.input_tokens ?? 0;
    typeEntry.outputTokens += row.output_tokens ?? 0;
    typeEntry.cacheReadTokens += row.cache_read_tokens ?? 0;
    typeEntry.cacheCreationTokens += row.cache_creation_tokens ?? 0;
    typeEntry.totalCost += cost;
    sessionTypes.set(row.session_type, typeEntry);

    totals.inputTokens += row.input_tokens ?? 0;
    totals.outputTokens += row.output_tokens ?? 0;
    totals.cacheReadTokens += row.cache_read_tokens ?? 0;
    totals.cacheCreationTokens += row.cache_creation_tokens ?? 0;
    totals.totalCost += cost;
    totals.sessionCount += row.session_count;
  }
  totals.totalTokens =
    totals.inputTokens +
    totals.outputTokens +
    totals.cacheReadTokens +
    totals.cacheCreationTokens;

  const result: TokenAnalyticsResponse = {
    range: { from: fromMs, to: toMs },
    taskRollups: Array.from(taskRollups.values()),
    sessionTypeBreakdown: Array.from(sessionTypes.values()),
    totals,
  };
  res.json(result);
});

interface TokenBucketRow {
  bucketStart: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  totalCost: number;
  sessionCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// GET /api/analytics/tokens/timeseries
// Query params: projectId, milestoneId, from, to, granularity ('day' | 'week',
// defaults to 'day'). Buckets are aligned to epoch-ms boundaries (integer
// division in SQL), which happen to be UTC calendar-day boundaries since
// epoch 0 is UTC midnight. Powers the token-consumption-over-time chart —
// bucket totals are summed from raw token counts in SQL, independent of
// cost, so the chart's token axis is never derived from its cost axis.
analyticsRouter.get('/tokens/timeseries', (req: Request, res: Response) => {
  const projectId =
    typeof req.query.projectId === 'string' ? req.query.projectId : null;
  const milestoneId =
    typeof req.query.milestoneId === 'string' ? req.query.milestoneId : null;
  const granularity = req.query.granularity === 'week' ? 'week' : 'day';
  const bucketMs = granularity === 'week' ? WEEK_MS : DAY_MS;
  const toMs =
    typeof req.query.to === 'string' && !isNaN(parseInt(req.query.to, 10))
      ? parseInt(req.query.to, 10)
      : Date.now();
  const fromMs =
    typeof req.query.from === 'string' && !isNaN(parseInt(req.query.from, 10))
      ? parseInt(req.query.from, 10)
      : toMs - DEFAULT_RANGE_MS;

  const whereClauses = ['started_at >= ?', 'started_at <= ?'];
  const params: (string | number)[] = [fromMs, toMs];
  if (projectId) {
    whereClauses.push('project_id = ?');
    params.push(projectId);
  }
  if (milestoneId) {
    const boardIds = resolveMilestoneBoardIds(milestoneId, projectId);
    if (boardIds === null || boardIds.length === 0) {
      res.json({ range: { from: fromMs, to: toMs }, granularity, buckets: [] });
      return;
    }
    whereClauses.push(
      `normalize_board_id(task_id) IN (${boardIds.map(() => '?').join(', ')})`,
    );
    params.push(...boardIds);
  }
  const whereSql = whereClauses.join(' AND ');

  const rows = db
    .prepare(
      `
      SELECT
        (started_at / ?) * ? AS bucket_start,
        model,
        SUM(total_input_tokens) AS input_tokens,
        SUM(total_output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        COUNT(*) AS session_count
      FROM sessions
      WHERE ${whereSql}
      GROUP BY bucket_start, model
      ORDER BY bucket_start ASC
    `,
    )
    .all(bucketMs, bucketMs, ...params) as {
    bucket_start: number;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    session_count: number;
  }[];

  const buckets = new Map<number, TokenBucketRow>();
  for (const row of rows) {
    const cost = calculateCost(
      row.input_tokens ?? 0,
      row.output_tokens ?? 0,
      row.model,
      row.cache_read_tokens ?? 0,
      row.cache_creation_tokens ?? 0,
    );
    const bucket = buckets.get(row.bucket_start) ?? {
      bucketStart: row.bucket_start,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      sessionCount: 0,
    };
    bucket.inputTokens += row.input_tokens ?? 0;
    bucket.outputTokens += row.output_tokens ?? 0;
    bucket.cacheReadTokens += row.cache_read_tokens ?? 0;
    bucket.cacheCreationTokens += row.cache_creation_tokens ?? 0;
    bucket.totalCost += cost;
    bucket.sessionCount += row.session_count;
    bucket.totalTokens =
      bucket.inputTokens +
      bucket.outputTokens +
      bucket.cacheReadTokens +
      bucket.cacheCreationTokens;
    buckets.set(row.bucket_start, bucket);
  }

  res.json({
    range: { from: fromMs, to: toMs },
    granularity,
    buckets: Array.from(buckets.values()).sort(
      (a, b) => a.bucketStart - b.bucketStart,
    ),
  });
});

interface TaskSessionRow {
  sessionId: string;
  taskName: string | null;
  startedAt: number;
  endedAt: number | null;
  sessionType: string;
  category: 'planning' | 'execution';
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCost: number;
}

// GET /api/analytics/tasks/:boardId/sessions
// Session-grain rows for a single task-rollup's drill-in — diagnosing which
// session drove a task's cost. Scoped to one normalized board id (plus the
// same project/date bounds as /tokens), so unlike /tokens this is a bounded,
// on-demand row-level fetch rather than the unbounded scan the SQL-summed
// rollup query above is written to avoid.
analyticsRouter.get(
  '/tasks/:boardId/sessions',
  (req: Request, res: Response) => {
    const boardIdParam = String(req.params.boardId);
    const boardId = boardIdParam === '__none__' ? null : boardIdParam;
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const toMs =
      typeof req.query.to === 'string' && !isNaN(parseInt(req.query.to, 10))
        ? parseInt(req.query.to, 10)
        : Date.now();
    const fromMs =
      typeof req.query.from === 'string' && !isNaN(parseInt(req.query.from, 10))
        ? parseInt(req.query.from, 10)
        : toMs - DEFAULT_RANGE_MS;

    const whereClauses = ['started_at >= ?', 'started_at <= ?'];
    const params: (string | number)[] = [fromMs, toMs];
    if (boardId === null) {
      whereClauses.push('task_id IS NULL');
    } else {
      whereClauses.push('normalize_board_id(task_id) = ?');
      params.push(boardId);
    }
    if (projectId) {
      whereClauses.push('project_id = ?');
      params.push(projectId);
    }
    const whereSql = whereClauses.join(' AND ');

    const rows = db
      .prepare(
        `
      SELECT
        session_id,
        task_name,
        started_at,
        ended_at,
        session_type,
        model,
        total_input_tokens AS input_tokens,
        total_output_tokens AS output_tokens,
        cache_read_tokens,
        cache_creation_tokens
      FROM sessions
      WHERE ${whereSql}
      ORDER BY started_at DESC
    `,
      )
      .all(...params) as {
      session_id: string;
      task_name: string | null;
      started_at: number;
      ended_at: number | null;
      session_type: string;
      model: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }[];

    const sessions: TaskSessionRow[] = rows.map((row) => ({
      sessionId: row.session_id,
      taskName: row.task_name,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      sessionType: row.session_type,
      category: categoryForSessionType(row.session_type),
      model: row.model,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      cacheCreationTokens: row.cache_creation_tokens ?? 0,
      totalCost: calculateCost(
        row.input_tokens ?? 0,
        row.output_tokens ?? 0,
        row.model,
        row.cache_read_tokens ?? 0,
        row.cache_creation_tokens ?? 0,
      ),
    }));

    res.json({ sessions });
  },
);
