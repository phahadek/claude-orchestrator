import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import express from "express";
import supertest from "supertest";

// ── AC: schema.ts adds favorited column idempotently ───────────────────────

describe("runMigrations() — favorited column", () => {
  it("adds favorited column with try/catch for idempotency", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "db", "schema.ts"),
      "utf-8",
    );
    expect(source).toMatch(
      /ALTER TABLE sessions ADD COLUMN.*favorited INTEGER NOT NULL DEFAULT 0/,
    );
  });

  it("wraps the favorited ALTER TABLE in try/catch", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "db", "schema.ts"),
      "utf-8",
    );
    const match = source.match(/try\s*\{[^}]*favorited[^}]*\}/s);
    expect(match).not.toBeNull();
  });
});

// ── AC: PATCH /api/sessions/:id/favorite and /unfavorite endpoints ─────────

vi.mock("../db/queries", () => ({
  getSession: vi.fn(),
  getActiveSessions: vi.fn(() => []),
  getArchivedSessions: vi.fn(() => []),
  getSessionsByStatus: vi.fn(() => []),
  getSessionsByProject: vi.fn(() => []),
  deleteSession: vi.fn(),
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  archiveFinishedSessions: vi.fn(() => 0),
  setSessionNote: vi.fn(),
  setSessionTags: vi.fn(),
  favoriteSession: vi.fn(),
  unfavoriteSession: vi.fn(),
}));

import { sessionsRouter, setBroadcast } from "../routes/sessions";
import * as queries from "../db/queries";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sessionsRouter);
  return app;
}

const mockSession = {
  session_id: "test-session-1",
  notion_task_id: null,
  notion_task_url: null,
  project_context_url: null,
  project_id: null,
  status: "done",
  started_at: 1000000,
  ended_at: null,
  pr_url: null,
  worktree_path: null,
  archived: 0,
  favorited: 0,
  note: null,
  tags: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  setBroadcast(() => {});
});

describe("PATCH /api/sessions/:id/favorite", () => {
  it("returns 404 if session not found", async () => {
    vi.mocked(queries.getSession).mockReturnValue(undefined);
    const res = await supertest(buildApp()).patch(
      "/api/sessions/missing/favorite",
    );
    expect(res.status).toBe(404);
  });

  it("sets favorited = 1 and returns 200", async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const res = await supertest(buildApp()).patch(
      "/api/sessions/test-session-1/favorite",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(queries.favoriteSession).toHaveBeenCalledWith("test-session-1");
  });
});

describe("PATCH /api/sessions/:id/unfavorite", () => {
  it("returns 404 if session not found", async () => {
    vi.mocked(queries.getSession).mockReturnValue(undefined);
    const res = await supertest(buildApp()).patch(
      "/api/sessions/missing/unfavorite",
    );
    expect(res.status).toBe(404);
  });

  it("sets favorited = 0 and returns 200", async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const res = await supertest(buildApp()).patch(
      "/api/sessions/test-session-1/unfavorite",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(queries.unfavoriteSession).toHaveBeenCalledWith("test-session-1");
  });
});
