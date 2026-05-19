// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { UserConfig } from "vite";
import viteConfig from "../../vite.config";

describe("vite.config", () => {
  it("ignores .claude/worktrees so worktree cleanup does not trigger HMR", () => {
    const config = viteConfig as UserConfig;
    const ignored = config.server?.watch?.ignored;
    const patterns = Array.isArray(ignored)
      ? ignored
      : ignored
        ? [ignored]
        : [];
    expect(patterns).toContain("**/.claude/worktrees/**");
  });
});
