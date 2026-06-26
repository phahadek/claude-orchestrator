import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectConfig } from '../../config';
import type { TaskBackend } from '../../tasks/TaskBackend';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  getAllProjects: vi.fn(),
  runtimeSettings: {
    task_cache_refresh_interval_ms: 60_000,
  },
}));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../../projects/ProjectService.js', () => ({
  ProjectService: {
    listMilestones: vi.fn(),
  },
}));

import { getAllProjects } from '../../config.js';
import { getTaskBackend } from '../../tasks/TaskBackend.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { TaskCacheRefresher } from '../TaskCacheRefresher.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Test Project',
    projectDir: '/fake/project',
    contextUrl: '',
    boardId: 'board-1',
    taskSource: 'notion',
    gitMode: 'github',
    autoLaunchEnabled: true,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    milestoneBranching: null,
    nonMilestoneSourceConfig: null,
    dataResidencyConfirmed: false,
    baseBranch: 'dev',
    ...overrides,
  };
}

function makeMilestone(id: string, sourceId: string) {
  return { id, sourceId, name: `Milestone ${id}` };
}

function makeBackend(overrides: Partial<TaskBackend> = {}): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn().mockResolvedValue([]),
    fetchNonMilestoneReadyTasks: vi.fn().mockResolvedValue([]),
    attachPR: vi.fn(),
    updateStatus: vi.fn(),
    fetchTaskPage: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TaskBackend;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskCacheRefresher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllProjects).mockReturnValue([]);
    vi.mocked(ProjectService.listMilestones).mockReturnValue([]);
  });

  describe('refreshOnce', () => {
    it('skips non-notion projects', async () => {
      const yamlProject = makeProject({ taskSource: 'yaml' });
      vi.mocked(getAllProjects).mockReturnValue([yamlProject]);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
      });
      await refresher.refreshOnce();

      expect(getTaskBackend).not.toHaveBeenCalled();
    });

    it('fans out parallel fetches for multiple notion projects', async () => {
      const proj1 = makeProject({ id: 'p1' });
      const proj2 = makeProject({ id: 'p2' });
      const proj3 = makeProject({ id: 'p3' });

      vi.mocked(getAllProjects).mockReturnValue([proj1, proj2, proj3]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
      ]);

      const backends = [makeBackend(), makeBackend(), makeBackend()];
      vi.mocked(getTaskBackend)
        .mockReturnValueOnce(backends[0])
        .mockReturnValueOnce(backends[1])
        .mockReturnValueOnce(backends[2]);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });
      await refresher.refreshOnce();

      expect(backends[0].fetchReadyTasks).toHaveBeenCalledWith('m1');
      expect(backends[1].fetchReadyTasks).toHaveBeenCalledWith('m1');
      expect(backends[2].fetchReadyTasks).toHaveBeenCalledWith('m1');
    });

    it('broadcasts task_cache_updated after successful refresh', async () => {
      const project = makeProject({ id: 'p1' });
      vi.mocked(getAllProjects).mockReturnValue([project]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
      ]);
      const backend = makeBackend({
        fetchReadyTasks: vi
          .fn()
          .mockResolvedValue([{ task: { id: 't1' } }, { task: { id: 't2' } }]),
      });
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const broadcast = vi.fn();
      const refresher = new TaskCacheRefresher(broadcast, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });
      await refresher.refreshOnce();

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task_cache_updated',
          projectId: 'p1',
          boardId: 'm1',
          taskCount: 2,
        }),
      );
    });

    it('continues refreshing other projects when one fails', async () => {
      const proj1 = makeProject({ id: 'p1' });
      const proj2 = makeProject({ id: 'p2' });

      vi.mocked(getAllProjects).mockReturnValue([proj1, proj2]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
      ]);

      const failingBackend = makeBackend({
        fetchReadyTasks: vi.fn().mockRejectedValue(new Error('Notion error')),
      });
      const successBackend = makeBackend({
        fetchReadyTasks: vi.fn().mockResolvedValue([]),
      });
      vi.mocked(getTaskBackend)
        .mockReturnValueOnce(failingBackend)
        .mockReturnValueOnce(successBackend);

      const broadcast = vi.fn();
      const refresher = new TaskCacheRefresher(broadcast, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });

      await expect(refresher.refreshOnce()).resolves.not.toThrow();
      // p1 failed — no broadcast; p2 succeeded — one broadcast
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p2' }),
      );
    });

    it('is guarded against overlapping cycles', async () => {
      const project = makeProject();
      vi.mocked(getAllProjects).mockReturnValue([project]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
      ]);

      let resolveFetch!: () => void;
      const backend = makeBackend({
        fetchReadyTasks: vi.fn().mockReturnValue(
          new Promise<never[]>((res) => {
            resolveFetch = () => res([]);
          }),
        ),
      });
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });

      const first = refresher.refreshOnce();
      const second = refresher.refreshOnce(); // concurrent — should be a no-op

      resolveFetch();
      await Promise.all([first, second]);

      // fetchReadyTasks should only have been called once (second call was guard-rejected)
      expect(backend.fetchReadyTasks).toHaveBeenCalledTimes(1);
    });
  });

  describe('refreshProjectById', () => {
    it('triggers refresh for a single project by id', async () => {
      const proj1 = makeProject({ id: 'p1' });
      const proj2 = makeProject({ id: 'p2' });
      vi.mocked(getAllProjects).mockReturnValue([proj1, proj2]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
      ]);

      const backend = makeBackend();
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });
      await refresher.refreshProjectById('p1');

      expect(getTaskBackend).toHaveBeenCalledWith('p1');
      expect(getTaskBackend).toHaveBeenCalledTimes(1);
    });

    it('does nothing when projectId is not found', async () => {
      vi.mocked(getAllProjects).mockReturnValue([]);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
      });
      await expect(
        refresher.refreshProjectById('unknown'),
      ).resolves.not.toThrow();
      expect(getTaskBackend).not.toHaveBeenCalled();
    });

    it('passes skipCache:true to fetchReadyTasks when called with skipCache:true', async () => {
      const proj = makeProject({ id: 'p1' });
      vi.mocked(getAllProjects).mockReturnValue([proj]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
      ]);

      const backend = makeBackend();
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });
      await refresher.refreshProjectById('p1', true);

      expect(backend.fetchReadyTasks).toHaveBeenCalledWith('m1', true);
    });

    it('passes no skipCache to fetchReadyTasks when called without it (passive refresh)', async () => {
      const proj = makeProject({ id: 'p1' });
      vi.mocked(getAllProjects).mockReturnValue([proj]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
      ]);

      const backend = makeBackend();
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });
      await refresher.refreshProjectById('p1');

      expect(backend.fetchReadyTasks).toHaveBeenCalledWith('m1');
    });
  });
});
