import { describe, it, expect } from 'vitest';
import {
  computeMergeCandidates,
  MergeCandidateTaskInput,
} from '../mergeCandidates';

function task(
  id: string,
  files: string[],
  opts: { status?: string; packages?: string[] } = {},
): MergeCandidateTaskInput {
  return {
    id,
    status: opts.status ?? '🗂️ Ready',
    regions: { packages: opts.packages ?? [], files },
  };
}

describe('computeMergeCandidates', () => {
  it.each([
    // 2 shared / min(2, 3) = 0.67 >= 0.5 -> trips
    {
      filesA: ['a.ts', 'b.ts'],
      filesB: ['a.ts', 'b.ts', 'c.ts'],
      expectTrip: true,
    },
    // 1 shared / min(3, 3) = 0.33 < 0.5 -> does not trip
    {
      filesA: ['a.ts', 'x.ts', 'y.ts'],
      filesB: ['a.ts', 'c.ts', 'd.ts'],
      expectTrip: false,
    },
    // 1 shared / min(2, 2) = 0.5 >= 0.5 -> trips (boundary, inclusive)
    {
      filesA: ['a.ts', 'x.ts'],
      filesB: ['a.ts', 'y.ts'],
      expectTrip: true,
    },
  ])(
    'containment ratio $filesA vs $filesB trips=$expectTrip',
    ({ filesA, filesB, expectTrip }) => {
      const tasks = [task('task-1', filesA), task('task-2', filesB)];
      // hubFrequencyCutoff: 1 disables hub exclusion so this case isolates
      // the containment-ratio computation (with only 2 tasks, any file
      // shared between them is 100% of the pool and would otherwise be
      // excluded as a hub file by the default cutoff).
      const result = computeMergeCandidates(tasks, { hubFrequencyCutoff: 1 });
      if (expectTrip) {
        expect(result).toEqual([
          {
            taskIds: ['task-1', 'task-2'],
            reason: expect.stringContaining('shared file(s):'),
          },
        ]);
      } else {
        expect(result).toEqual([]);
      }
    },
  );

  it('excludes hub files (present in more than the cutoff fraction of tasks) before measuring overlap', () => {
    // hub.ts appears in all 8 tasks (100% > 25% cutoff) -> excluded.
    // a.ts appears in exactly 2/8 = 25% of tasks -> at the cutoff, not
    // excluded (the cutoff is an exclusive "more than" bound).
    const tasks = [
      task('task-1', ['hub.ts', 'a.ts']),
      task('task-2', ['hub.ts', 'a.ts']),
      task('task-3', ['hub.ts']),
      task('task-4', ['hub.ts']),
      task('task-5', ['hub.ts']),
      task('task-6', ['hub.ts']),
      task('task-7', ['hub.ts']),
      task('task-8', ['hub.ts']),
    ];

    const result = computeMergeCandidates(tasks);

    // task-1/task-2 still trip on the shared non-hub file a.ts.
    expect(result).toEqual([
      {
        taskIds: ['task-1', 'task-2'],
        reason: expect.stringContaining('a.ts'),
      },
    ]);
    // The hub file itself never appears in any surfaced reason.
    for (const c of result) {
      expect(c.reason).not.toContain('hub.ts');
    }
  });

  it('a hub file alone does not trip a pair once excluded', () => {
    const tasks = [
      task('task-1', ['hub.ts']),
      task('task-2', ['hub.ts']),
      task('task-3', ['hub.ts']),
      task('task-4', ['hub.ts']),
    ];
    expect(computeMergeCandidates(tasks)).toEqual([]);
  });

  it('produces symmetric pairwise candidates with no computed survivor', () => {
    const tasks = [
      task('task-b', ['a.ts', 'b.ts']),
      task('task-a', ['a.ts', 'b.ts']),
    ];
    const result = computeMergeCandidates(tasks, { hubFrequencyCutoff: 1 });
    expect(result).toHaveLength(1);
    // taskIds sorted for determinism regardless of input order; no survivorId field.
    expect(result[0].taskIds).toEqual(['task-a', 'task-b']);
    expect(result[0]).not.toHaveProperty('survivorId');
  });

  it('a task with no parseable Files / paths affected (empty files) produces no candidate', () => {
    const tasks = [task('task-1', []), task('task-2', ['a.ts', 'b.ts'])];
    expect(computeMergeCandidates(tasks)).toEqual([]);
  });

  it('shared-package-only pairs with no shared non-hub file do not trip', () => {
    const tasks = [
      task('task-1', ['a.ts'], { packages: ['packages/backend/src/foo'] }),
      task('task-2', ['b.ts'], { packages: ['packages/backend/src/foo'] }),
    ];
    expect(computeMergeCandidates(tasks)).toEqual([]);
  });

  it('excludes Done and Deferred tasks as both subjects and candidate pool', () => {
    const tasks = [
      task('task-1', ['a.ts', 'b.ts'], { status: '✅ Done' }),
      task('task-2', ['a.ts', 'b.ts'], { status: '⏭️ Deferred' }),
      task('task-3', ['a.ts', 'b.ts']),
    ];
    expect(computeMergeCandidates(tasks)).toEqual([]);
  });

  it('respects custom hubFrequencyCutoff and containmentThreshold options', () => {
    const tasks = [
      task('task-1', ['shared.ts', 'a.ts']),
      task('task-2', ['shared.ts', 'b.ts']),
      task('task-3', ['shared.ts']),
    ];
    // Default cutoff (0.25): shared.ts in 3/3 = 1.0 > 0.25 -> hub, excluded.
    expect(computeMergeCandidates(tasks)).toEqual([]);
    // Raise the cutoff so shared.ts is no longer treated as a hub file.
    const result = computeMergeCandidates(tasks, { hubFrequencyCutoff: 1 });
    expect(result).toContainEqual({
      taskIds: ['task-1', 'task-2'],
      reason: expect.stringContaining('shared.ts'),
    });
  });
});
