/**
 * TaskCacheRefresher — YAML source coverage
 *
 * Verifies that:
 * 1. refreshOnce() includes yaml projects (Gate 1 fix: CACHEABLE_TASK_SOURCES)
 * 2. refreshProject() iterates milestones without sourceId for yaml/local (Gate 2 fix)
 * 3. notion/github/jira projects still require sourceId and are unaffected
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    listMilestones: vi.fn(),
  },
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getAllProjects: vi.fn(),
  runtimeSettings: { task_cache_refresh_interval_ms: 10_000 },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { TaskCacheRefresher } from '../orchestration/TaskCacheRefresher.js';
import { ProjectService } from '../projects/ProjectService.js';
import { getTaskBackend } from '../tasks/TaskBackend.js';
import { getAllProjects } from '../config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeYamlProject(id = 'proj-yaml') {
  return {
    id,
    name: 'YAML Project',
    taskSource: 'yaml' as const,
    nonMilestoneSourceConfig: null,
  };
}

function makeNotionProject(id = 'proj-notion') {
  return {
    id,
    name: 'Notion Project',
    taskSource: 'notion' as const,
    nonMilestoneSourceConfig: null,
  };
}

function makeMilestone(id: string, sourceId: string | null) {
  return {
    id,
    projectId: 'proj-yaml',
    name: 'M1',
    sourceId,
    displayOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeMockBackend(tasks: unknown[] = []) {
  return {
    fetchReadyTasks: vi.fn().mockResolvedValue(tasks),
    fetchNonMilestoneReadyTasks: vi.fn().mockResolvedValue([]),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskCacheRefresher — YAML source (Gate 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshOnce() includes yaml projects (projects count > 0)', async () => {
    const yamlProject = makeYamlProject();
    vi.mocked(getAllProjects).mockReturnValue([yamlProject] as never);
    vi.mocked(ProjectService.listMilestones).mockReturnValue([]);
    const backend = makeMockBackend();
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    const broadcasts: unknown[] = [];
    const refresher = new TaskCacheRefresher((msg) => broadcasts.push(msg), {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshOnce();

    // getTaskBackend should have been called for the yaml project
    expect(getTaskBackend).toHaveBeenCalledWith('proj-yaml');
  });

  it('refreshOnce() excludes projects with unknown taskSource', async () => {
    const unknownProject = {
      id: 'proj-unknown',
      name: 'Unknown',
      taskSource: 'unknown',
    };
    vi.mocked(getAllProjects).mockReturnValue([unknownProject] as never);

    const refresher = new TaskCacheRefresher(undefined, {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshOnce();

    expect(getTaskBackend).not.toHaveBeenCalled();
  });
});

describe('TaskCacheRefresher — YAML milestone iteration (Gate 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('iterates yaml milestones without sourceId', async () => {
    const yamlProject = makeYamlProject();
    vi.mocked(getAllProjects).mockReturnValue([yamlProject] as never);

    const milestoneWithoutSourceId = makeMilestone('milestone-yaml-1', null);
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      milestoneWithoutSourceId,
    ] as never);

    const backend = makeMockBackend([{ id: 'yaml:task-1', title: 'T1' }]);
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    const broadcasts: unknown[] = [];
    const refresher = new TaskCacheRefresher((msg) => broadcasts.push(msg), {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshOnce();

    expect(backend.fetchReadyTasks).toHaveBeenCalledWith('milestone-yaml-1');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: 'task_cache_updated',
      projectId: 'proj-yaml',
      boardId: 'milestone-yaml-1',
      taskCount: 1,
    });
  });

  it('iterates yaml milestones with sourceId too (no regression)', async () => {
    const yamlProject = makeYamlProject();
    vi.mocked(getAllProjects).mockReturnValue([yamlProject] as never);

    const milestoneWithSourceId = makeMilestone(
      'milestone-yaml-2',
      'some-source-id',
    );
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      milestoneWithSourceId,
    ] as never);

    const backend = makeMockBackend([]);
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    const refresher = new TaskCacheRefresher(undefined, {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshOnce();

    expect(backend.fetchReadyTasks).toHaveBeenCalledWith('milestone-yaml-2');
  });
});

describe('TaskCacheRefresher — notion/github/jira unchanged (Gate 2 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('still skips notion milestones without sourceId', async () => {
    const notionProject = makeNotionProject();
    vi.mocked(getAllProjects).mockReturnValue([notionProject] as never);

    const milestoneWithoutSourceId = makeMilestone('milestone-notion-1', null);
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      milestoneWithoutSourceId,
    ] as never);

    const backend = makeMockBackend([]);
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    const refresher = new TaskCacheRefresher(undefined, {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshOnce();

    // fetchReadyTasks must NOT be called since notion milestone has no sourceId
    expect(backend.fetchReadyTasks).not.toHaveBeenCalled();
  });

  it('still processes notion milestones that have sourceId', async () => {
    const notionProject = makeNotionProject();
    vi.mocked(getAllProjects).mockReturnValue([notionProject] as never);

    const milestoneWithSourceId = makeMilestone(
      'milestone-notion-2',
      'notion-db-123',
    );
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      milestoneWithSourceId,
    ] as never);

    const backend = makeMockBackend([{ id: 'notion:task-1', title: 'NT1' }]);
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    const broadcasts: unknown[] = [];
    const refresher = new TaskCacheRefresher((msg) => broadcasts.push(msg), {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshOnce();

    expect(backend.fetchReadyTasks).toHaveBeenCalledWith('milestone-notion-2');
    expect(broadcasts).toHaveLength(1);
  });
});

describe('TaskCacheRefresher — refreshProjectById reaches yaml projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshProjectById warms cache for yaml milestones without sourceId', async () => {
    const yamlProject = makeYamlProject();
    vi.mocked(getAllProjects).mockReturnValue([yamlProject] as never);

    const milestone = makeMilestone('milestone-yaml-sync', null);
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      milestone,
    ] as never);

    const backend = makeMockBackend([{ id: 'yaml:task-x', title: 'TX' }]);
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    const broadcasts: unknown[] = [];
    const refresher = new TaskCacheRefresher((msg) => broadcasts.push(msg), {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshProjectById('proj-yaml');

    expect(backend.fetchReadyTasks).toHaveBeenCalledWith('milestone-yaml-sync');
    expect(broadcasts[0]).toMatchObject({
      type: 'task_cache_updated',
      boardId: 'milestone-yaml-sync',
      taskCount: 1,
    });
  });
});
