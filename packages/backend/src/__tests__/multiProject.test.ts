import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── AC: SessionManager.start() throws if projectId is not found ─────────────

describe('SessionManager.start() — projectId validation', () => {
  it('source throws when projectId is not found in PROJECTS', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    // Must call getProjectById(projectId)
    expect(source).toMatch(/getProjectById\(projectId\)/);
    // Must throw if project not found
    expect(source).toMatch(/throw new Error.*Project not found/);
  });

  it('passes projectId to insertSession as project_id', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(source).toMatch(/project_id:\s*projectId/);
  });

  it('resolves projectDir from project config rather than global config.projectDir', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    // Must use project.projectDir, not config.projectDir for worktree creation
    expect(source).toMatch(/project\.projectDir/);
    // Must import getProjectById
    expect(source).toMatch(/import.*getProjectById.*from.*config/);
  });
});

// ── AC: getSessionsByProject() filters by project_id ───────────────────────

describe('getSessionsByProject()', () => {
  it('source queries sessions WHERE project_id = ?', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'queries.ts'),
      'utf-8',
    );
    expect(source).toContain('getSessionsByProject');
    expect(source).toMatch(/WHERE project_id = \?/);
  });

  it('INSERT statements include project_id column', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'queries.ts'),
      'utf-8',
    );
    // Both INSERT statements should include project_id
    const insertMatches = source.match(/INSERT.*INTO sessions[\s\S]*?VALUES/g) ?? [];
    expect(insertMatches.length).toBeGreaterThanOrEqual(1);
    for (const match of insertMatches) {
      expect(match).toContain('project_id');
    }
  });
});

// ── AC: schema.ts runMigrations() adds project_id column idempotently ───────

describe('schema.ts runMigrations()', () => {
  it('adds project_id column via idempotent try/catch ALTER TABLE', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    // Must contain the idempotent migration
    expect(source).toMatch(/ALTER TABLE sessions ADD COLUMN project_id TEXT/);
    // Must be wrapped in try/catch (idempotent)
    const idx = source.indexOf('ALTER TABLE sessions ADD COLUMN project_id TEXT');
    const before = source.slice(Math.max(0, idx - 60), idx);
    expect(before).toContain('try');
  });
});

// ── AC: NotionClient.fetchReadyTasks() accepts boardId parameter ─────────────

describe('NotionClient.fetchReadyTasks()', () => {
  it('accepts a boardId parameter and uses it for the database query', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'notion', 'NotionClient.ts'),
      'utf-8',
    );
    // Method signature must accept boardId as the first parameter
    expect(source).toMatch(/fetchReadyTasks\(boardId:\s*string/);
    // Must use boardId in the API call (not a hardcoded value)
    expect(source).toMatch(/\/databases\/\$\{boardId\}\/query/);
  });
});

// ── AC: tsc --noEmit passes ─────────────────────────────────────────────────
// (Covered by the pre-PR gate, not as a vitest test)

// ── AC: ProjectConfig has id and projectDir fields ──────────────────────────

describe('ProjectConfig interface', () => {
  it('includes id and projectDir fields', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'config.ts'),
      'utf-8',
    );
    expect(source).toMatch(/id:\s*string/);
    expect(source).toMatch(/projectDir:\s*string/);
    expect(source).toContain('getProjectById');
  });
});

// ── AC: ws/types.ts dispatch includes projectId ─────────────────────────────

describe('WS ClientMessage types', () => {
  it('dispatch task items include projectId field', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'ws', 'types.ts'),
      'utf-8',
    );
    // dispatch tasks must have projectId
    expect(source).toMatch(/dispatch.*projectId:\s*string/s);
  });

  it('fetch_tasks requires both projectId and milestoneId', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'ws', 'types.ts'),
      'utf-8',
    );
    expect(source).toMatch(/fetch_tasks.*projectId:\s*string/s);
    expect(source).toMatch(/fetch_tasks.*milestoneId:\s*string/s);
  });
});
