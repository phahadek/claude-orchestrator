import { describe, it, expect } from 'vitest';
import {
  computeMilestoneDependencyCandidates,
  MilestoneDependencyGraphTaskInput,
} from '../milestoneDependencyGraph';

describe('computeMilestoneDependencyCandidates', () => {
  it('unions region-overlap candidates with existing Depends On edges', () => {
    const tasks: MilestoneDependencyGraphTaskInput[] = [
      {
        id: 'task-1',
        status: '🗂️ Ready',
        dependsOn: [],
        regions: {
          packages: ['packages/backend/src/orchestration'],
          files: ['packages/backend/src/orchestration/Scheduler.ts'],
        },
      },
      {
        id: 'task-2',
        status: '🗂️ Ready',
        dependsOn: [],
        regions: {
          packages: ['packages/backend/src/orchestration'],
          files: ['packages/backend/src/orchestration/Scheduler.ts'],
        },
      },
      {
        id: 'task-3',
        status: '🔲 Backlog',
        // declares a dep on task-1 even though their regions don't overlap
        dependsOn: ['task-1'],
        regions: {
          packages: ['packages/frontend/src/components'],
          files: [],
        },
      },
      {
        id: 'task-4',
        status: '✅ Done',
        dependsOn: [],
        regions: {
          packages: ['packages/backend/src/orchestration'],
          files: [],
        },
      },
    ];

    const result = computeMilestoneDependencyCandidates(tasks);

    // Done tasks are excluded as subjects entirely.
    expect(result.map((r) => r.taskId).sort()).toEqual([
      'task-1',
      'task-2',
      'task-3',
    ]);

    const t1 = result.find((r) => r.taskId === 'task-1')!;
    expect(t1.declaredDeps).toEqual([]);
    // task-3 declares a dep ON task-1, not the reverse, so it must not show
    // up as a candidate blocker of task-1 — candidateBlockers is directional.
    expect(t1.candidateBlockers).toEqual([
      {
        taskId: 'task-2',
        reason:
          'shared package(s): packages/backend/src/orchestration; shared file(s): packages/backend/src/orchestration/Scheduler.ts',
      },
    ]);

    const t3 = result.find((r) => r.taskId === 'task-3')!;
    expect(t3.declaredDeps).toEqual(['task-1']);
    expect(t3.candidateBlockers).toEqual([
      { taskId: 'task-1', reason: 'declared dependency' },
    ]);

    // task-4 is Done, so it must never appear as a candidate blocker even
    // though its region overlaps task-1/task-2.
    for (const r of result) {
      expect(r.candidateBlockers.some((b) => b.taskId === 'task-4')).toBe(
        false,
      );
    }
  });

  it('returns declared deps verbatim, including deps outside the input set', () => {
    const tasks: MilestoneDependencyGraphTaskInput[] = [
      {
        id: 'task-1',
        status: '🔲 Backlog',
        dependsOn: ['external-task-not-in-milestone'],
        regions: { packages: [], files: [] },
      },
    ];

    const result = computeMilestoneDependencyCandidates(tasks);
    expect(result).toEqual([
      {
        taskId: 'task-1',
        candidateBlockers: [],
        declaredDeps: ['external-task-not-in-milestone'],
      },
    ]);
  });

  it('yields no region-overlap candidates for a task with unparseable Files / paths affected, without erroring', () => {
    const tasks: MilestoneDependencyGraphTaskInput[] = [
      {
        id: 'task-1',
        status: '🔲 Backlog',
        dependsOn: [],
        regions: { packages: [], files: [] },
      },
      {
        id: 'task-2',
        status: '🔲 Backlog',
        dependsOn: [],
        regions: { packages: [], files: [] },
      },
    ];

    expect(() => computeMilestoneDependencyCandidates(tasks)).not.toThrow();
    const result = computeMilestoneDependencyCandidates(tasks);
    expect(result).toEqual([
      { taskId: 'task-1', candidateBlockers: [], declaredDeps: [] },
      { taskId: 'task-2', candidateBlockers: [], declaredDeps: [] },
    ]);
  });

  it('matches declared deps and region overlap across dashed/dashless id formats', () => {
    const tasks: MilestoneDependencyGraphTaskInput[] = [
      {
        id: '39a22f91-52f3-8196-afc4-c934ae698699',
        status: '🗂️ Ready',
        dependsOn: [],
        regions: { packages: [], files: [] },
      },
      {
        id: 'task-2',
        status: '🔲 Backlog',
        dependsOn: ['39a22f9152f38196afc4c934ae698699'],
        regions: { packages: [], files: [] },
      },
    ];

    const result = computeMilestoneDependencyCandidates(tasks);
    const t2 = result.find((r) => r.taskId === 'task-2')!;
    expect(t2.candidateBlockers).toEqual([
      {
        taskId: '39a22f91-52f3-8196-afc4-c934ae698699',
        reason: 'declared dependency',
      },
    ]);
  });
});
