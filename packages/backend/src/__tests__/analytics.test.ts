import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// ── mock the db module with an in-memory SQLite instance ────────────────────
vi.mock("../db/db.js", async () => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      session_id          TEXT    PRIMARY KEY,
      notion_task_id      TEXT,
      notion_task_url     TEXT,
      project_context_url TEXT,
      project_id          TEXT,
      status              TEXT    NOT NULL,
      started_at          INTEGER NOT NULL,
      ended_at            INTEGER,
      pr_url              TEXT,
      worktree_path       TEXT,
      archived            INTEGER NOT NULL DEFAULT 0,
      favorited           INTEGER NOT NULL DEFAULT 0,
      session_type        TEXT    NOT NULL DEFAULT 'standard',
      note                TEXT,
      tags                TEXT,
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      model               TEXT,
      task_name           TEXT
    );
  `);

  // Fixture data
  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name)
    VALUES (?, ?, 'done', ?, 'standard', ?, ?, ?, ?)
  `,
  ).run("s1", "proj-a", 1_000_000, 1000, 500, "claude-sonnet-4-6", "Task A");

  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name)
    VALUES (?, ?, 'done', ?, 'standard', ?, ?, ?, ?)
  `,
  ).run("s2", "proj-a", 2_000_000, 500, 200, "claude-haiku-4-5", "Task B");

  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name)
    VALUES (?, ?, 'done', ?, 'standard', ?, ?, ?, ?)
  `,
  ).run("s3", "proj-b", 1_500_000, 300, 150, "claude-opus-4-6", "Task C");

  // Zero-token session
  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, status, started_at, session_type, total_input_tokens, total_output_tokens, task_name)
    VALUES (?, ?, 'done', ?, 'standard', 0, 0, ?)
  `,
  ).run("s4", "proj-a", 3_000_000, "Zero-token task");

  // Archived session — must still appear in analytics (analytics is historical)
  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name, archived)
    VALUES (?, ?, 'done', ?, 'standard', ?, ?, ?, ?, 1)
  `,
  ).run(
    "s5",
    "proj-a",
    4_000_000,
    800,
    400,
    "claude-sonnet-4-6",
    "Archived task",
  );

  return { db };
});

import { analyticsRouter } from "../routes/analytics.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/analytics", analyticsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/analytics/tokens", () => {
  it("returns all sessions (including archived) with correct aggregation", async () => {
    const res = await supertest(buildApp()).get("/api/analytics/tokens");
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(5);
    expect(res.body.totals.sessionCount).toBe(5);
    expect(res.body.totals.inputTokens).toBe(1000 + 500 + 300 + 0 + 800);
    expect(res.body.totals.outputTokens).toBe(500 + 200 + 150 + 0 + 400);
    expect(res.body.totals.totalTokens).toBe(1500 + 700 + 450 + 0 + 1200);
    expect(typeof res.body.totals.totalCost).toBe("number");
  });

  it("includes archived sessions in the response", async () => {
    const res = await supertest(buildApp()).get("/api/analytics/tokens");
    expect(res.status).toBe(200);
    const ids = res.body.sessions.map(
      (s: { sessionId: string }) => s.sessionId,
    );
    expect(ids).toContain("s5");
    const archived = res.body.sessions.find(
      (s: { sessionId: string }) => s.sessionId === "s5",
    );
    expect(archived).toBeDefined();
    expect(archived.inputTokens).toBe(800);
    expect(archived.outputTokens).toBe(400);
    expect(archived.totalTokens).toBe(1200);
  });

  it("filters by projectId correctly (archived included)", async () => {
    const res = await supertest(buildApp()).get(
      "/api/analytics/tokens?projectId=proj-a",
    );
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(4);
    for (const s of res.body.sessions) {
      // All sessions should be from proj-a (proj-b sessions excluded)
      expect(["s1", "s2", "s4", "s5"]).toContain(s.sessionId);
    }
    expect(res.body.totals.inputTokens).toBe(1000 + 500 + 0 + 800);
    expect(res.body.totals.outputTokens).toBe(500 + 200 + 0 + 400);
  });

  it("filters by date range", async () => {
    const res = await supertest(buildApp()).get(
      "/api/analytics/tokens?from=1500000&to=2500000",
    );
    expect(res.status).toBe(200);
    const ids = res.body.sessions.map(
      (s: { sessionId: string }) => s.sessionId,
    );
    expect(ids).toContain("s2");
    expect(ids).not.toContain("s1");
    expect(ids).not.toContain("s4");
  });

  it("returns cost field for each session", async () => {
    const res = await supertest(buildApp()).get(
      "/api/analytics/tokens?projectId=proj-a",
    );
    expect(res.status).toBe(200);
    for (const s of res.body.sessions) {
      expect(typeof s.cost).toBe("number");
      expect(s.cost).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns zero cost for zero-token sessions without errors", async () => {
    const res = await supertest(buildApp()).get(
      "/api/analytics/tokens?projectId=proj-a",
    );
    const zeroSession = res.body.sessions.find(
      (s: { sessionId: string }) => s.sessionId === "s4",
    );
    expect(zeroSession).toBeDefined();
    expect(zeroSession.totalTokens).toBe(0);
    expect(zeroSession.cost).toBe(0);
  });
});
