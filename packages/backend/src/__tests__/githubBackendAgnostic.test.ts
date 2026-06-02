/**
 * Tests for GitHub backend agnosticism.
 *
 * AC coverage:
 * - deriveTaskId correctly formats github: task IDs from issue URLs
 * - ContextBuilder reads PROJECT.md for github backend; no-op otherwise
 * - buildOrchestratorClaudeMd uses "GitHub Issue" label and github lifecycle
 * - No instanceof NotionTaskBackend references outside the factory (static guard)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── deriveTaskId ──────────────────────────────────────────────────────────────

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY, task_id TEXT, task_url TEXT,
      project_context_url TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, pr_url TEXT, worktree_path TEXT,
      archived INTEGER NOT NULL DEFAULT 0, project_id TEXT,
      session_type TEXT NOT NULL DEFAULT 'standard',
      favorited INTEGER NOT NULL DEFAULT 0, note TEXT, tags TEXT,
      task_name TEXT, model TEXT,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      metadata TEXT, review_result TEXT
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pr_number INTEGER NOT NULL,
      pr_url TEXT NOT NULL UNIQUE, task_id TEXT, session_id TEXT,
      repo TEXT NOT NULL, title TEXT, body TEXT, head_branch TEXT, base_branch TEXT,
      state TEXT NOT NULL DEFAULT 'open', draft INTEGER NOT NULL DEFAULT 0,
      review_result TEXT, review_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT NOT NULL,
      review_session_id TEXT, review_iteration INTEGER NOT NULL DEFAULT 0,
      head_sha TEXT, last_reviewed_sha TEXT, node_id TEXT,
      mergeable INTEGER, merge_state TEXT, merge_state_checked_at TEXT,
      pending_push INTEGER NOT NULL DEFAULT 0, pause_reason TEXT, failing_checks TEXT
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      source_id TEXT, display_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, project_dir TEXT NOT NULL,
      context_url TEXT, github_repo TEXT,
      task_source TEXT NOT NULL DEFAULT 'notion',
      auto_launch_enabled INTEGER NOT NULL DEFAULT 0,
      auto_launch_milestone_id TEXT,
      auto_merge_enabled INTEGER NOT NULL DEFAULT 0,
      git_mode TEXT NOT NULL DEFAULT 'github',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, proposed_action TEXT, decision TEXT NOT NULL,
      rule_matched TEXT, decided_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_index INTEGER NOT NULL,
      pattern TEXT NOT NULL, match_type TEXT NOT NULL, decision TEXT NOT NULL,
      label TEXT, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS permission_denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, tool_use_id TEXT NOT NULL,
      tool_input TEXT NOT NULL, timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT NOT NULL,
      timestamp INTEGER NOT NULL, message_id TEXT
    );
    CREATE TABLE IF NOT EXISTS local_branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, branch_name TEXT NOT NULL,
      base_branch TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT,
      task_id TEXT, state TEXT NOT NULL DEFAULT 'open',
      review_result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL, actor_id TEXT, project_id TEXT,
      task_id TEXT, payload TEXT, timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT, user_agent TEXT, last_ip TEXT,
      last_seen INTEGER, enrolled_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { db };
});

import { deriveTaskId } from '../session/SessionManager.js';

describe('deriveTaskId — github source', () => {
  it('extracts issue number from a standard GitHub issue URL', () => {
    const id = deriveTaskId(
      'github',
      'https://github.com/owner/repo/issues/123',
    );
    expect(id).toBe('github:123');
  });

  it('extracts issue number from a single-digit issue URL', () => {
    expect(
      deriveTaskId('github', 'https://github.com/owner/repo/issues/1'),
    ).toBe('github:1');
  });

  it('falls back to raw URL under github: prefix when no /issues/<N> pattern', () => {
    const url = 'https://github.com/owner/repo';
    const id = deriveTaskId('github', url);
    expect(id).toBe(`github:${url}`);
  });
});

describe('deriveTaskId — notion source', () => {
  it('produces notion: prefix with dashed UUID from a Notion URL', () => {
    const id = deriveTaskId(
      'notion',
      'https://www.notion.so/Audit-36d22f9152f381c8b824c4d21f9a8100',
    );
    expect(id).toMatch(/^notion:[0-9a-f-]{36}$/);
    expect(id).toContain('36d22f91');
  });

  it('unknown source falls back to notion: parsing', () => {
    const id = deriveTaskId(
      'yaml',
      'https://www.notion.so/task-36d22f9152f381c8b824c4d21f9a8100',
    );
    expect(id).toMatch(/^notion:/);
  });
});

// ── ContextBuilder — PROJECT.md fallback ─────────────────────────────────────

import { buildSessionContext } from '../session/ContextBuilder.js';

const baseContextParams = {
  taskName: 'test-task',
  taskUrl: 'https://github.com/owner/repo/issues/1',
  projectContextUrl: 'https://github.com/owner/repo',
  targetBranch: 'dev',
  worktreePath: '/worktrees/abc',
};

describe('buildSessionContext — PROJECT.md fallback for github backend', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-builder-test-'));
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes PROJECT.md content when taskBackend=github and file exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'PROJECT.md'),
      '# My Project\nThis is the project context.',
      'utf-8',
    );
    const output = buildSessionContext({
      ...baseContextParams,
      projectDir: tmpDir,
      taskBackend: 'github',
    });
    expect(output).toContain('My Project');
    expect(output).toContain('This is the project context.');
  });

  it('no-op when taskBackend=github but PROJECT.md is absent', () => {
    const output = buildSessionContext({
      ...baseContextParams,
      projectDir: tmpDir,
      taskBackend: 'github',
    });
    // Output is valid (no error thrown) but doesn't contain PROJECT.md marker
    expect(output).toBeTruthy();
    expect(output).not.toContain('PROJECT.md');
  });

  it('does not read PROJECT.md for notion backend even if file exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'PROJECT.md'),
      '# Secret Notion Project Context',
      'utf-8',
    );
    const output = buildSessionContext({
      ...baseContextParams,
      taskUrl: 'https://www.notion.so/task-36d22f9152f381c8b824c4d21f9a8100',
      projectDir: tmpDir,
      taskBackend: 'notion',
    });
    expect(output).not.toContain('Secret Notion Project Context');
  });
});

// ── orchestrator-claudemd — github backend label and lifecycle ────────────────

import { buildOrchestratorClaudeMd } from '../session/orchestrator-claudemd.js';

const baseOrchestratorParams = {
  taskName: 'my-github-task',
  taskUrl: 'https://github.com/owner/repo/issues/42',
  projectContextUrl: 'https://github.com/owner/repo',
  targetBranch: 'dev',
  worktreePath: '/worktrees/xyz',
};

describe('buildOrchestratorClaudeMd — github backend', () => {
  it('uses "GitHub Issue" label in task assignment section', () => {
    const output = buildOrchestratorClaudeMd({
      ...baseOrchestratorParams,
      taskBackend: 'github',
    });
    expect(output).toContain('**GitHub Issue**');
    expect(output).not.toContain('**Notion task**');
  });

  it('uses "Notion task" label when taskBackend is notion (default)', () => {
    const output = buildOrchestratorClaudeMd({
      ...baseOrchestratorParams,
      taskUrl: 'https://notion.so/task-36d22f9152f381c8b824c4d21f9a8100',
      taskBackend: 'notion',
    });
    expect(output).toContain('**Notion task**');
  });

  it('lifecycle for github backend mentions skipping Notion fetch', () => {
    const output = buildOrchestratorClaudeMd({
      ...baseOrchestratorParams,
      taskBackend: 'github',
    });
    expect(output).toMatch(/GitHub task source|skip.*Notion/i);
  });

  it('appends projectContextContent when provided', () => {
    const output = buildOrchestratorClaudeMd({
      ...baseOrchestratorParams,
      taskBackend: 'github',
      projectContextContent: '# Repo Overview\nThis repo does X.',
    });
    expect(output).toContain('Repo Overview');
    expect(output).toContain('This repo does X.');
  });

  it('does not append projectContextContent section when omitted', () => {
    const output = buildOrchestratorClaudeMd({
      ...baseOrchestratorParams,
      taskBackend: 'github',
    });
    expect(output).not.toContain('Repo Overview');
  });
});

// ── No instanceof NotionTaskBackend outside the factory (static guard) ────────

describe('instanceof NotionTaskBackend — outside-factory static guard', () => {
  it('SessionManager.ts has no instanceof NotionTaskBackend', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/instanceof\s+NotionTaskBackend/);
  });

  it('PRReviewService.ts has no instanceof NotionTaskBackend', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'github', 'PRReviewService.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/instanceof\s+NotionTaskBackend/);
  });

  it('AutoLauncher.ts has no instanceof NotionTaskBackend', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'orchestration', 'AutoLauncher.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/instanceof\s+NotionTaskBackend/);
  });

  it('NoOpInvestigator.ts has no instanceof NotionTaskBackend', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'github', 'NoOpInvestigator.ts'),
      'utf-8',
    );
    expect(src).not.toMatch(/instanceof\s+NotionTaskBackend/);
  });
});
