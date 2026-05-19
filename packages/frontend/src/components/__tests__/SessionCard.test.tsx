import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SessionCard, truncate, CARD_PREVIEW_LINES } from "../SessionCard";
import { StatusBadge } from "../StatusBadge";
import type { SessionState } from "../../hooks/useSessionStore";

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: "test-session",
    taskName: "Test Task",
    notionTaskUrl: "https://notion.so/task",
    status: "running",
    events: [],
    ...overrides,
  };
}

describe("truncate", () => {
  it("returns the original string when it is within maxLen", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends ellipsis when string exceeds maxLen", () => {
    const long = "a".repeat(130);
    const result = truncate(long, 120);
    expect(result).toHaveLength(121); // 120 chars + ellipsis char
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("SessionCard", () => {
  it("renders task name and status badge", () => {
    render(
      <SessionCard
        session={makeSession()}
        selected={false}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("Test Task")).toBeDefined();
    expect(screen.getByText("🔄 Running")).toBeDefined();
  });

  it("truncates last event plain-text content to 120 characters (fallback)", () => {
    const longContent = "x".repeat(130);
    const session = makeSession({
      events: [
        { eventType: "text", content: longContent, timestamp: Date.now() },
      ],
    });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    const preview = screen.getByText(/x+…/);
    expect(preview.textContent?.length).toBe(121); // 120 + ellipsis
  });

  it("shows extracted text for assistant event payload, not raw JSON", () => {
    const payload = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "I have completed the analysis." }],
      },
    };
    const session = makeSession({
      events: [
        {
          eventType: "text",
          content: JSON.stringify(payload),
          timestamp: Date.now(),
        },
      ],
    });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    expect(screen.getByText("I have completed the analysis.")).toBeDefined();
    expect(screen.queryByText(/^\{/)).toBeNull();
  });

  it("shows 🔧 ToolName summary for tool_use event payload", () => {
    const payload = {
      type: "tool_use",
      name: "Read",
      input: { file_path: "/src/main.ts" },
    };
    const session = makeSession({
      events: [
        {
          eventType: "tool_use",
          content: JSON.stringify(payload),
          timestamp: Date.now(),
        },
      ],
    });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    // Tool summary now includes the file detail in parentheses (e.g. "🔧 Read (main.ts)")
    expect(screen.getByText(/🔧 Read\b/)).toBeDefined();
  });

  it("falls back to raw content when last event content is not parseable JSON", () => {
    const session = makeSession({
      events: [
        {
          eventType: "tool_use",
          content: "not valid json",
          timestamp: Date.now(),
        },
      ],
    });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    expect(screen.getByText("not valid json")).toBeDefined();
  });

  it("renders attention indicator for needs_permission sessions", () => {
    const session = makeSession({ status: "needs_permission" });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    expect(screen.getByText(/needs permission/i)).toBeDefined();
  });

  it("does not render attention indicator for non-needs_permission sessions", () => {
    render(
      <SessionCard
        session={makeSession({ status: "running" })}
        selected={false}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/needs permission/i)).toBeNull();
  });

  it("renders PR link when prUrl is set (terminal session)", () => {
    const session = makeSession({
      status: "done",
      prUrl: "https://github.com/pr/42",
    });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    const link = screen.getByText("PR ↗");
    expect(link).toBeDefined();
    expect((link as HTMLAnchorElement).href).toBe("https://github.com/pr/42");
  });

  it("does not render PR link when prUrl is not set", () => {
    render(
      <SessionCard
        session={makeSession({ status: "running" })}
        selected={false}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText("PR ↗")).toBeNull();
  });

  it("calls onClick when card is clicked", () => {
    const onClick = vi.fn();
    render(
      <SessionCard
        session={makeSession()}
        selected={false}
        onClick={onClick}
      />,
    );
    fireEvent.click(screen.getByText("Test Task"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not render last-event section when events list is empty", () => {
    render(
      <SessionCard
        session={makeSession({ events: [] })}
        selected={false}
        onClick={vi.fn()}
      />,
    );
    // No text from an event content — just task name, badge, elapsed
    expect(screen.queryByText(/^x/)).toBeNull();
  });

  it("shows up to CARD_PREVIEW_LINES event summaries in the preview", () => {
    const events = Array.from({ length: CARD_PREVIEW_LINES + 2 }, (_, i) => ({
      eventType: "text",
      content: `event-${i}`,
      timestamp: Date.now() + i,
    }));
    const session = makeSession({ events });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    // Only the last CARD_PREVIEW_LINES events should be visible
    for (let i = events.length - CARD_PREVIEW_LINES; i < events.length; i++) {
      expect(screen.getByText(`event-${i}`)).toBeDefined();
    }
    // Earlier events should not appear
    expect(screen.queryByText("event-0")).toBeNull();
  });

  it("shows all events when session has fewer events than CARD_PREVIEW_LINES", () => {
    const count = CARD_PREVIEW_LINES - 1;
    const events = Array.from({ length: count }, (_, i) => ({
      eventType: "text",
      content: `evt-${i}`,
      timestamp: Date.now() + i,
    }));
    const session = makeSession({ events });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    for (let i = 0; i < count; i++) {
      expect(screen.getByText(`evt-${i}`)).toBeDefined();
    }
  });

  it("shows total duration for done session using started_at/ended_at", () => {
    const started_at = Date.now() - 125_000; // 2m 5s ago
    const ended_at = Date.now() - 5_000; // ended 5s ago → 2m 0s duration
    const session = makeSession({ status: "done", started_at, ended_at });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    expect(screen.getByText("2m 0s")).toBeDefined();
  });

  it("uses started_at for running session rather than event timestamp", () => {
    // All events arrive with the same timestamp (simulating a sync burst)
    const burstTs = Date.now() - 1;
    const started_at = Date.now() - 61_000; // session started 61s ago
    const session = makeSession({
      status: "running",
      started_at,
      events: [
        { eventType: "text", content: "a", timestamp: burstTs },
        { eventType: "text", content: "b", timestamp: burstTs },
      ],
    });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    // Should show ~61s from started_at, not < 1s from event timestamps
    expect(screen.getByText(/1m \d+s/)).toBeDefined();
  });

  it("shows — when no started_at and no events", () => {
    const session = makeSession({
      status: "running",
      started_at: undefined,
      events: [],
    });
    render(
      <SessionCard session={session} selected={false} onClick={vi.fn()} />,
    );
    expect(screen.getByText("—")).toBeDefined();
  });

  it("shows Resume button on rate-limited session when onResume is provided", () => {
    const session = makeSession({ status: "running", isRateLimited: true });
    render(
      <SessionCard
        session={session}
        selected={false}
        onClick={vi.fn()}
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByText("Resume")).toBeDefined();
  });

  it("does not show Resume button on non-rate-limited running session", () => {
    const session = makeSession({ status: "running", isRateLimited: false });
    render(
      <SessionCard
        session={session}
        selected={false}
        onClick={vi.fn()}
        onResume={vi.fn()}
      />,
    );
    expect(screen.queryByText("Resume")).toBeNull();
  });

  it("does not show Resume button on done session", () => {
    const session = makeSession({ status: "done", isRateLimited: false });
    render(
      <SessionCard
        session={session}
        selected={false}
        onClick={vi.fn()}
        onResume={vi.fn()}
      />,
    );
    expect(screen.queryByText("Resume")).toBeNull();
  });

  it("calls onResume when Resume button is clicked and does not bubble to onClick", () => {
    const onResume = vi.fn();
    const onClick = vi.fn();
    const session = makeSession({ status: "running", isRateLimited: true });
    render(
      <SessionCard
        session={session}
        selected={false}
        onClick={onClick}
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByText("Resume"));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("renders ☆ star button when onToggleFavorite is provided", () => {
    render(
      <SessionCard
        session={makeSession()}
        selected={false}
        onClick={vi.fn()}
        onToggleFavorite={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Favorite session")).toBeDefined();
    expect(screen.getByText("☆")).toBeDefined();
  });

  it("renders ★ when session is favorited", () => {
    render(
      <SessionCard
        session={makeSession({ favorited: true })}
        selected={false}
        onClick={vi.fn()}
        onToggleFavorite={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Unfavorite session")).toBeDefined();
    expect(screen.getByText("★")).toBeDefined();
  });

  it("calls onToggleFavorite and does not bubble to onClick when star is clicked", () => {
    const onToggleFavorite = vi.fn();
    const onClick = vi.fn();
    render(
      <SessionCard
        session={makeSession()}
        selected={false}
        onClick={onClick}
        onToggleFavorite={onToggleFavorite}
      />,
    );
    fireEvent.click(screen.getByLabelText("Favorite session"));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not render star button when onToggleFavorite is not provided", () => {
    render(
      <SessionCard
        session={makeSession()}
        selected={false}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Favorite session")).toBeNull();
  });
});

// ── StatusBadge — review sessionType ─────────────────────────────────────────
describe("StatusBadge", () => {
  it("renders 🔍 Review badge when sessionType is review", () => {
    render(<StatusBadge status="running" sessionType="review" />);
    expect(screen.getByText("🔍 Review")).toBeDefined();
  });

  it("renders normal status badge when sessionType is not review", () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText("🔄 Running")).toBeDefined();
    expect(screen.queryByText("🔍 Review")).toBeNull();
  });

  it("renders 🔍 Review badge for a done review session", () => {
    render(<StatusBadge status="done" sessionType="review" />);
    expect(screen.getByText("🔍 Review")).toBeDefined();
  });
});
