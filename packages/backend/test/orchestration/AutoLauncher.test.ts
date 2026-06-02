import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../src/db/db.js', async () => {
  const { setupTestDb } = await import('../helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { AutoLauncher } from '../../src/orchestration/AutoLauncher';
import type { ProjectConfig } from '../../src/config';
import type { ResolvedTask } from '../../src/notion/types';
import type { TaskBackend } from '../../src/tasks/TaskBackend';
import type { SessionManager } from '../../src/session/SessionManager';
import { runtimeSettings } from '../../src/config';
import { db } from '../../src/db/db.js';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM pull_requests').run();
  runtimeSettings.auto_launch_concurrency = 1;
  runtimeSettings.auto_launch_poll_interval_ms = 60_000;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Test Project',
    projectDir: '/tmp/test',
    contextUrl: 'https://notion.so/ctx',
    boardId: 'milestone-1',
    boards: [{ id: 'milestone-1', sourceId: 'src-1', name: 'M1' }],
    taskSource: 'notion',
    autoLaunchEnabled: true,
    autoLaunchMilestoneId: null,
    ...overrides,
  };
}

function makeTask(
  overrides: Partial<ResolvedTask['task']> = {},
): ResolvedTask['task'] {
  return {
    id: 'task-1',
    title: 'Test Task',
    status: '🗂️ Ready',
    type: '💻 Code',
    dependsOn: [],
    notionUrl: 'https://notion.so/task-1',
    ...overrides,
  };
}

function makeResolved(
  task: ResolvedTask['task'],
  overrides: Partial<Omit<ResolvedTask, 'task'>> = {},
): ResolvedTask {
  return {
    task,
    blocked: false,
    blockers: [],
    nonCode: false,
    wave: 1,
    ...overrides,
  };
}

function makeMockBackend(tasks: ResolvedTask[]): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn().mockResolvedValue(tasks),
    attachPR: vi.fn(),
    updateStatus: vi.fn(),
    fetchTaskPage: vi.fn(),
  } as unknown as TaskBackend;
}

