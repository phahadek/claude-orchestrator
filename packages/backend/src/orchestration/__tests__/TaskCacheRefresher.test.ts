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
    reconcileYamlMilestones: vi.fn(),
  },
}));

import { getAllProjects } from '../../config.js';
import { getTaskBackend } from '../../tasks/TaskBackend.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { TaskCacheRefresher } from '../TaskCacheRefresher.js';
import { JiraApiError } from '../../tasks/JiraClient.js';
import { upsertTaskCache } from '../../db/queries.js';
import { Scheduler, DEGRADED_TICK_THRESHOLD_MS } from '../Scheduler.js';

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
    it('processes yaml projects: calls reconcile and iterates milestones with sourceId', async () => {
      const yamlProject = makeProject({ taskSource: 'yaml' });
      vi.mocked(getAllProjects).mockReturnValue([yamlProject]);
      // listMilestones returns empty after reconcile → no fetchReadyTasks calls
      vi.mocked(ProjectService.listMilestones).mockReturnValue([]);

      const backend = makeBackend();
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });
      await refresher.refreshOnce();

      expect(ProjectService.reconcileYamlMilestones).toHaveBeenCalledWith(
        'proj-1',
        '/fake/project',
      );
      expect(backend.fetchReadyTasks).not.toHaveBeenCalled();
    });

    it('refreshes jira projects', async () => {
      const jiraProject = makeProject({ id: 'p1', taskSource: 'jira' });
      vi.mocked(getAllProjects).mockReturnValue([jiraProject]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
      ]);

      const backend = makeBackend();
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });
      await refresher.refreshOnce();

      expect(backend.fetchReadyTasks).toHaveBeenCalledWith('m1');
    });

    it('refreshes github projects', async () => {
      const ghProject = makeProject({ id: 'p1', taskSource: 'github' });
      vi.mocked(getAllProjects).mockReturnValue([ghProject]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
      ]);

      const backend = makeBackend();
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });
      await refresher.refreshOnce();

      expect(backend.fetchReadyTasks).toHaveBeenCalledWith('m1');
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

    it('fetches milestones within a single project with bounded concurrency', async () => {
      const project = makeProject({ id: 'p1' });
      vi.mocked(getAllProjects).mockReturnValue([project]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
        makeMilestone('m2', 'src-2'),
        makeMilestone('m3', 'src-3'),
      ]);

      // Deferred promises let us observe that multiple fetchReadyTasks calls
      // are in flight simultaneously before any of them resolve.
      const deferreds = new Map<string, { resolve: (v: unknown[]) => void }>();
      const inFlight = new Set<string>();
      let maxConcurrent = 0;

      const backend = makeBackend({
        fetchReadyTasks: vi.fn().mockImplementation((fetchId: string) => {
          inFlight.add(fetchId);
          maxConcurrent = Math.max(maxConcurrent, inFlight.size);
          return new Promise((resolve) => {
            deferreds.set(fetchId, {
              resolve: (v: unknown[]) => {
                inFlight.delete(fetchId);
                resolve(v);
              },
            });
          });
        }),
      });
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });

      const refreshPromise = refresher.refreshOnce();

      // Each milestone iteration awaits a setImmediate yield before fetching
      // (yieldToEventLoop) — drain a few real event-loop ticks so every
      // milestone that's going to start concurrently has had the chance to.
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(maxConcurrent).toBeGreaterThan(1);

      for (const fetchId of ['m1', 'm2', 'm3']) {
        deferreds.get(fetchId)?.resolve([]);
      }

      await refreshPromise;
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

    describe('Jira rate limiting', () => {
      it('skips jira project during backoff window', async () => {
        const jiraProject = makeProject({ id: 'p1', taskSource: 'jira' });
        vi.mocked(getAllProjects).mockReturnValue([jiraProject]);
        vi.mocked(ProjectService.listMilestones).mockReturnValue([
          makeMilestone('m1', 'src-1'),
        ]);

        const backend = makeBackend({
          fetchReadyTasks: vi
            .fn()
            .mockRejectedValue(new JiraApiError(429, 'Rate limited')),
        });
        vi.mocked(getTaskBackend).mockReturnValue(backend);

        const refresher = new TaskCacheRefresher(undefined, {
          listProjects: getAllProjects,
          resolveBackend: getTaskBackend,
        });

        // First cycle — hits 429, sets backoff
        await refresher.refreshOnce();
        expect(backend.fetchReadyTasks).toHaveBeenCalledTimes(1);

        // Second cycle immediately after — project should be skipped due to backoff
        await refresher.refreshOnce();
        expect(backend.fetchReadyTasks).toHaveBeenCalledTimes(1);
      });

      it('aborts remaining milestones for a jira project on 429', async () => {
        const jiraProject = makeProject({ id: 'p1', taskSource: 'jira' });
        vi.mocked(getAllProjects).mockReturnValue([jiraProject]);
        vi.mocked(ProjectService.listMilestones).mockReturnValue([
          makeMilestone('m1', 'src-1'),
          makeMilestone('m2', 'src-2'),
          makeMilestone('m3', 'src-3'),
        ]);

        const backend = makeBackend({
          fetchReadyTasks: vi
            .fn()
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new JiraApiError(429, 'Rate limited'))
            .mockResolvedValue([]),
        });
        vi.mocked(getTaskBackend).mockReturnValue(backend);

        const refresher = new TaskCacheRefresher(undefined, {
          listProjects: getAllProjects,
          resolveBackend: getTaskBackend,
        });

        await refresher.refreshOnce();

        // m1 succeeded, m2 hit 429, m3 should be skipped
        expect(backend.fetchReadyTasks).toHaveBeenCalledTimes(2);
      });

      it('uses Retry-After header value when longer than default backoff', async () => {
        const jiraProject = makeProject({ id: 'p1', taskSource: 'jira' });
        vi.mocked(getAllProjects).mockReturnValue([jiraProject]);
        vi.mocked(ProjectService.listMilestones).mockReturnValue([
          makeMilestone('m1', 'src-1'),
        ]);

        // 429 with a Retry-After of 300s (300_000ms) > default 120_000ms
        const backend = makeBackend({
          fetchReadyTasks: vi
            .fn()
            .mockRejectedValue(new JiraApiError(429, 'Rate limited', 300_000)),
        });
        vi.mocked(getTaskBackend).mockReturnValue(backend);

        const broadcast = vi.fn();
        const refresher = new TaskCacheRefresher(broadcast, {
          listProjects: getAllProjects,
          resolveBackend: getTaskBackend,
        });

        await refresher.refreshOnce();
        // Hit 429 — no broadcast
        expect(broadcast).not.toHaveBeenCalled();

        // Next immediate cycle — still in backoff
        await refresher.refreshOnce();
        expect(backend.fetchReadyTasks).toHaveBeenCalledTimes(1);
      });

      it('enforces 120s minimum cadence between jira refreshes on success', async () => {
        const jiraProject = makeProject({ id: 'p1', taskSource: 'jira' });
        vi.mocked(getAllProjects).mockReturnValue([jiraProject]);
        vi.mocked(ProjectService.listMilestones).mockReturnValue([
          makeMilestone('m1', 'src-1'),
        ]);

        const backend = makeBackend({
          fetchReadyTasks: vi.fn().mockResolvedValue([]),
        });
        vi.mocked(getTaskBackend).mockReturnValue(backend);

        const refresher = new TaskCacheRefresher(undefined, {
          listProjects: getAllProjects,
          resolveBackend: getTaskBackend,
        });

        // First cycle — processes the project
        await refresher.refreshOnce();
        expect(backend.fetchReadyTasks).toHaveBeenCalledTimes(1);

        // Immediate second cycle — should be skipped (120s not elapsed)
        await refresher.refreshOnce();
        expect(backend.fetchReadyTasks).toHaveBeenCalledTimes(1);
      });

      it('does not apply jira rate limiting to other project sources', async () => {
        const notionProject = makeProject({ id: 'p1', taskSource: 'notion' });
        vi.mocked(getAllProjects).mockReturnValue([notionProject]);
        vi.mocked(ProjectService.listMilestones).mockReturnValue([
          makeMilestone('m1', 'src-1'),
        ]);

        const backend = makeBackend({
          fetchReadyTasks: vi.fn().mockResolvedValue([]),
        });
        vi.mocked(getTaskBackend).mockReturnValue(backend);

        const refresher = new TaskCacheRefresher(undefined, {
          listProjects: getAllProjects,
          resolveBackend: getTaskBackend,
        });

        await refresher.refreshOnce();
        await refresher.refreshOnce();

        // Notion is not rate-limited — should be called twice
        expect(backend.fetchReadyTasks).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('event loop yielding', () => {
    it('yields to the event loop during milestone processing', async () => {
      const project = makeProject({ id: 'p1' });
      vi.mocked(getAllProjects).mockReturnValue([project]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
        makeMilestone('m2', 'src-2'),
      ]);

      const backend = makeBackend({
        fetchReadyTasks: vi.fn().mockResolvedValue([]),
      });
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });

      const events: string[] = [];
      setImmediate(() => {
        events.push('sentinel');
      });

      const tick = refresher.refreshOnce().then(() => {
        events.push('tick-complete');
      });
      await tick;

      // A macrotask scheduled at tick start only gets a chance to run
      // before the tick's own promise resolves if the tick itself yields
      // to the event loop at least once along the way (all-microtask work
      // would resolve the tick's promise first, starving the sentinel).
      expect(events).toEqual(['sentinel', 'tick-complete']);
      expect(backend.fetchReadyTasks).toHaveBeenCalledTimes(2);
    });

    it('does not hold the loop for a full multi-milestone pass', async () => {
      const project = makeProject({ id: 'p1' });
      vi.mocked(getAllProjects).mockReturnValue([project]);
      const milestones = Array.from({ length: 5 }, (_, i) =>
        makeMilestone(`m${i}`, `src-${i}`),
      );
      vi.mocked(ProjectService.listMilestones).mockReturnValue(milestones);

      const backend = makeBackend();
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });

      const events: string[] = [];
      setImmediate(() => {
        events.push('sentinel');
      });

      const tick = refresher.refreshOnce().then(() => {
        events.push('tick-complete');
      });
      await tick;

      // A macrotask scheduled at tick start only gets a chance to run
      // before the tick's own promise resolves if the tick itself yields
      // to the event loop at least once along the way (all-microtask work
      // would resolve the tick's promise first, starving the sentinel).
      expect(events).toEqual(['sentinel', 'tick-complete']);
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

  describe('items_processed reporting', () => {
    it('returns a non-zero count when a cached task row changed, and 0 when nothing changed', async () => {
      const project = makeProject({ id: 'p1' });
      vi.mocked(getAllProjects).mockReturnValue([project]);
      vi.mocked(ProjectService.listMilestones).mockReturnValue([
        makeMilestone('m1', 'src-1'),
      ]);

      let rawJson = JSON.stringify({ v: 1 });
      const backend = makeBackend({
        fetchReadyTasks: vi.fn().mockImplementation(async () => {
          upsertTaskCache('changed-row-task', rawJson);
          return [{ task: { id: 'changed-row-task' } }];
        }),
      });
      vi.mocked(getTaskBackend).mockReturnValue(backend);

      const refresher = new TaskCacheRefresher(undefined, {
        listProjects: getAllProjects,
        resolveBackend: getTaskBackend,
      });

      // First observation of this task's cache row counts as a change.
      const first = await refresher.refreshOnce();
      expect(first).toBe(1);

      // Same content rewritten — the row's fetched_at moves but its content
      // doesn't, so this must be a true zero, not just "unreported".
      const second = await refresher.refreshOnce();
      expect(second).toBe(0);

      // Content actually changes — reported again as non-zero.
      rawJson = JSON.stringify({ v: 2 });
      const third = await refresher.refreshOnce();
      expect(third).toBe(1);
    });
  });
});

