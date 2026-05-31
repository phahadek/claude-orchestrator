import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── Source checks ─────────────────────────────────────────────────────────────

const queriesSource = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'queries.ts'),
  'utf-8',
);

describe('ProjectPatch — non_milestone_source_config field', () => {
  it('ProjectPatch interface includes non_milestone_source_config', () => {
    expect(queriesSource).toMatch(/non_milestone_source_config\?:\s*string\s*\|\s*null/);
  });

  it('updateProject SET clause includes non_milestone_source_config', () => {
    expect(queriesSource).toContain('non_milestone_source_config = @non_milestone_source_config');
  });

  it('updateProject preserves non_milestone_source_config when absent from patch', () => {
    expect(queriesSource).toMatch(/'non_milestone_source_config' in patch/);
  });
});

// ── In-memory DB round-trip ────────────────────────────────────────────────────

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY, task_id TEXT, task_url TEXT, project_context_url TEXT,
      status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
      pr_url TEXT, worktree_path TEXT, archived INTEGER NOT NULL DEFAULT 0,
      project_id TEXT, session_type TEXT NOT NULL DEFAULT 'standard',
      favorited INTEGER NOT NULL DEFAULT 0, note TEXT, tags TEXT, task_name TEXT,
      model TEXT, total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0, review_result TEXT, metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT NOT NULL, timestamp INTEGER NOT NULL, message_id TEXT
    );
    CREATE TABLE IF NOT EXISTS permission_denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      tool_use_id TEXT NOT NULL, tool_input TEXT NOT NULL, timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      proposed_action TEXT, decision TEXT NOT NULL, rule_matched TEXT, decided_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_index INTEGER NOT NULL, pattern TEXT NOT NULL,
      match_type TEXT NOT NULL, decision TEXT NOT NULL, label TEXT, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pr_number INTEGER NOT NULL,
      pr_url TEXT NOT NULL UNIQUE, task_id TEXT, session_id TEXT, repo TEXT NOT NULL,
      title TEXT, body TEXT, head_branch TEXT, base_branch TEXT,
      state TEXT NOT NULL DEFAULT 'open', draft INTEGER NOT NULL DEFAULT 0,
      review_result TEXT, review_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      synced_at TEXT NOT NULL, review_session_id TEXT, review_iteration INTEGER NOT NULL DEFAULT 0,
      head_sha TEXT, last_reviewed_sha TEXT, node_id TEXT, mergeable INTEGER,
      merge_state TEXT, merge_state_checked_at TEXT, pending_push INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT, failing_checks TEXT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, project_dir TEXT NOT NULL,
      context_url TEXT, github_repo TEXT, task_source TEXT NOT NULL DEFAULT 'notion',
      git_mode TEXT NOT NULL DEFAULT 'github',
      auto_launch_enabled INTEGER NOT NULL DEFAULT 0, auto_launch_milestone_id TEXT,
      auto_merge_enabled INTEGER NOT NULL DEFAULT 0, milestone_branching TEXT,
      non_milestone_source_config TEXT, task_source_config TEXT,
      data_residency_confirmed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      source_id TEXT, display_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, user_agent TEXT, last_ip TEXT,
      last_seen INTEGER, enrolled_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS local_branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
      branch_name TEXT NOT NULL, base_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      review_result TEXT, pause_reason TEXT, merge_commit_sha TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL, actor_id TEXT, project_id TEXT, task_id TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      violation_type TEXT NOT NULL, payload TEXT NOT NULL, recorded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return { db };
});

import {
  insertProject,
  updateProject,
  getProjectRowById,
} from '../db/queries.js';

let seq = 0;
function newId() {
  return `proj-${++seq}`;
}

function create(id: string) {
  return insertProject({
    id,
    name: `P ${id}`,
    project_dir: `/p/${id}`,
    task_source: 'notion',
    context_url: null,
    github_repo: null,
  });
}

describe('updateProject — non_milestone_source_config round-trip', () => {
  it('persists a Notion database id config', () => {
    const id = newId();
    create(id);
    const cfg = JSON.stringify({ notionDatabaseId: 'nm-abc' });
    updateProject(id, { non_milestone_source_config: cfg });
    const row = getProjectRowById(id);
    expect(row!.non_milestone_source_config).toBe(cfg);
    expect((JSON.parse(cfg) as { notionDatabaseId: string }).notionDatabaseId).toBe('nm-abc');
  });

  it('persists a YAML milestone id config', () => {
    const id = newId();
    create(id);
    const cfg = JSON.stringify({ milestoneId: 'backlog' });
    updateProject(id, { non_milestone_source_config: cfg });
    expect(getProjectRowById(id)!.non_milestone_source_config).toBe(cfg);
  });

  it('clears config when patched to null', () => {
    const id = newId();
    create(id);
    updateProject(id, { non_milestone_source_config: '{"notionDatabaseId":"x"}' });
    updateProject(id, { non_milestone_source_config: null });
    expect(getProjectRowById(id)!.non_milestone_source_config).toBeNull();
  });

  it('preserves config when field absent from patch', () => {
    const id = newId();
    create(id);
    const cfg = JSON.stringify({ notionDatabaseId: 'keep-me' });
    updateProject(id, { non_milestone_source_config: cfg });
    updateProject(id, { name: 'Renamed' });
    const row = getProjectRowById(id)!;
    expect(row.non_milestone_source_config).toBe(cfg);
    expect(row.name).toBe('Renamed');
  });

  it('returns undefined for a non-existent project', () => {
    expect(updateProject('no-such-id', { non_milestone_source_config: '{}' })).toBeUndefined();
  });
});
