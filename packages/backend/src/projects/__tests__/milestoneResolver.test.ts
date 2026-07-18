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

import {
  resolveMilestoneForProject,
  resolveMilestoneAnyProject,
  UnknownMilestoneError,
} from '../milestoneResolver.js';

const M11 = {
  id: 'ms-uuid-11',
  projectId: 'p1',
  name: 'M11',
  sourceId: null,
  displayOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
const M12 = { ...M11, id: 'ms-uuid-12', name: 'M12', displayOrder: 1 };
const M13_FULL_TITLE = {
  ...M11,
  id: 'ms-uuid-13',
  name: 'M13 — Orchestrator-Owned Planning',
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
});
