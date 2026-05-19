import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer so the engine is tested in full isolation (no SQLite, no FK)
vi.mock("../db/queries", () => ({
  getRules: vi.fn(() => []),
  insertPermissionEvent: vi.fn(),
}));

import { PermissionEngine } from "./PermissionEngine";
import { getRules, insertPermissionEvent } from "../db/queries";
import type { PermissionRule } from "../db/types";

const mockGetRules = getRules as ReturnType<typeof vi.fn>;
const mockInsertPermissionEvent = insertPermissionEvent as ReturnType<
  typeof vi.fn
>;

function makeRule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    id: 1,
    order_index: 1,
    pattern: "Bash *",
    match_type: "glob",
    decision: "allow",
    label: null,
    enabled: 1,
    ...overrides,
  };
}

describe("PermissionEngine", () => {
  let engine: PermissionEngine;

  beforeEach(() => {
    engine = new PermissionEngine();
    vi.clearAllMocks();
    mockGetRules.mockReturnValue([]);
  });

  // ─── Return type ───────────────────────────────────────────────────────────

  it("returns a valid Decision type", () => {
    const decision = engine.evaluate("Read", '{"file_path":"/foo.ts"}');
    expect(["allow", "deny", "escalate"]).toContain(decision);
  });

  // ─── Hard deny ─────────────────────────────────────────────────────────────

  it("hard-denies rm -rf via JSON-wrapped args", () => {
    expect(engine.evaluate("Bash", '{"command":"rm -rf /"}')).toBe("deny");
  });

  it("hard-denies git push --force main", () => {
    expect(
      engine.evaluate("Bash", '{"command":"git push --force origin main"}'),
    ).toBe("deny");
  });

  it("hard-denies git push --force master", () => {
    expect(
      engine.evaluate("Bash", '{"command":"git push --force origin master"}'),
    ).toBe("deny");
  });

  it("hard-denies chmod -R 777", () => {
    expect(engine.evaluate("Bash", '{"command":"chmod -R 777 ."}')).toBe(
      "deny",
    );
  });

  it("hard-denies sudo rm", () => {
    expect(engine.evaluate("Bash", '{"command":"sudo rm -rf /tmp"}')).toBe(
      "deny",
    );
  });

  it("writes to permission_events for hard-deny decisions", () => {
    engine.evaluate("Bash", '{"command":"rm -rf /"}');
    expect(mockInsertPermissionEvent).toHaveBeenCalledOnce();
    const arg = mockInsertPermissionEvent.mock.calls[0][0];
    expect(arg.decision).toBe("auto_deny");
    expect(arg.rule_matched).toBe("hard_deny");
  });

  it("hard-deny takes priority over any user rule", () => {
    mockGetRules.mockReturnValue([
      makeRule({ pattern: "Bash *", decision: "allow" }),
    ]);
    expect(engine.evaluate("Bash", '{"command":"rm -rf /"}')).toBe("deny");
  });

  // ─── Hard allow ────────────────────────────────────────────────────────────

  it("hard-allows file reads", () => {
    expect(engine.evaluate("Read", '{"file_path":"/etc/hosts"}')).toBe("allow");
  });

  it("hard-allows git status", () => {
    expect(engine.evaluate("Bash", '{"command":"git status"}')).toBe("allow");
  });

  it("hard-allows npm run build", () => {
    expect(engine.evaluate("Bash", '{"command":"npm run build"}')).toBe(
      "allow",
    );
  });

  it("does NOT write to permission_events for hard-allow", () => {
    engine.evaluate("Read", '{"file_path":"/foo.ts"}');
    expect(mockInsertPermissionEvent).not.toHaveBeenCalled();
  });

  // ─── User rules ────────────────────────────────────────────────────────────

  it("applies user allow rule and writes to permission_events", () => {
    mockGetRules.mockReturnValue([
      makeRule({ pattern: "Write *", decision: "allow" }),
    ]);
    const decision = engine.evaluate("Write", '{"file_path":"/tmp/out.txt"}');
    expect(decision).toBe("allow");
    expect(mockInsertPermissionEvent).toHaveBeenCalledOnce();
    expect(mockInsertPermissionEvent.mock.calls[0][0].decision).toBe(
      "auto_allow",
    );
  });

  it("applies user deny rule and writes to permission_events", () => {
    mockGetRules.mockReturnValue([
      makeRule({ pattern: "Bash *curl*", decision: "deny" }),
    ]);
    const decision = engine.evaluate(
      "Bash",
      '{"command":"curl https://example.com"}',
    );
    expect(decision).toBe("deny");
    expect(mockInsertPermissionEvent.mock.calls[0][0].decision).toBe(
      "auto_deny",
    );
  });

  it("evaluates rules in order_index order — first match wins", () => {
    // Rule at order_index 1 allows, rule at order_index 2 denies same pattern.
    // getRules() returns them pre-sorted; first match should win.
    mockGetRules.mockReturnValue([
      makeRule({
        id: 1,
        order_index: 1,
        pattern: "Write *",
        decision: "allow",
      }),
      makeRule({ id: 2, order_index: 2, pattern: "Write *", decision: "deny" }),
    ]);
    expect(engine.evaluate("Write", '{"file_path":"/tmp/a"}')).toBe("allow");
  });

  it("skips disabled rules (enabled = 0)", () => {
    mockGetRules.mockReturnValue([
      makeRule({ pattern: "Write *", decision: "deny", enabled: 0 }),
    ]);
    // No matching enabled rule → escalate
    expect(engine.evaluate("Write", '{"file_path":"/tmp/a"}')).toBe("escalate");
  });

  it("uses the label in the audit event when provided", () => {
    mockGetRules.mockReturnValue([
      makeRule({
        pattern: "Write *",
        decision: "allow",
        label: "Allow all writes",
      }),
    ]);
    engine.evaluate("Write", '{"file_path":"/tmp/a"}');
    expect(mockInsertPermissionEvent.mock.calls[0][0].rule_matched).toBe(
      "Allow all writes",
    );
  });

  it("falls back to pattern as rule_matched when label is null", () => {
    mockGetRules.mockReturnValue([
      makeRule({ pattern: "Write *", decision: "allow", label: null }),
    ]);
    engine.evaluate("Write", '{"file_path":"/tmp/a"}');
    expect(mockInsertPermissionEvent.mock.calls[0][0].rule_matched).toBe(
      "Write *",
    );
  });

  // ─── Escalate ──────────────────────────────────────────────────────────────

  it("escalates when no rule matches", () => {
    expect(engine.evaluate("Write", '{"file_path":"/tmp/a"}')).toBe("escalate");
  });

  it("writes escalate decision to permission_events", () => {
    engine.evaluate("Write", '{"file_path":"/tmp/a"}');
    expect(mockInsertPermissionEvent).toHaveBeenCalledOnce();
    expect(mockInsertPermissionEvent.mock.calls[0][0].decision).toBe(
      "escalate",
    );
    expect(mockInsertPermissionEvent.mock.calls[0][0].rule_matched).toBeNull();
  });

  // ─── Regex matching ────────────────────────────────────────────────────────

  it("applies a regex rule correctly", () => {
    mockGetRules.mockReturnValue([
      makeRule({
        pattern: "Bash.*npm install",
        match_type: "regex",
        decision: "deny",
      }),
    ]);
    expect(engine.evaluate("Bash", '{"command":"npm install lodash"}')).toBe(
      "deny",
    );
  });

  it("invalid regex defaults to no-match without throwing", () => {
    mockGetRules.mockReturnValue([
      makeRule({
        pattern: "[invalid regex(",
        match_type: "regex",
        decision: "deny",
      }),
    ]);
    // Should not throw; falls through to escalate
    expect(engine.evaluate("Write", '{"file_path":"/a"}')).toBe("escalate");
  });

  // ─── Statelessness ─────────────────────────────────────────────────────────

  it("is stateless — calls getRules() on every evaluate()", () => {
    mockGetRules.mockReturnValue([]);
    engine.evaluate("Write", '{"file_path":"/a"}');
    engine.evaluate("Write", '{"file_path":"/b"}');
    expect(mockGetRules).toHaveBeenCalledTimes(2);
  });
});
