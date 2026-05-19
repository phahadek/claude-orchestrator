import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ToolCallGroup } from "../ToolCallGroup";
import { groupSessionEvents } from "../SessionDetail";

// ── Test helpers ──────────────────────────────────────────────────

function makeEvent(eventType: string, content: string, timestamp = 1000) {
  return { eventType, content, timestamp };
}

/** Create a text event wrapping an assistant message with a single tool_use block. */
function makeToolUseTextEvent(
  toolName: string,
  input: Record<string, unknown>,
  timestamp = 1000,
) {
  return makeEvent(
    "text",
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_01", name: toolName, input }],
      },
    }),
    timestamp,
  );
}

function makeToolResultEvent(content: string, timestamp = 1001) {
  return makeEvent(
    "tool_result",
    JSON.stringify({ type: "tool_result", content }),
    timestamp,
  );
}

function makeCallPair(
  toolName: string,
  input: Record<string, unknown>,
  result: string,
) {
  return {
    textEvent: makeToolUseTextEvent(toolName, input),
    resultEvent: makeToolResultEvent(result),
  };
}

// ── ToolCallGroup component tests ─────────────────────────────────

describe("ToolCallGroup", () => {
  it("renders collapsed header with tool name, detail, and count", () => {
    const calls = [
      makeCallPair("Read", { file_path: "/a.ts" }, "content a"),
      makeCallPair("Read", { file_path: "/b.ts" }, "content b"),
      makeCallPair("Read", { file_path: "/c.ts" }, "content c"),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    expect(screen.getByText(/🔧 Read \(a\.ts\) ×3/)).toBeTruthy();
  });

  it("collapsed header shows description for Bash groups", () => {
    const calls = [
      makeCallPair(
        "Bash",
        { command: "npx tsc --noEmit", description: "Run tsc" },
        "output",
      ),
      makeCallPair(
        "Bash",
        { command: "npx tsc --noEmit", description: "Run tsc" },
        "output",
      ),
    ];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    expect(screen.getByText(/🔧 Bash \(Run tsc\) ×2/)).toBeTruthy();
  });

  it("collapsed header shows detail for Read groups", () => {
    const calls = [
      makeCallPair("Read", { file_path: "/src/file.ts" }, "content a"),
      makeCallPair("Read", { file_path: "/src/other.ts" }, "content b"),
      makeCallPair("Read", { file_path: "/src/third.ts" }, "content c"),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    expect(screen.getByText(/🔧 Read \(file\.ts\) ×3/)).toBeTruthy();
  });

  it("collapsed header falls back to bare tool name when no detail available", () => {
    const calls = [
      makeCallPair("Bash", { command: "ls" }, "output1"),
      makeCallPair("Bash", { command: "pwd" }, "output2"),
    ];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    // No description field — falls back to command, which is short enough
    expect(screen.getByText(/🔧 Bash \(ls\) ×2/)).toBeTruthy();
  });

  it("collapsed header shows only bare tool name for unknown tool with no extractable detail", () => {
    const calls = [
      makeCallPair("TodoWrite", { todos: [] }, "ok"),
      makeCallPair("TodoWrite", { todos: [] }, "ok"),
    ];
    render(<ToolCallGroup toolName="TodoWrite" calls={calls} />);
    expect(screen.getByText(/🔧 TodoWrite ×2/)).toBeTruthy();
  });

  it("does not render call details when collapsed", () => {
    const calls = [
      makeCallPair("Read", { file_path: "/a.ts" }, "file content here"),
      makeCallPair("Read", { file_path: "/b.ts" }, "other content"),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    expect(screen.queryByText("file content here")).toBeNull();
    expect(screen.queryByText("other content")).toBeNull();
  });

  it("expands to show individual call items on click", () => {
    const calls = [
      makeCallPair("Read", { file_path: "/a.ts" }, "result a"),
      makeCallPair("Read", { file_path: "/b.ts" }, "result b"),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    const header = screen.getByRole("button", { name: /🔧 Read.*×2/ });
    fireEvent.click(header);
    // After expanding, call item headers with the file paths should appear
    expect(screen.getByText(/\/a\.ts/)).toBeTruthy();
    expect(screen.getByText(/\/b\.ts/)).toBeTruthy();
  });

  it("shows call result when individual call item is expanded", () => {
    const calls = [
      makeCallPair("Read", { file_path: "/a.ts" }, "result content here"),
      makeCallPair("Read", { file_path: "/b.ts" }, "other result"),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    // Expand the group
    fireEvent.click(screen.getByRole("button", { name: /🔧 Read.*×2/ }));
    // Expand the first call item
    const callButtons = screen.getAllByRole("button");
    // Find the one for /a.ts (not the group header)
    const callBtn = callButtons.find((b) => b.textContent?.includes("/a.ts"));
    expect(callBtn).toBeTruthy();
    fireEvent.click(callBtn!);
    expect(screen.getByText(/result content here/)).toBeTruthy();
  });

  it("collapses again when header is clicked a second time", () => {
    const calls = [
      makeCallPair("Read", { file_path: "/x.ts" }, "some result"),
      makeCallPair("Read", { file_path: "/y.ts" }, "other result"),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    const header = screen.getByRole("button", { name: /🔧 Read.*×2/ });
    fireEvent.click(header);
    expect(screen.getByText(/\/x\.ts/)).toBeTruthy();
    fireEvent.click(header);
    expect(screen.queryByText("/x.ts")).toBeNull();
  });

  it("renders Bash command inline in call item label", () => {
    const calls = [
      makeCallPair("Bash", { command: "npm test" }, "test output"),
      makeCallPair("Bash", { command: "npm build" }, "build output"),
    ];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    fireEvent.click(screen.getByRole("button", { name: /🔧 Bash.*×2/ }));
    expect(screen.getByText(/\$ npm test/)).toBeTruthy();
    expect(screen.getByText(/\$ npm build/)).toBeTruthy();
  });

  it("aria-expanded reflects open/closed state", () => {
    const calls = [
      makeCallPair("Read", { file_path: "/a.ts" }, "r"),
      makeCallPair("Read", { file_path: "/b.ts" }, "r"),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    const header = screen.getByRole("button", { name: /🔧 Read.*×2/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });
});

// ── groupSessionEvents tests ──────────────────────────────────────

describe("groupSessionEvents", () => {
  it("returns empty array for empty input", () => {
    expect(groupSessionEvents([])).toEqual([]);
  });

  it("passes non-tool events through unchanged", () => {
    const events = [
      makeEvent("text", "Hello"),
      makeEvent("system", "init"),
      makeEvent("error", "boom"),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.kind === "event")).toBe(true);
  });

  it("3 consecutive Read calls render as a single group", () => {
    const events = [
      makeToolUseTextEvent("Read", { file_path: "/a.ts" }, 1000),
      makeToolResultEvent("content a", 1001),
      makeToolUseTextEvent("Read", { file_path: "/b.ts" }, 1002),
      makeToolResultEvent("content b", 1003),
      makeToolUseTextEvent("Read", { file_path: "/c.ts" }, 1004),
      makeToolResultEvent("content c", 1005),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("group");
    if (items[0].kind === "group") {
      expect(items[0].toolName).toBe("Read");
      expect(items[0].calls).toHaveLength(3);
    }
  });

  it("renders grouped events with detail in the component header", () => {
    const events = [
      makeToolUseTextEvent("Read", { file_path: "/a.ts" }),
      makeToolResultEvent("a"),
      makeToolUseTextEvent("Read", { file_path: "/b.ts" }),
      makeToolResultEvent("b"),
      makeToolUseTextEvent("Read", { file_path: "/c.ts" }),
      makeToolResultEvent("c"),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(1);
    if (items[0].kind === "group") {
      render(
        <ToolCallGroup toolName={items[0].toolName} calls={items[0].calls} />,
      );
      expect(screen.getByText(/🔧 Read \(a\.ts\) ×3/)).toBeTruthy();
    }
  });

  it("single tool call is not grouped — passes through as individual events", () => {
    const events = [
      makeToolUseTextEvent("Read", { file_path: "/a.ts" }),
      makeToolResultEvent("content a"),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "event")).toBe(true);
  });

  it("mixed tool calls (Read, Grep, Read) produce no groups — all individual", () => {
    const events = [
      makeToolUseTextEvent("Read", { file_path: "/a.ts" }, 1000),
      makeToolResultEvent("a", 1001),
      makeToolUseTextEvent("Grep", { pattern: "foo" }, 1002),
      makeToolResultEvent("grep output", 1003),
      makeToolUseTextEvent("Read", { file_path: "/b.ts" }, 1004),
      makeToolResultEvent("b", 1005),
    ];
    const items = groupSessionEvents(events);
    // No groups — each pair is a separate single call
    expect(items.every((i) => i.kind === "event")).toBe(true);
    expect(items).toHaveLength(6);
  });

  it("two separate Read groups are not merged when separated by Grep", () => {
    const events = [
      makeToolUseTextEvent("Read", { file_path: "/a.ts" }, 1000),
      makeToolResultEvent("a", 1001),
      makeToolUseTextEvent("Read", { file_path: "/b.ts" }, 1002),
      makeToolResultEvent("b", 1003),
      makeToolUseTextEvent("Grep", { pattern: "foo" }, 1004),
      makeToolResultEvent("g", 1005),
      makeToolUseTextEvent("Read", { file_path: "/c.ts" }, 1006),
      makeToolResultEvent("c", 1007),
      makeToolUseTextEvent("Read", { file_path: "/d.ts" }, 1008),
      makeToolResultEvent("d", 1009),
    ];
    const items = groupSessionEvents(events);
    // Two Read groups + 2 individual Grep events
    const groups = items.filter((i) => i.kind === "group");
    expect(groups).toHaveLength(2);
    groups.forEach((g) => {
      if (g.kind === "group") expect(g.toolName).toBe("Read");
    });
  });

  it("standalone tool_use events between text and tool_result are skipped in grouping", () => {
    // Sequence: text(Read) + tool_use(standalone) + tool_result
    const events = [
      makeToolUseTextEvent("Read", { file_path: "/a.ts" }, 1000),
      makeEvent(
        "tool_use",
        JSON.stringify({ name: "Read", input: { file_path: "/a.ts" } }),
        1000,
      ),
      makeToolResultEvent("content a", 1001),
      makeToolUseTextEvent("Read", { file_path: "/b.ts" }, 1002),
      makeEvent(
        "tool_use",
        JSON.stringify({ name: "Read", input: { file_path: "/b.ts" } }),
        1002,
      ),
      makeToolResultEvent("content b", 1003),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("group");
    if (items[0].kind === "group") {
      expect(items[0].calls).toHaveLength(2);
    }
  });

  it("non-tool text events are not grouped", () => {
    const events = [
      makeEvent("text", "Hello from Claude"),
      makeEvent("text", "Working on it…"),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "event")).toBe(true);
  });
});
