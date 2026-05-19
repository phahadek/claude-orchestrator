import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── formatTokenCount ──────────────────────────────────────────────────────────

import { formatTokenCount } from "../utils/usage";

describe("formatTokenCount", () => {
  it("formats numbers below 1000 as plain integers", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("formats thousands with k suffix (1 decimal)", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(999_999)).toBe("1000.0k");
  });

  it("formats millions with M suffix (1 decimal)", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(1_234_567)).toBe("1.2M");
  });
});

// ── runMigrations() — token columns ──────────────────────────────────────────

describe("runMigrations() — token columns", () => {
  it("adds total_input_tokens column with try/catch for idempotency", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "db", "schema.ts"),
      "utf-8",
    );
    expect(source).toMatch(
      /ALTER TABLE sessions ADD COLUMN.*total_input_tokens/,
    );
  });

  it("adds total_output_tokens column with try/catch for idempotency", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "db", "schema.ts"),
      "utf-8",
    );
    expect(source).toMatch(
      /ALTER TABLE sessions ADD COLUMN.*total_output_tokens/,
    );
  });

  it("wraps token column additions in try/catch", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "db", "schema.ts"),
      "utf-8",
    );
    const inputMatch = source.match(/try\s*\{[^}]*total_input_tokens[^}]*\}/s);
    const outputMatch = source.match(
      /try\s*\{[^}]*total_output_tokens[^}]*\}/s,
    );
    expect(inputMatch).not.toBeNull();
    expect(outputMatch).not.toBeNull();
  });
});

// ── incrementTokens — SQLite integration ─────────────────────────────────────

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
      task_name           TEXT,
      model               TEXT,
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0
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
      decided_at      INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      timestamp   INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
      head_sha          TEXT
    );
  `);
  return { db };
});

import { insertSession, getSession } from "../db/queries.js";
import { incrementTokens } from "../db/queries.js";

const baseSession = {
  session_id: "token-test-session",
  notion_task_id: null,
  notion_task_url: null,
  project_context_url: null,
  project_id: null,
  status: "running" as const,
  started_at: Date.now(),
};

describe("incrementTokens", () => {
  it("updates token columns in SQLite", () => {
    insertSession(baseSession);
    incrementTokens("token-test-session", 100, 50);
    const row = getSession("token-test-session");
    expect(row?.total_input_tokens).toBe(100);
    expect(row?.total_output_tokens).toBe(50);
  });

  it("accumulates tokens across multiple calls", () => {
    incrementTokens("token-test-session", 200, 100);
    const row = getSession("token-test-session");
    expect(row?.total_input_tokens).toBe(300);
    expect(row?.total_output_tokens).toBe(150);
  });
});
