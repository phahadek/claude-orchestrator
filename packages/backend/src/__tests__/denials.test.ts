import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

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
  deleteDenialsBySession: vi.fn(),
  getDenialsBySession: vi.fn(() => []),
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
  note: null,
  tags: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  setBroadcast(() => {});
});

describe("DELETE /api/sessions/:id/denials", () => {
  it("returns 404 if session not found", async () => {
    vi.mocked(queries.getSession).mockReturnValue(undefined);
    const res = await supertest(buildApp()).delete(
      "/api/sessions/missing/denials",
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Session not found" });
  });

  it("calls deleteDenialsBySession and returns 200", async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const res = await supertest(buildApp()).delete(
      "/api/sessions/test-session-1/denials",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(queries.deleteDenialsBySession).toHaveBeenCalledWith(
      "test-session-1",
    );
  });

  it("subsequent getDenialsBySession returns empty after deletion", async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    vi.mocked(queries.getDenialsBySession).mockReturnValue([]);
    await supertest(buildApp()).delete("/api/sessions/test-session-1/denials");
    expect(queries.getDenialsBySession("test-session-1")).toEqual([]);
  });
});
