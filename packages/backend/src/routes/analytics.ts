import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../db/db";
import { calculateCost } from "../utils/usage";
import type { Session } from "../db/types";

export const analyticsRouter = Router();

export interface TokenAnalyticsSession {
  sessionId: string;
  taskName: string | null;
  startedAt: number;
  endedAt: number | null;
  sessionType: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

export interface TokenAnalyticsResponse {
  sessions: TokenAnalyticsSession[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCost: number;
    sessionCount: number;
  };
}

// GET /api/analytics/tokens
// Query params: projectId (string), from (ms epoch), to (ms epoch)
analyticsRouter.get("/tokens", (req: Request, res: Response) => {
  const projectId =
    typeof req.query.projectId === "string" ? req.query.projectId : null;
  const fromMs =
    typeof req.query.from === "string" ? parseInt(req.query.from, 10) : null;
  const toMs =
    typeof req.query.to === "string" ? parseInt(req.query.to, 10) : null;

  let query = `SELECT * FROM sessions WHERE 1=1`;
  const params: (string | number)[] = [];

  if (projectId) {
    query += ` AND project_id = ?`;
    params.push(projectId);
  }
  if (fromMs != null && !isNaN(fromMs)) {
    query += ` AND started_at >= ?`;
    params.push(fromMs);
  }
  if (toMs != null && !isNaN(toMs)) {
    query += ` AND started_at <= ?`;
    params.push(toMs);
  }

  query += ` ORDER BY started_at DESC`;

  const rows = db.prepare(query).all(...params) as Session[];

  const sessions: TokenAnalyticsSession[] = rows.map((row) => ({
    sessionId: row.session_id,
    taskName: row.task_name ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    sessionType: row.session_type ?? "standard",
    model: row.model ?? null,
    inputTokens: row.total_input_tokens ?? 0,
    outputTokens: row.total_output_tokens ?? 0,
    totalTokens: (row.total_input_tokens ?? 0) + (row.total_output_tokens ?? 0),
    cost: calculateCost(
      row.total_input_tokens ?? 0,
      row.total_output_tokens ?? 0,
      row.model,
    ),
  }));

  const totals = sessions.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + s.inputTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
      totalTokens: acc.totalTokens + s.totalTokens,
      totalCost: acc.totalCost + s.cost,
      sessionCount: acc.sessionCount + 1,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      sessionCount: 0,
    },
  );

  const result: TokenAnalyticsResponse = { sessions, totals };
  res.json(result);
});