describe('Scheduler degraded-tick reclassification (task_cache_refresher)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllProjects).mockReturnValue([]);
    vi.mocked(ProjectService.listMilestones).mockReturnValue([]);
    // Fake only Date — TaskCacheRefresher yields via setImmediate
    // (yieldToEventLoop) between milestones, which must keep resolving on
    // the real event loop, not stall waiting for a manual timer advance.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('distinguishes a long productive tick (ok) from a long zero-item tick (degraded)', async () => {
    const project = makeProject({ id: 'p1' });
    vi.mocked(getAllProjects).mockReturnValue([project]);
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      makeMilestone('m1', 'src-1'),
    ]);

    let rawJson = JSON.stringify({ v: 1 });
    const backend = makeBackend({
      fetchReadyTasks: vi.fn().mockImplementation(async () => {
        // Fake timers also fake Date.now(), so advancing them synchronously
        // during the job simulates a multi-minute tick without the test
        // actually waiting that long.
        vi.advanceTimersByTime(DEGRADED_TICK_THRESHOLD_MS);
        upsertTaskCache('degraded-test-task', rawJson);
        return [{ task: { id: 'degraded-test-task' } }];
      }),
    });
    vi.mocked(getTaskBackend).mockReturnValue(backend);

    const refresher = new TaskCacheRefresher(undefined, {
      listProjects: getAllProjects,
      resolveBackend: getTaskBackend,
    });
    const scheduler = new Scheduler();
    refresher.register(scheduler);

    // Long tick, content changed — genuinely productive, must stay 'ok'.
    await scheduler.triggerNow('task_cache_refresher');
    const afterProductive = scheduler
      .status()
      .find((s) => s.name === 'task_cache_refresher');
    expect(afterProductive?.lastStatus).toBe('ok');

    // Long tick, identical content — a starved/wedged-looking tick that did
    // no real work, must be reclassified 'degraded'.
    await scheduler.triggerNow('task_cache_refresher');
    const afterIdle = scheduler
      .status()
      .find((s) => s.name === 'task_cache_refresher');
    expect(afterIdle?.lastStatus).toBe('degraded');
  });
});
