import { describe, it, expect, vi } from "vitest";

vi.mock("../db/db.js", async () => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      notion_task_id      TEXT,
      notion_task_url     TEXT,
      project_context_url TEXT,
      status              TEXT    NOT NULL,
      started_at          INTEGER NOT NULL,
      ended_at            INTEGER,
      pr_url              TEXT,
      worktree_path       TEXT,
      archived            INTEGER NOT NULL DEFAULT 0,
      project_id          TEXT,
      session_type        TEXT    NOT NULL DEFAULT 'standard',
      favorited           INTEGER NOT NULL DEFAULT 0,
      note                TEXT,
      tags                TEXT,
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      model               TEXT,
      task_name           TEXT
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message_id   TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      tool_name       TEXT    NOT NULL,
      proposed_action TEXT,
      decision        TEXT    NOT NULL,
      rule_matched    TEXT,
      decided_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_index INTEGER NOT NULL,
      pattern     TEXT    NOT NULL,
      match_type  TEXT    NOT NULL,
      decision    TEXT    NOT NULL,
      label       TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS permission_denials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      tool_name   TEXT    NOT NULL,
      tool_use_id TEXT    NOT NULL,
      tool_input  TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      notion_task_id TEXT    PRIMARY KEY,
      fetched_at     INTEGER NOT NULL,
      raw_json       TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number         INTEGER NOT NULL,
      pr_url            TEXT    NOT NULL UNIQUE,
      notion_task_id    TEXT,
      session_id        TEXT,
      repo              TEXT    NOT NULL,
      title             TEXT,
      body              TEXT,
      head_branch       TEXT,
      base_branch       TEXT,
      state             TEXT    NOT NULL DEFAULT 'open',
      draft             INTEGER NOT NULL DEFAULT 0,
      review_result     TEXT,
      review_at         TEXT,
      created_at        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL,
      synced_at         TEXT    NOT NULL,
      review_session_id TEXT,
      review_iteration  INTEGER NOT NULL DEFAULT 0,
      head_sha          TEXT,
      last_reviewed_sha TEXT,
      pending_push      INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { db };
});

import {
  insertSession,
  insertEventOrIgnore,
  getSession,
  incrementTokens,
} from "../db/queries.js";
import { JsonlReader } from "../session/JsonlReader.js";
import { db } from "../db/db.js";

const reader = new JsonlReader("/nonexistent");

function makeSession(id: string) {
  insertSession({
    session_id: id,
    notion_task_id: null,
    notion_task_url: null,
    project_context_url: null,
    project_id: null,
    status: "done" as const,
    started_at: Date.now(),
  });
}

function addEvent(sessionId: string, payload: Record<string, unknown>) {
  insertEventOrIgnore({
    session_id: sessionId,
    event_type: "system",
    payload: JSON.stringify(payload),
    timestamp: Date.now(),
  });
}

describe("backfillTokens", () => {
  it("populates token columns from result events in session_events", () => {
    makeSession("bf-result-1");
    addEvent("bf-result-1", {
      type: "result",
      usage: { input_tokens: 150, output_tokens: 75 },
    });

    reader.backfillTokens();

    const row = getSession("bf-result-1");
    expect(row?.total_input_tokens).toBe(150);
    expect(row?.total_output_tokens).toBe(75);
  });

  it("falls back to summing usage from all events when no result event exists", () => {
    makeSession("bf-msg-1");
    addEvent("bf-msg-1", { usage: { input_tokens: 100, output_tokens: 50 } });
    addEvent("bf-msg-1", { usage: { input_tokens: 200, output_tokens: 80 } });

    reader.backfillTokens();

    const row = getSession("bf-msg-1");
    expect(row?.total_input_tokens).toBe(300);
    expect(row?.total_output_tokens).toBe(130);
  });

  it("skips sessions with no usage data (genuinely zero-token)", () => {
    makeSession("bf-zero-1");
    addEvent("bf-zero-1", { type: "system", message: "init" });

    reader.backfillTokens();

    const row = getSession("bf-zero-1");
    expect(row?.total_input_tokens).toBe(0);
    expect(row?.total_output_tokens).toBe(0);
  });

  it("skips sessions that already have token counts populated", () => {
    makeSession("bf-skip-1");
    incrementTokens("bf-skip-1", 500, 200);
    addEvent("bf-skip-1", {
      type: "result",
      usage: { input_tokens: 999, output_tokens: 999 },
    });

    reader.backfillTokens();

    const row = getSession("bf-skip-1");
    expect(row?.total_input_tokens).toBe(500);
    expect(row?.total_output_tokens).toBe(200);
  });

  it("caps at 100 sessions per run", () => {
    for (let i = 0; i < 105; i++) {
      const id = `bf-cap-${String(i).padStart(3, "0")}`;
      makeSession(id);
      addEvent(id, {
        type: "result",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }

    reader.backfillTokens();

    const backfilled = (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM sessions WHERE session_id LIKE 'bf-cap-%' AND total_input_tokens > 0`,
        )
        .get() as { cnt: number }
    ).cnt;
    expect(backfilled).toBe(100);
  });
});
