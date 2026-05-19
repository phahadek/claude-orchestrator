import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const routerSource = fs.readFileSync(
  path.join(__dirname, "..", "ws", "router.ts"),
  "utf-8",
);

describe("ws/router.ts — fetch_tasks milestone-based routing", () => {
  it("rejects the legacy { boardId } payload with a clear error", () => {
    expect(routerSource).toMatch(/'boardId' in rawMsg/);
    expect(routerSource).toMatch(/fetch_tasks payload changed/);
  });

  it("resolves the per-project task backend via getTaskBackend(projectId)", () => {
    expect(routerSource).toMatch(/getTaskBackend\(msg\.projectId\)/);
  });

  it("forwards milestoneId (not boardId) to backend.fetchReadyTasks()", () => {
    expect(routerSource).toMatch(/\.fetchReadyTasks\(msg\.milestoneId/);
  });
});
