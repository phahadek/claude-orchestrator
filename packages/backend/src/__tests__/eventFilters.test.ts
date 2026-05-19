import { describe, it, expect } from "vitest";
import { isSystemOnlyUserEvent } from "../utils/eventFilters";

describe("isSystemOnlyUserEvent", () => {
  // ── Non-user events are never filtered ────────────────────────────────────
  it("returns false for non-user event types", () => {
    const payload = JSON.stringify({
      type: "assistant",
      message: { content: [] },
    });
    expect(isSystemOnlyUserEvent(payload)).toBe(false);
  });

  it("returns false for system event type", () => {
    const payload = JSON.stringify({ type: "system", subtype: "init" });
    expect(isSystemOnlyUserEvent(payload)).toBe(false);
  });

  // ── User events with only system-injected content are filtered ─────────────
  it("returns true for user event with only <system-reminder> content (string)", () => {
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: "<system-reminder>Some reminder text here</system-reminder>",
      },
    });
    expect(isSystemOnlyUserEvent(payload)).toBe(true);
  });

  it("returns true for user event with only <system-reminder> content (array)", () => {
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>CLAUDE.md bootstrap content</system-reminder>",
          },
        ],
      },
    });
    expect(isSystemOnlyUserEvent(payload)).toBe(true);
  });

  it("returns true for user event with multiple system-only tag blocks", () => {
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>reminder</system-reminder>\n<local-command-stdout>output</local-command-stdout>",
          },
        ],
      },
    });
    expect(isSystemOnlyUserEvent(payload)).toBe(true);
  });

  it("returns true for user event with whitespace-only content after stripping", () => {
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "  <system-reminder>x</system-reminder>  \n  ",
          },
        ],
      },
    });
    expect(isSystemOnlyUserEvent(payload)).toBe(true);
  });

  // ── User events with real human content are NOT filtered ──────────────────
  it("returns false for user event with real human message text (string)", () => {
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content:
          "Task page: https://notion.so/task\nProject context: https://notion.so/ctx\n\nFetch both Notion pages, then begin the task.",
      },
    });
    expect(isSystemOnlyUserEvent(payload)).toBe(false);
  });

  it("returns false for user event with real human message text (array)", () => {
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Please implement the feature described in the task.",
          },
        ],
      },
    });
    expect(isSystemOnlyUserEvent(payload)).toBe(false);
  });

  it("returns false for mixed user event (system reminder + real message)", () => {
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>reminder</system-reminder>\nActual user question here.",
          },
        ],
      },
    });
    expect(isSystemOnlyUserEvent(payload)).toBe(false);
  });

  it("returns false for user event with real message in separate block alongside system content", () => {
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>reminder</system-reminder>" },
          { type: "text", text: "Looks good, ship it!" },
        ],
      },
    });
    expect(isSystemOnlyUserEvent(payload)).toBe(false);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────
  it("returns false for invalid JSON", () => {
    expect(isSystemOnlyUserEvent("not json")).toBe(false);
  });

  it("returns false for non-object payload", () => {
    expect(isSystemOnlyUserEvent('"just a string"')).toBe(false);
  });

  it("returns true when content is an empty array (no user content at all)", () => {
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: [] },
    });
    // No text blocks → no human-visible content → treat as system-only and filter
    expect(isSystemOnlyUserEvent(payload)).toBe(true);
  });
});
