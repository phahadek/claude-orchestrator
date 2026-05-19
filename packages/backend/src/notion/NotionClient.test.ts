import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Stub modules with side effects so NotionClient.ts can be imported without
// a real database connection or environment variables.
vi.mock("../config", () => ({
  config: { notionApiKey: "test", notionDatabaseId: "test", port: 3000 },
}));
vi.mock("../db/queries", () => ({
  upsertTaskCache: vi.fn(),
  getCacheAge: vi.fn(() => null),
  getTaskCache: vi.fn(() => null),
}));

import { parseSection } from "./NotionClient";

const source = fs.readFileSync(
  path.join(__dirname, "NotionClient.ts"),
  "utf-8",
);

describe("NotionClient.fetchReadyTasks() — Notion query filter", () => {
  it("excludes only Deferred tasks (does_not_equal) so Done tasks are included", () => {
    expect(source).toMatch(/does_not_equal.*Deferred|Deferred.*does_not_equal/);
  });

  it("does not restrict to a hard-coded allowlist of statuses (no or-filter with equals)", () => {
    // The old filter used { or: [{ select: { equals: '...' } }, ...] }.
    // The new filter must not have this pattern — it should use does_not_equal instead.
    expect(source).not.toMatch(/select:\s*\{\s*equals:\s*['"]🗂️ Ready['"]/);
    expect(source).not.toMatch(/select:\s*\{\s*equals:\s*['"]✅ Done['"]/);
  });
});

// ─── parseSection unit tests ──────────────────────────────────────────────────

const SAMPLE_MD = `
## Summary

This is the summary.

## Context

Some context here.

## Acceptance Criteria

- Do the thing

### 🤖 Automated tests

- test A
- test B

### 👁️ Manual verification

- check X

## Files / paths affected

- src/foo.ts

## Implementation Notes

Details here.
`.trim();

describe("parseSection()", () => {
  it("captures acceptance criteria including sub-headings", () => {
    const result = parseSection(SAMPLE_MD, "acceptance criteria");
    expect(result).toContain("🤖 Automated tests");
    expect(result).toContain("👁️ Manual verification");
    expect(result).toContain("test A");
    expect(result).toContain("check X");
  });

  it("stops before the next top-level section (Files)", () => {
    const result = parseSection(SAMPLE_MD, "acceptance criteria");
    expect(result).not.toContain("src/foo.ts");
    expect(result).not.toContain("paths affected");
  });

  it("returns only summary content (no regression)", () => {
    const result = parseSection(SAMPLE_MD, "summary");
    expect(result).toBe("This is the summary.");
    expect(result).not.toContain("context");
    expect(result).not.toContain("acceptance");
  });

  it("returns only context content (no regression)", () => {
    const result = parseSection(SAMPLE_MD, "context");
    expect(result).toBe("Some context here.");
    expect(result).not.toContain("acceptance");
  });

  it("returns only files content (no regression)", () => {
    const result = parseSection(SAMPLE_MD, "files");
    expect(result).toContain("src/foo.ts");
    expect(result).not.toContain("Implementation Notes");
  });
});
