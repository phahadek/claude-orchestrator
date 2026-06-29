/**
 * TaskCacheRefresher — YAML source coverage
 *
 * Verifies that:
 * 1. refreshOnce() includes yaml projects
 * 2. reconcileYamlMilestones is called before milestone iteration for yaml projects
 * 3. fetchReadyTasks receives milestone.sourceId (yaml id) not milestone.id (DB PK)
 * 4. notion/github/jira projects still require sourceId and are unaffected
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    listMilestones: vi.fn(),
    reconcileYamlMilestones: vi.fn(),
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
    projectDir: '/fake/yaml',
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

function makeMilestone(id: string, sourceId: string | null, name = 'M1') {
  return {
    id,
    projectId: 'proj-yaml',
    name,
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

  it('refreshOnce() includes yaml projects', async () => {
    const yamlProject = makeYamlProject();
    vi.mocked(getAllProjects).mockReturnValue([yamlProject] as never);
    vi.mocked(ProjectService.listMilestones).mockReturnValue([]);
    const backend = makeMockBackend();
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    const refresher = new TaskCacheRefresher(undefined, {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshOnce();

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

describe('TaskCacheRefresher — YAML reconcile and sourceId routing (M9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls reconcileYamlMilestones before iterating milestones', async () => {
    const yamlProject = makeYamlProject();
    vi.mocked(getAllProjects).mockReturnValue([yamlProject] as never);
    vi.mocked(ProjectService.listMilestones).mockReturnValue([]);
    const backend = makeMockBackend();
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    const refresher = new TaskCacheRefresher(undefined, {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshOnce();

    expect(ProjectService.reconcileYamlMilestones).toHaveBeenCalledWith(
      'proj-yaml',
      '/fake/yaml',
    );
    // reconcile is called before listMilestones (invocation order)
    const reconcileOrder = vi.mocked(ProjectService.reconcileYamlMilestones)
      .mock.invocationCallOrder[0];
    const listOrder = vi.mocked(ProjectService.listMilestones).mock
      .invocationCallOrder[0];
    expect(reconcileOrder).toBeLessThan(listOrder);
  });

  it('passes milestone.sourceId (yaml id) to fetchReadyTasks, not milestone.id (DB PK)', async () => {
    const yamlProject = makeYamlProject();
    vi.mocked(getAllProjects).mockReturnValue([yamlProject] as never);

    const milestoneWithSourceId = makeMilestone('db-uuid-pk', 'yaml-m1');
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      milestoneWithSourceId,
    ] as never);

    const backend = makeMockBackend([{ id: 'yaml:task-1', title: 'T1' }]);
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    const broadcasts: unknown[] = [];
    const refresher = new TaskCacheRefresher((msg) => broadcasts.push(msg), {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshOnce();

    expect(backend.fetchReadyTasks).toHaveBeenCalledWith('yaml-m1');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: 'task_cache_updated',
      projectId: 'proj-yaml',
      boardId: 'yaml-m1',
      taskCount: 1,
    });
  });

  it('skips yaml milestones that still have no sourceId after reconcile', async () => {
    const yamlProject = makeYamlProject();
    vi.mocked(getAllProjects).mockReturnValue([yamlProject] as never);

    const milestoneWithoutSourceId = makeMilestone('db-uuid-pk', null);
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

    expect(backend.fetchReadyTasks).not.toHaveBeenCalled();
  });

  it('does not call reconcile for notion projects', async () => {
    const notionProject = makeNotionProject();
    vi.mocked(getAllProjects).mockReturnValue([notionProject] as never);
    const milestone = makeMilestone('m-notion', 'notion-db-id');
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      milestone,
    ] as never);
    const backend = makeMockBackend([]);
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);

    const refresher = new TaskCacheRefresher(undefined, {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });

    await refresher.refreshOnce();

    expect(ProjectService.reconcileYamlMilestones).not.toHaveBeenCalled();
  });

  it('refreshProjectById also calls reconcile for yaml projects', async () => {
    const yamlProject = makeYamlProject();
    vi.mocked(getAllProjects).mockReturnValue([yamlProject] as never);

    const milestone = makeMilestone('db-uuid', 'yaml-milestone-sync');
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

    expect(ProjectService.reconcileYamlMilestones).toHaveBeenCalledWith(
      'proj-yaml',
      '/fake/yaml',
    );
    expect(backend.fetchReadyTasks).toHaveBeenCalledWith('yaml-milestone-sync');
    expect(broadcasts[0]).toMatchObject({
      type: 'task_cache_updated',
      boardId: 'yaml-milestone-sync',
      taskCount: 1,
    });
  });
});

describe('TaskCacheRefresher — notion/github/jira unchanged (regression)', () => {
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

    expect(backend.fetchReadyTasks).not.toHaveBeenCalled();
  });

  it('still processes notion milestones that have sourceId using milestone.id', async () => {
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

    // notion uses milestone.id (DB PK), not sourceId
    expect(backend.fetchReadyTasks).toHaveBeenCalledWith('milestone-notion-2');
    expect(broadcasts).toHaveLength(1);
  });
});
