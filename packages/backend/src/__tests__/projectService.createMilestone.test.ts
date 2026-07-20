/**
 * ProjectService.createMilestone — canonical_short_id derivation
 *
 * Notion/GitHub/Jira milestones derive canonical_short_id from the leading
 * M<n> token in their name; a name with no such token falls back to the
 * full name and logs a warning. An explicit canonicalShortId always wins.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries.js', () => ({
  insertProject: vi.fn(),
  getProjectRowById: vi.fn(),
  listProjectRows: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  countProjects: vi.fn(),
  getMilestoneById: vi.fn(),
  deleteMilestone: vi.fn(),
  listMilestonesByProject: vi.fn(),
  updateMilestone: vi.fn(),
  insertMilestone: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

import { ProjectService } from '../projects/ProjectService.js';
import { insertMilestone } from '../db/queries.js';
import { logger } from '../logger.js';

function mockInsertReturn() {
  vi.mocked(insertMilestone).mockImplementation((m) => ({
    ...m,
    canonical_short_id: m.canonical_short_id ?? null,
    display_order: m.display_order ?? 0,
    created_at: 0,
    updated_at: 0,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertReturn();
});

describe('ProjectService.createMilestone — canonical_short_id derivation', () => {
  it('derives the leading M<n> token from the name', () => {
    ProjectService.createMilestone({
      id: 'ms-1',
      projectId: 'p1',
      name: 'M11 — Orchestrator-Owned Planning',
    });
    const arg = vi.mocked(insertMilestone).mock.calls[0][0];
    expect(arg.canonical_short_id).toBe('M11');
  });

  it('falls back to the full name and logs a warning when there is no M<n> token', () => {
    ProjectService.createMilestone({
      id: 'ms-2',
      projectId: 'p1',
      name: 'Backlog Cleanup',
    });
    const arg = vi.mocked(insertMilestone).mock.calls[0][0];
    expect(arg.canonical_short_id).toBe('Backlog Cleanup');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('uses an explicit canonicalShortId override when provided', () => {
    ProjectService.createMilestone({
      id: 'ms-3',
      projectId: 'p1',
      name: 'M12 — Some Title',
      canonicalShortId: 'M12-custom',
    });
    const arg = vi.mocked(insertMilestone).mock.calls[0][0];
    expect(arg.canonical_short_id).toBe('M12-custom');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