function makeMockSessionManager(): SessionManager {
  const sm = new EventEmitter() as unknown as SessionManager;
  let liveCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sm as any).start = vi.fn(() => {
    liveCount++;
    return `session-${liveCount}`;
  });
  (sm as any).getLiveCodeSessionCount = vi.fn(() => liveCount);
  (sm as any).hasLiveSessionForTask = vi.fn(() => false);
  return sm;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AutoLauncher', () => {
  it('launches a Ready 💻 Code task with no blockers', async () => {
    const sm = makeMockSessionManager();
    const project = makeProject();
    const backend = makeMockBackend([makeResolved(makeTask())]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [project],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).toHaveBeenCalledTimes(1);
  });

  it('skips tasks that are not Ready', async () => {
    const sm = makeMockSessionManager();
    const task = makeTask({ status: '🔲 Backlog' });
    const backend = makeMockBackend([makeResolved(task)]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).not.toHaveBeenCalled();
  });

  it('skips non-Code task types (📋 Planning, 🧪 Testing)', async () => {
    const sm = makeMockSessionManager();
    const planning = makeTask({ id: 'p', type: '📋 Planning' });
    const testing = makeTask({ id: 't', type: '🧪 Testing' });
    const backend = makeMockBackend([
      makeResolved(planning),
      makeResolved(testing),
    ]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).not.toHaveBeenCalled();
  });

  it('skips blocked tasks (dependency not Done)', async () => {
    const sm = makeMockSessionManager();
    const backend = makeMockBackend([
      makeResolved(makeTask(), {
        blocked: true,
        blockers: [makeTask({ id: 'dep' })],
      }),
    ]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).not.toHaveBeenCalled();
  });

  it('skips projects with autoLaunchEnabled = false', async () => {
    const sm = makeMockSessionManager();
    const backend = makeMockBackend([makeResolved(makeTask())]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject({ autoLaunchEnabled: false })],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).not.toHaveBeenCalled();
    expect(backend.fetchReadyTasks).not.toHaveBeenCalled();
  });

  it('honors the global concurrency cap', async () => {
    runtimeSettings.auto_launch_concurrency = 2;
    const sm = makeMockSessionManager();
    const backend = makeMockBackend([
      makeResolved(makeTask({ id: 'a' })),
      makeResolved(makeTask({ id: 'b' })),
      makeResolved(makeTask({ id: 'c' })),
    ]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).toHaveBeenCalledTimes(2);
  });

  it('skips when the cap is already filled by existing sessions', async () => {
    const sm = makeMockSessionManager();
    (
      sm as unknown as { getLiveCodeSessionCount: ReturnType<typeof vi.fn> }
    ).getLiveCodeSessionCount = vi.fn(() => 5);
    runtimeSettings.auto_launch_concurrency = 1;
    const backend = makeMockBackend([makeResolved(makeTask())]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).not.toHaveBeenCalled();
  });

  it('skips tasks with a non-null pause_reason', async () => {
    const sm = makeMockSessionManager();
    const task = makeTask();
    (task as { pause_reason?: string | null }).pause_reason = 'investigating';
    const backend = makeMockBackend([makeResolved(task)]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).not.toHaveBeenCalled();
  });

  it('skips tasks whose PR has a non-null pause_reason in SQLite', async () => {
    const sm = makeMockSessionManager();
    const task = makeTask({ id: 'paused-task' });
    db.prepare(
      `
      INSERT INTO pull_requests
        (pr_number, pr_url, task_id, session_id, repo, state,
         created_at, updated_at, synced_at, pause_reason)
      VALUES
        (1, 'https://github.com/o/r/pull/1', @task_id, NULL, 'o/r', 'open',
         'now', 'now', 'now', 'stuck_timeout')
    `,
    ).run({ task_id: task.id });
    const backend = makeMockBackend([makeResolved(task)]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).not.toHaveBeenCalled();
  });

  it('skips when a live session for the task already exists', async () => {
    const sm = makeMockSessionManager();
    (
      sm as unknown as { hasLiveSessionForTask: ReturnType<typeof vi.fn> }
    ).hasLiveSessionForTask = vi.fn(() => true);
    const backend = makeMockBackend([makeResolved(makeTask())]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).not.toHaveBeenCalled();
  });

  it('emits an auto_launch broadcast for every launched task', async () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    const backend = makeMockBackend([makeResolved(makeTask())]);

    const launcher = new AutoLauncher(sm, broadcast, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'auto_launch',
        projectId: 'proj-1',
        taskId: 'task-1',
        taskTitle: 'Test Task',
      }),
    );
  });

  it('does not run a poll while one is in progress', async () => {
    const sm = makeMockSessionManager();
    let resolveFetch: ((tasks: ResolvedTask[]) => void) | undefined;
    const backend: TaskBackend = {
      type: 'notion',
      fetchReadyTasks: vi.fn(
        () =>
          new Promise<ResolvedTask[]>((res) => {
            resolveFetch = res;
          }),
      ),
      attachPR: vi.fn(),
      updateStatus: vi.fn(),
      fetchTaskPage: vi.fn(),
    } as unknown as TaskBackend;

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    const first = launcher.pollOnce();
    await launcher.pollOnce(); // Should return immediately
    expect(backend.fetchReadyTasks).toHaveBeenCalledTimes(1);

    resolveFetch?.([]);
    await first;
  });

  it('falls back to the first milestone with a sourceId when autoLaunchMilestoneId is null', async () => {
    const sm = makeMockSessionManager();
    const backend = makeMockBackend([]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [
        makeProject({
          boards: [
            { id: 'no-source', sourceId: '', name: 'NoSrc' },
            { id: 'milestone-X', sourceId: 'src-X', name: 'X' },
          ],
          autoLaunchMilestoneId: null,
        }),
      ],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(backend.fetchReadyTasks).toHaveBeenCalledWith('milestone-X', true);
  });

  it('uses the explicit autoLaunchMilestoneId when set', async () => {
    const sm = makeMockSessionManager();
    const backend = makeMockBackend([]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [
        makeProject({
          boards: [
            { id: 'milestone-1', sourceId: 'src-1', name: 'M1' },
            { id: 'milestone-2', sourceId: 'src-2', name: 'M2' },
          ],
          autoLaunchMilestoneId: 'milestone-2',
        }),
      ],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(backend.fetchReadyTasks).toHaveBeenCalledWith('milestone-2', true);
  });

  it('skips YAML projects', async () => {
    const sm = makeMockSessionManager();
    const yamlBackend: TaskBackend = {
      type: 'local',
      fetchReadyTasks: vi.fn(),
      attachPR: vi.fn(),
      updateStatus: vi.fn(),
      fetchTaskPage: vi.fn(),
    } as unknown as TaskBackend;

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject({ taskSource: 'yaml' })],
      resolveBackend: () => yamlBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(yamlBackend.fetchReadyTasks).not.toHaveBeenCalled();
  });

  // ── Concurrency cap race-condition regression tests ──────────────────────────

  it('cap=1 with N≥2 eligible candidates: pollOnce() launches exactly one session', async () => {
    runtimeSettings.auto_launch_concurrency = 1;
    const sm = makeMockSessionManager();
    const backend = makeMockBackend([
      makeResolved(makeTask({ id: 'a', title: 'Task A' })),
      makeResolved(makeTask({ id: 'b', title: 'Task B' })),
      makeResolved(makeTask({ id: 'c', title: 'Task C' })),
    ]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).toHaveBeenCalledTimes(1);
  });

  it('cap=3 with 5 eligible candidates: pollOnce() launches exactly 3 sessions', async () => {
    runtimeSettings.auto_launch_concurrency = 3;
    const sm = makeMockSessionManager();
    const backend = makeMockBackend([
      makeResolved(makeTask({ id: 'a' })),
      makeResolved(makeTask({ id: 'b' })),
      makeResolved(makeTask({ id: 'c' })),
      makeResolved(makeTask({ id: 'd' })),
      makeResolved(makeTask({ id: 'e' })),
    ]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    expect(
      (sm as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).toHaveBeenCalledTimes(3);
  });

  it('cap=3 with 5 candidates: second pollOnce() launches 0 more when no sessions ended', async () => {
    runtimeSettings.auto_launch_concurrency = 3;
    const sm = makeMockSessionManager();
    const backend = makeMockBackend([
      makeResolved(makeTask({ id: 'a' })),
      makeResolved(makeTask({ id: 'b' })),
      makeResolved(makeTask({ id: 'c' })),
      makeResolved(makeTask({ id: 'd' })),
      makeResolved(makeTask({ id: 'e' })),
    ]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    const startMock = (sm as unknown as { start: ReturnType<typeof vi.fn> })
      .start;
    expect(startMock).toHaveBeenCalledTimes(3);

    // Second poll — cap is already full, no new launches
    await launcher.pollOnce();
    expect(startMock).toHaveBeenCalledTimes(3);
  });

  it('after the first session ends, the next poll cycle launches the next candidate', async () => {
    runtimeSettings.auto_launch_concurrency = 1;

    // Inline mock so we can decrement liveCount to simulate session end
    let liveCount = 0;
    const sm = new EventEmitter() as unknown as SessionManager;
    const startMock = vi.fn(() => {
      liveCount++;
      return `session-${liveCount}`;
    });
    (sm as unknown as Record<string, unknown>).start = startMock;
    (sm as unknown as Record<string, unknown>).getLiveCodeSessionCount = vi.fn(
      () => liveCount,
    );
    (sm as unknown as Record<string, unknown>).hasLiveSessionForTask = vi.fn(
      () => false,
    );

    const backend = makeMockBackend([
      makeResolved(makeTask({ id: 'first' })),
      makeResolved(makeTask({ id: 'second' })),
    ]);

    const launcher = new AutoLauncher(sm, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    // First poll — launches one session (liveCount becomes 1)
    await launcher.pollOnce();
    expect(startMock).toHaveBeenCalledTimes(1);

    // Simulate session ending — slot opens
    liveCount--;

    // Second poll — cap opens, launches the next candidate
    await launcher.pollOnce();
    expect(startMock).toHaveBeenCalledTimes(2);
  });
});
