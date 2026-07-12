import { describe, it, expect } from 'vitest';
import { planMerge, type MergeTaskContent, type MergeGraphTask } from '../mergeSession';
import type { TaskBodySections } from '../../tasks/bodyRender';

function sections(overrides: Partial<TaskBodySections> = {}): TaskBodySections {
  return {
    summary: 'summary',
    dependencies: [],
    context: [],
    automatedCriteria: [],
    manualCriteria: [],
    ...overrides,
  };
}

describe('planMerge', () => {
  it('stages a survivor union (updateBody + setProperties), an archive per merged-away task, and re-points every prior dependent at the survivor with no dangling reference', () => {
    const a: MergeTaskContent = {
      id: 'notion:a',
      dependsOn: [],
      priority: '🟡 Medium',
      sections: sections({
        summary: 'Task A summary',
        automatedCriteria: ['a1'],
        filesAffected: ['src/a.ts'],
      }),
    };
    const b: MergeTaskContent = {
      id: 'notion:b',
      dependsOn: [],
      priority: '🔴 High',
      sections: sections({
        summary: 'Task B summary',
        automatedCriteria: ['b1'],
        filesAffected: ['src/b.ts'],
      }),
    };
    const dependent1: MergeGraphTask = {
      id: 'notion:dep1',
      dependsOn: ['notion:b'],
    };
    const dependent2: MergeGraphTask = {
      id: 'notion:dep2',
      dependsOn: ['notion:b', 'notion:other'],
    };
    // Depends on both merged-away tasks — must collapse to a single survivor ref.
    const dependentBoth: MergeGraphTask = {
      id: 'notion:dep3',
      dependsOn: ['notion:a', 'notion:b'],
    };
    const unrelated: MergeGraphTask = {
      id: 'notion:unrelated',
      dependsOn: ['notion:other'],
    };

    const milestoneTasks = [a, b, dependent1, dependent2, dependentBoth, unrelated];

    const plan = planMerge({
      milestoneTasks,
      mergeSet: [a, b],
      survivorId: 'notion:a',
    });

    expect(plan.survivorId).toBe('notion:a');
    expect(plan.mergedAwayIds).toEqual(['notion:b']);

    const updateBody = plan.intents.find((i) => i.kind === 'task.updateBody');
    expect(updateBody?.payload).toMatchObject({ taskId: 'notion:a' });
    const unionedSummary = (updateBody?.payload as { sections: TaskBodySections })
      .sections.summary;
    expect(unionedSummary).toContain('Task A summary');
    expect(unionedSummary).toContain('Task B summary');
    const unionedCriteria = (updateBody?.payload as { sections: TaskBodySections })
      .sections.automatedCriteria;
    expect(unionedCriteria).toEqual(['a1', 'b1']);
    const unionedFiles = (updateBody?.payload as { sections: TaskBodySections })
      .sections.filesAffected;
    expect(unionedFiles).toEqual(['src/a.ts', 'src/b.ts']);

    const setProperties = plan.intents.find((i) => i.kind === 'task.setProperties');
    expect(setProperties?.payload).toEqual({
      taskId: 'notion:a',
      patch: { priority: '🔴 High' },
    });

    const archives = plan.intents.filter((i) => i.kind === 'task.archive');
    expect(archives).toEqual([
      { kind: 'task.archive', payload: { taskId: 'notion:b' } },
    ]);

    const rewrites = plan.intents.filter((i) => i.kind === 'task.setDependsOn');
    const rewriteFor = (taskId: string) =>
      rewrites.find((r) => (r.payload as { taskId: string }).taskId === taskId)
        ?.payload;

    expect(rewriteFor('notion:dep1')).toEqual({
      taskId: 'notion:dep1',
      dependsOn: ['notion:a'],
    });
    expect(rewriteFor('notion:dep2')).toEqual({
      taskId: 'notion:dep2',
      dependsOn: ['notion:a', 'notion:other'],
    });
    expect(rewriteFor('notion:dep3')).toEqual({
      taskId: 'notion:dep3',
      dependsOn: ['notion:a'],
    });
    expect(rewriteFor('notion:unrelated')).toBeUndefined();

    // No intent leaves a dangling reference to the merged-away task.
    for (const intent of plan.intents) {
      if (intent.kind === 'task.setDependsOn') {
        expect(intent.payload.dependsOn).not.toContain('notion:b');
      }
    }
  });

  it('defaults the survivor to the most-inbound-referenced task, and honors an explicit operator override', () => {
    const a: MergeTaskContent = {
      id: 'notion:a',
      dependsOn: [],
      sections: sections({ summary: 'A' }),
    };
    const b: MergeTaskContent = {
      id: 'notion:b',
      dependsOn: [],
      sections: sections({ summary: 'B' }),
    };
    const dep1: MergeGraphTask = { id: 'notion:dep1', dependsOn: ['notion:b'] };
    const dep2: MergeGraphTask = { id: 'notion:dep2', dependsOn: ['notion:b'] };
    const dep3: MergeGraphTask = { id: 'notion:dep3', dependsOn: ['notion:a'] };

    const milestoneTasks = [a, b, dep1, dep2, dep3];

    const defaultPlan = planMerge({ milestoneTasks, mergeSet: [a, b] });
    expect(defaultPlan.survivorId).toBe('notion:b');
    expect(defaultPlan.mergedAwayIds).toEqual(['notion:a']);

    const overriddenPlan = planMerge({
      milestoneTasks,
      mergeSet: [a, b],
      survivorId: 'notion:a',
    });
    expect(overriddenPlan.survivorId).toBe('notion:a');
    expect(overriddenPlan.mergedAwayIds).toEqual(['notion:b']);
  });

  it('rejects a survivorId that is not a member of the merge set', () => {
    const a: MergeTaskContent = {
      id: 'notion:a',
      dependsOn: [],
      sections: sections(),
    };
    const b: MergeTaskContent = {
      id: 'notion:b',
      dependsOn: [],
      sections: sections(),
    };
    expect(() =>
      planMerge({
        milestoneTasks: [a, b],
        mergeSet: [a, b],
        survivorId: 'notion:not-in-set',
      }),
    ).toThrow();
  });
});
