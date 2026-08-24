/**
 * Tests for milestoneResolver.ts — the guard that stops a UUID (or any
 * other non-canonical value) from spawning a shadow gate/seed key-space.
 *
 * AC: resolveMilestoneForProject/resolveMilestoneAnyProject accept a
 * milestone's canonical display name or its DB id and return the display
 * name; anything else (a UUID from a different key-space, an unknown name)
 * throws UnknownMilestoneError.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const projectServiceMock = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

vi.mock('../ProjectService.js', () => ({
  ProjectService: projectServiceMock,
}));

const reportStoreMock = vi.hoisted(() => ({
  getReportsForBatchTaskId: vi.fn(),
}));

vi.mock('../../investigation/reportStore.js', () => reportStoreMock);

import {
  resolveMilestoneForProject,
  resolveMilestoneAnyProject,
  resolveMilestoneSourceId,
  resolveMilestoneForSessionTask,
  UnknownMilestoneError,
} from '../milestoneResolver.js';
import * as queries from '../../db/queries.js';
import type { GateItemRow } from '../../db/types.js';

const M11 = {
  id: 'ms-uuid-11',
  projectId: 'p1',
  name: 'M11',
  sourceId: null,
  canonicalShortId: 'M11',
  displayOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
const M12 = {
  ...M11,
  id: 'ms-uuid-12',
  name: 'M12',
  canonicalShortId: 'M12',
  displayOrder: 1,
};
const M13_FULL_TITLE = {
  ...M11,
  id: 'ms-uuid-13',
  name: 'M13 — Orchestrator-Owned Planning',
  canonicalShortId: 'M13',
  displayOrder: 2,
};

function project(milestones: (typeof M11)[] = [M11, M12]) {
  return { id: 'p1', milestones } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveMilestoneForProject', () => {
  it('accepts the canonical display name and returns it unchanged', () => {
    projectServiceMock.getById.mockReturnValue(project());
    expect(resolveMilestoneForProject('p1', 'M11')).toBe('M11');
  });

  it('normalizes a milestone DB id to its canonical display name', () => {
    projectServiceMock.getById.mockReturnValue(project());
    expect(resolveMilestoneForProject('p1', 'ms-uuid-11')).toBe('M11');
  });

  it('rejects a milestone DB id from a different project (a shadow-key-space UUID)', () => {
    projectServiceMock.getById.mockReturnValue(project());
    expect(() =>
      resolveMilestoneForProject('p1', 'some-other-projects-milestone-uuid'),
    ).toThrow(UnknownMilestoneError);
  });

  it('rejects an unknown milestone name', () => {
    projectServiceMock.getById.mockReturnValue(project());
    expect(() => resolveMilestoneForProject('p1', 'M99')).toThrow(
      UnknownMilestoneError,
    );
  });

  it('rejects when the project itself is unknown', () => {
    projectServiceMock.getById.mockReturnValue(undefined);
    expect(() => resolveMilestoneForProject('no-such-project', 'M11')).toThrow(
      UnknownMilestoneError,
    );
  });

  it('accepts the short form when the milestone is stored under its full Notion title and returns the short form', () => {
    projectServiceMock.getById.mockReturnValue(
      project([M11, M12, M13_FULL_TITLE]),
    );
    expect(resolveMilestoneForProject('p1', 'M13')).toBe('M13');
  });

  it('accepts the full Notion title and still returns the short form', () => {
    projectServiceMock.getById.mockReturnValue(
      project([M11, M12, M13_FULL_TITLE]),
    );
    expect(
      resolveMilestoneForProject('p1', 'M13 — Orchestrator-Owned Planning'),
    ).toBe('M13');
  });

  it('resolves the M<n> token against a Notion-synced milestone (hex source_id, token-derived canonical_short_id) without throwing', () => {
    const notionSynced = {
      ...M11,
      id: 'ms-uuid-11',
      name: 'M11 — Orchestrator-Owned Planning',
      sourceId: 'e4a105a2-1234-4abc-9def-000000000000',
      canonicalShortId: 'M11',
    };
    projectServiceMock.getById.mockReturnValue(project([notionSynced, M12]));
    expect(resolveMilestoneForProject('p1', 'M11')).toBe('M11');
  });
});

describe('resolveMilestoneSourceId', () => {
  it('resolves claude-dashboard / M12 to its board source_id (task.create parent resolution)', () => {
    const claudeDashboardM12 = {
      ...M12,
      id: 'ms-uuid-12',
      name: 'M12',
      sourceId: '6614adb5-5bec-4b9a-b9a4-208ae0f00f3c',
      canonicalShortId: 'M12',
    };
    projectServiceMock.getById.mockReturnValue(
      project([M11, claudeDashboardM12]),
    );
    expect(resolveMilestoneSourceId('claude-dashboard', 'M12')).toBe(
      '6614adb5-5bec-4b9a-b9a4-208ae0f00f3c',
    );
  });

  it('resolves a milestone DB id to its board source_id', () => {
    const withSource = { ...M11, sourceId: 'db-source-11' };
    projectServiceMock.getById.mockReturnValue(project([withSource, M12]));
    expect(resolveMilestoneSourceId('p1', 'ms-uuid-11')).toBe('db-source-11');
  });

  it('throws a clear error (not an opaque backend parent error) for an unresolvable milestone', () => {
    projectServiceMock.getById.mockReturnValue(project());
    expect(() => resolveMilestoneSourceId('p1', 'M99')).toThrow(
      UnknownMilestoneError,
    );
  });

  it('throws a clear, source-neutral error when the resolved milestone has no source_id configured', () => {
    projectServiceMock.getById.mockReturnValue(project([M11, M12]));
    expect(() => resolveMilestoneSourceId('p1', 'M11')).toThrow(
      /no source_id/,
    );
  });

  it('does not mention "Notion" in the no-source_id error text', () => {
    projectServiceMock.getById.mockReturnValue(project([M11, M12]));
    expect(() => resolveMilestoneSourceId('p1', 'M11')).toThrow(
      /^(?:(?!Notion).)*$/s,
    );
  });

  it('throws when the project itself is unknown', () => {
    projectServiceMock.getById.mockReturnValue(undefined);
    expect(() => resolveMilestoneSourceId('no-such-project', 'M11')).toThrow(
      UnknownMilestoneError,
    );
  });
});

describe('resolveMilestoneAnyProject', () => {
  it('accepts a canonical display name known to some project', () => {
    projectServiceMock.list.mockReturnValue([project()]);
    expect(resolveMilestoneAnyProject('M12')).toBe('M12');
  });

  it('normalizes a milestone DB id known to some project to its display name', () => {
    projectServiceMock.list.mockReturnValue([project()]);
    expect(resolveMilestoneAnyProject('ms-uuid-12')).toBe('M12');
  });

  it('rejects a UUID that matches no project milestone', () => {
    projectServiceMock.list.mockReturnValue([project()]);
    expect(() => resolveMilestoneAnyProject('9b1e-not-a-milestone')).toThrow(
      UnknownMilestoneError,
    );
  });

  it('rejects an unknown milestone name across all projects', () => {
    projectServiceMock.list.mockReturnValue([project()]);
    expect(() => resolveMilestoneAnyProject('M99')).toThrow(
      UnknownMilestoneError,
    );
  });

  it('accepts the short form when a project stores the milestone under its full Notion title', () => {
    projectServiceMock.list.mockReturnValue([
      project([M11, M12, M13_FULL_TITLE]),
    ]);
    expect(resolveMilestoneAnyProject('M13')).toBe('M13');
  });

  it('resolves the M<n> token against a Notion-synced milestone (hex source_id, token-derived canonical_short_id) without throwing', () => {
    const notionSynced = {
      ...M11,
      id: 'ms-uuid-11',
      name: 'M11 — Orchestrator-Owned Planning',
      sourceId: 'e4a105a2-1234-4abc-9def-000000000000',
      canonicalShortId: 'M11',
    };
    projectServiceMock.list.mockReturnValue([project([notionSynced, M12])]);
    expect(resolveMilestoneAnyProject('M11')).toBe('M11');
  });
});

describe('resolveMilestoneForSessionTask', () => {
  const gateItem: GateItemRow = {
    id: 'gi-1',
    project: 'p1',
    milestone: 'M13',
    text: 'some gate item',
    classification: 'code',
    min_deployed_commit: null,
    state: 'open',
    current_disposition: null,
    latest_disposition: null,
    updated_at: '2026-01-01T00:00:00.000Z',
  } as GateItemRow;

  it("returns a gate-verify session's gate item milestone for a gate-item:<uuid> task id", () => {
    vi.spyOn(queries, 'getGateItem').mockReturnValue(gateItem);
    expect(resolveMilestoneForSessionTask('p1', 'gate-item:gi-1')).toBe('M13');
  });

  it('falls back to resolveMilestoneForTaskId, unchanged, for a non-gate-verify task id', () => {
    projectServiceMock.getById.mockReturnValue(undefined);
    expect(resolveMilestoneForSessionTask('p1', 'task-123')).toBeNull();
  });

  it('returns null, not a crash, when the referenced gate item carries no milestone', () => {
    vi.spyOn(queries, 'getGateItem').mockReturnValue({
      ...gateItem,
      milestone: null as unknown as string,
    });
    expect(resolveMilestoneForSessionTask('p1', 'gate-item:gi-1')).toBeNull();
  });

  it('returns null when the referenced gate item does not exist', () => {
    vi.spyOn(queries, 'getGateItem').mockReturnValue(undefined);
    expect(
      resolveMilestoneForSessionTask('p1', 'gate-item:missing'),
    ).toBeNull();
  });

  it("returns an investigate batch's milestone for a report-batch:<batchId> task id", () => {
    projectServiceMock.getById.mockReturnValue(project());
    reportStoreMock.getReportsForBatchTaskId.mockReturnValue([
      { milestone_id: 'ms-uuid-11' },
    ]);
    expect(resolveMilestoneForSessionTask('p1', 'report-batch:batch-1')).toBe(
      'M11',
    );
    expect(reportStoreMock.getReportsForBatchTaskId).toHaveBeenCalledWith(
      'report-batch:batch-1',
    );
  });

  it('resolves a multi-report batch by the first report — matching launchInvestigateBatch', () => {
    projectServiceMock.getById.mockReturnValue(project());
    reportStoreMock.getReportsForBatchTaskId.mockReturnValue([
      { milestone_id: 'ms-uuid-11' },
      { milestone_id: 'ms-uuid-12' },
    ]);
    expect(
      resolveMilestoneForSessionTask('p1', 'report-batch:batch-multi'),
    ).toBe('M11');
  });

  it('returns null, not a crash, when the batch has no dispatch row', () => {
    reportStoreMock.getReportsForBatchTaskId.mockReturnValue([]);
    expect(
      resolveMilestoneForSessionTask('p1', 'report-batch:no-dispatch'),
    ).toBeNull();
  });

  it('returns null when the batch has no report', () => {
    reportStoreMock.getReportsForBatchTaskId.mockReturnValue([]);
    expect(
      resolveMilestoneForSessionTask('p1', 'report-batch:no-report'),
    ).toBeNull();
  });

  it('returns null when the report has no milestone_id set', () => {
    reportStoreMock.getReportsForBatchTaskId.mockReturnValue([
      { milestone_id: null },
    ]);
    expect(
      resolveMilestoneForSessionTask('p1', 'report-batch:no-milestone'),
    ).toBeNull();
  });

  it('returns null (not a throw) when the milestone_id no longer resolves for the project', () => {
    projectServiceMock.getById.mockReturnValue(project());
    reportStoreMock.getReportsForBatchTaskId.mockReturnValue([
      { milestone_id: 'unknown-uuid' },
    ]);
    expect(
      resolveMilestoneForSessionTask('p1', 'report-batch:stale-milestone'),
    ).toBeNull();
  });
});
