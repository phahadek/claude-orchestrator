/**
 * ProjectService.reconcileYamlMilestones — unit tests
 *
 * Verifies the three-way upsert logic:
 *  1. Existing row with matching source_id → update name/order
 *  2. Existing row with source_id=null and matching name → adopt (backfill source_id, keep id)
 *  3. No match → create new row
 * And that upsert is never destructive (missing yaml milestones leave DB rows intact).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  // ProjectService object methods we don't test here
  insertProject: vi.fn(),
  getProjectRowById: vi.fn(),
  listProjectRows: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  countProjects: vi.fn(),
  getMilestoneById: vi.fn(),
  deleteMilestone: vi.fn(),
  // reconcile-relevant functions
  listMilestonesByProject: vi.fn(),
  updateMilestone: vi.fn(),
  insertMilestone: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  normalizePath: (p: string) => p,
  getAllProjects: vi.fn(),
  runtimeSettings: { task_cache_refresh_interval_ms: 10_000 },
}));

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { ProjectService } from '../projects/ProjectService.js';
import {
  listMilestonesByProject,
  updateMilestone,
  insertMilestone,
} from '../db/queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeTasksYaml(
  dir: string,
  milestones: { id: string; name: string }[],
): void {
  fs.writeFileSync(
    path.join(dir, 'tasks.yaml'),
    yaml.dump({ milestones: milestones.map((m) => ({ ...m, tasks: [] })) }),
    'utf-8',
  );
}

function makeRow(
  id: string,
  sourceId: string | null,
  name: string,
  displayOrder = 0,
) {
  return {
    id,
    project_id: 'proj-1',
    name,
    source_id: sourceId,
    display_order: displayOrder,
    created_at: 0,
    updated_at: 0,
  };
}

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-test-'));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('reconcileYamlMilestones — creates new rows', () => {
  it('inserts a new row when no existing row matches by source_id or name', () => {
    writeTasksYaml(tmpDir, [{ id: 'ms-1', name: 'Sprint 1' }]);
    vi.mocked(listMilestonesByProject).mockReturnValue([]);

    ProjectService.reconcileYamlMilestones('proj-1', tmpDir);

    expect(insertMilestone).toHaveBeenCalledOnce();
    const arg = vi.mocked(insertMilestone).mock.calls[0][0];
    expect(arg).toMatchObject({
      project_id: 'proj-1',
      name: 'Sprint 1',
      source_id: 'ms-1',
      display_order: 0,
    });
    expect(typeof arg.id).toBe('string');
    expect(arg.id.length).toBeGreaterThan(0);
  });

  it('assigns displayOrder based on milestones[] array position', () => {
    writeTasksYaml(tmpDir, [
      { id: 'ms-1', name: 'Sprint 1' },
      { id: 'ms-2', name: 'Sprint 2' },
      { id: 'ms-3', name: 'Sprint 3' },
    ]);
    vi.mocked(listMilestonesByProject).mockReturnValue([]);

    ProjectService.reconcileYamlMilestones('proj-1', tmpDir);

    const calls = vi.mocked(insertMilestone).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][0].display_order).toBe(0);
    expect(calls[1][0].display_order).toBe(1);
    expect(calls[2][0].display_order).toBe(2);
  });
});

describe('reconcileYamlMilestones — updates existing rows by source_id', () => {
  it('updates name and displayOrder for a row whose source_id matches', () => {
    writeTasksYaml(tmpDir, [{ id: 'ms-1', name: 'Sprint 1 renamed' }]);
    vi.mocked(listMilestonesByProject).mockReturnValue([
      makeRow('existing-uuid', 'ms-1', 'Sprint 1 old name', 5),
    ]);

    ProjectService.reconcileYamlMilestones('proj-1', tmpDir);

    expect(updateMilestone).toHaveBeenCalledWith('existing-uuid', {
      name: 'Sprint 1 renamed',
      display_order: 0,
    });
    expect(insertMilestone).not.toHaveBeenCalled();
  });
});

describe('reconcileYamlMilestones — adopts orphaned rows by name', () => {
  it('backfills source_id on a source_id=null row with a matching name', () => {
    writeTasksYaml(tmpDir, [{ id: 'ms-new-id', name: 'Sprint 1' }]);
    vi.mocked(listMilestonesByProject).mockReturnValue([
      makeRow('existing-uuid', null, 'Sprint 1', 3),
    ]);

    ProjectService.reconcileYamlMilestones('proj-1', tmpDir);

    expect(updateMilestone).toHaveBeenCalledWith('existing-uuid', {
      name: 'Sprint 1',
      source_id: 'ms-new-id',
      display_order: 0,
    });
    expect(insertMilestone).not.toHaveBeenCalled();
  });

  it('does not adopt a source_id=null row when names differ', () => {
    writeTasksYaml(tmpDir, [{ id: 'ms-new', name: 'Sprint A' }]);
    vi.mocked(listMilestonesByProject).mockReturnValue([
      makeRow('existing-uuid', null, 'Sprint B', 0),
    ]);

    ProjectService.reconcileYamlMilestones('proj-1', tmpDir);

    // names differ → must create new row
    expect(insertMilestone).toHaveBeenCalledOnce();
    expect(updateMilestone).not.toHaveBeenCalled();
  });
});

describe('reconcileYamlMilestones — upsert-only (never deletes)', () => {
  it('leaves rows for yaml milestones that no longer exist in tasks.yaml', () => {
    writeTasksYaml(tmpDir, [{ id: 'ms-1', name: 'Sprint 1' }]);
    vi.mocked(listMilestonesByProject).mockReturnValue([
      makeRow('uuid-ms-1', 'ms-1', 'Sprint 1', 0),
      makeRow('uuid-ms-removed', 'ms-removed', 'Sprint Removed', 1),
    ]);

    ProjectService.reconcileYamlMilestones('proj-1', tmpDir);

    // Only ms-1 updated; ms-removed is left intact (no delete)
    expect(updateMilestone).toHaveBeenCalledOnce();
    expect(updateMilestone).toHaveBeenCalledWith('uuid-ms-1', expect.any(Object));
    expect(insertMilestone).not.toHaveBeenCalled();
  });
});

describe('reconcileYamlMilestones — error handling', () => {
  it('returns gracefully when tasks.yaml does not exist', () => {
    ProjectService.reconcileYamlMilestones('proj-1', '/nonexistent/dir');

    expect(listMilestonesByProject).not.toHaveBeenCalled();
    expect(insertMilestone).not.toHaveBeenCalled();
    expect(updateMilestone).not.toHaveBeenCalled();
  });

  it('returns gracefully when tasks.yaml has no milestones key', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'tasks.yaml'),
      yaml.dump({ tasks: [] }),
      'utf-8',
    );

    ProjectService.reconcileYamlMilestones('proj-1', tmpDir);

    expect(insertMilestone).not.toHaveBeenCalled();
  });
});
