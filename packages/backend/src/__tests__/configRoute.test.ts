import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const projectFixture = {
  id: "proj-1",
  name: "Test Project",
  projectDir: "/test",
  contextUrl: "https://notion.so/ctx",
  boardId: "board-1",
  boards: [{ id: "board-1", name: "Board One" }],
  githubRepo: "owner/repo",
};

vi.mock("../config.js", () => ({
  getAllProjects: vi.fn(() => [projectFixture]),
  getProjectById: vi.fn((id: string) =>
    id === "proj-1" ? projectFixture : undefined,
  ),
  getProjectByGithubRepo: vi.fn(),
}));

import configRouter from "../routes/config.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", configRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/config", () => {
  it("returns the list of projects from ProjectService", async () => {
    const res = await supertest(buildApp()).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([projectFixture]);
  });
});
