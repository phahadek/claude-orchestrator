import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/db.js", async () => {
  const Database = (await import("better-sqlite3")).default;
  const memDb = new Database(":memory:");
  memDb.pragma("foreign_keys = ON");
  const { applyTestSchema } = await import("../helpers/testDbSchema");
  applyTestSchema(memDb);
  return { db: memDb };
});

import { importProjectsFromEnv } from "../../src/projects/projectImport.js";
import { ProjectService } from "../../src/projects/ProjectService.js";
import { db } from "../../src/db/db.js";

beforeEach(() => {
  db.prepare("DELETE FROM milestones").run();
  db.prepare("DELETE FROM projects").run();
});

describe("importProjectsFromEnv()", () => {
  it("returns 0 and does nothing when env is undefined", () => {
    const imported = importProjectsFromEnv(undefined);
    expect(imported).toBe(0);
    expect(ProjectService.list()).toEqual([]);
  });

  it("imports a single project with a single boardId", () => {
    const env = JSON.stringify([
      {
        id: "proj-1",
        name: "Test",
        projectDir: "/p1",
        contextUrl: "https://notion.so/ctx",
        githubRepo: "owner/repo",
        boardId: "board-1",
      },
    ]);
    const imported = importProjectsFromEnv(env);
    expect(imported).toBe(1);

    const project = ProjectService.getById("proj-1");
    expect(project?.name).toBe("Test");
    expect(project?.contextUrl).toBe("https://notion.so/ctx");
    expect(project?.githubRepo).toBe("owner/repo");
    expect(project?.milestones).toHaveLength(1);
    expect(project?.milestones[0].sourceId).toBe("board-1");
    // When only boardId is supplied (no boards array with names), milestone name falls back to source_id
    expect(project?.milestones[0].name).toBe("board-1");
  });

  it("imports milestones from boards[] when present (multiple)", () => {
    const env = JSON.stringify([
      {
        id: "proj-1",
        name: "Test",
        projectDir: "/p1",
        contextUrl: "https://notion.so/ctx",
        boardId: "fallback",
        boards: [
          { id: "b1", name: "M1" },
          { id: "b2", name: "M2" },
        ],
      },
    ]);
    const imported = importProjectsFromEnv(env);
    expect(imported).toBe(1);

    const project = ProjectService.getById("proj-1");
    expect(project?.milestones).toHaveLength(2);
    expect(project?.milestones.map((m) => m.sourceId)).toEqual(["b1", "b2"]);
    expect(project?.milestones.map((m) => m.name)).toEqual(["M1", "M2"]);
  });

  it("does not re-import when DB already has projects (idempotent)", () => {
    ProjectService.create({ id: "existing", name: "X", projectDir: "/x" });
    const env = JSON.stringify([
      { id: "proj-1", name: "New", projectDir: "/n", boardId: "b" },
    ]);
    const imported = importProjectsFromEnv(env);
    expect(imported).toBe(0);
    // No new project added; existing one untouched
    const list = ProjectService.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("existing");
  });

  it("skips entries missing required fields and continues with the rest", () => {
    const env = JSON.stringify([
      { id: "good", name: "G", projectDir: "/g", boardId: "b" },
      { name: "NoId", projectDir: "/x" }, // missing id
      { id: "no-dir", name: "N" }, // missing projectDir
    ]);
    const imported = importProjectsFromEnv(env);
    expect(imported).toBe(1);
    expect(ProjectService.list().map((p) => p.id)).toEqual(["good"]);
  });

  it("handles malformed JSON gracefully (logs error, returns 0)", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const imported = importProjectsFromEnv("{not valid");
    expect(imported).toBe(0);
    expect(ProjectService.list()).toEqual([]);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("imports multiple projects", () => {
    const env = JSON.stringify([
      { id: "p1", name: "P1", projectDir: "/p1", boardId: "b1" },
      { id: "p2", name: "P2", projectDir: "/p2", boardId: "b2" },
    ]);
    const imported = importProjectsFromEnv(env);
    expect(imported).toBe(2);
    expect(ProjectService.list()).toHaveLength(2);
  });
});
