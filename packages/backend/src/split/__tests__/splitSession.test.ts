import { describe, it, expect } from 'vitest';
import { composeSplitIntents, ORIGINAL_REF } from '../splitSession';
import type { TaskBodySections } from '../../tasks/bodyRender';

function sections(summary: string): TaskBodySections {
  return {
    summary,
    dependencies: [],
    context: [],
    automatedCriteria: ['passes'],
    manualCriteria: [],
  };
}

describe('composeSplitIntents', () => {
  it('stages updateBody on the original + N-1 createTask + intra-split setDependsOn, and populates size_check.split_into', () => {
    const result = composeSplitIntents({
      projectId: 'proj-1',
      original: {
        id: 'notion:original-id',
        sections: sections('Narrowed to subset A'),
      },
      siblings: [
        {
          ref: 'sibling-1',
          fields: { databaseId: 'db-1', title: 'Subset B' },
        },
        {
          ref: 'sibling-2',
          fields: { databaseId: 'db-1', title: 'Subset C' },
          dependsOn: ['sibling-1', ORIGINAL_REF],
        },
      ],
    });

    // The original ID is unchanged — updateBody, not a new task.
    const updateBodyIntent = result.intents.find(
      (i) => i.kind === 'task.updateBody',
    );
    expect(updateBodyIntent).toBeDefined();
    expect(
      (updateBodyIntent!.payload as { taskId: string }).taskId,
    ).toBe('notion:original-id');
    expect(
      (updateBodyIntent!.payload as { sections: TaskBodySections }).sections
        .summary,
    ).toBe('Narrowed to subset A');

    // N-1 createTask intents, at Backlog (createTask fields never carry status).
    const createIntents = result.intents.filter(
      (i) => i.kind === 'task.create',
    );
    expect(createIntents).toHaveLength(2);
    expect(createIntents.map((i) => (i.payload as { title: string }).title)).toEqual(
      ['Subset B', 'Subset C'],
    );

    // Intra-split setDependsOn — only sibling-2 declared deps.
    const dependsOnIntents = result.intents.filter(
      (i) => i.kind === 'task.setDependsOn',
    );
    expect(dependsOnIntents).toHaveLength(1);
    const dependsOnPayload = dependsOnIntents[0].payload as {
      taskId: string;
      dependsOn: string[];
    };
    expect(dependsOnPayload.taskId).toBe('$ref:sibling-2');
    expect(dependsOnPayload.dependsOn).toEqual([
      '$ref:sibling-1',
      'notion:original-id',
    ]);

    // size_check.split_into populated with the new sibling refs.
    expect(result.sizeCheck).toEqual({
      decision: 'split_now',
      splitInto: ['$ref:sibling-1', '$ref:sibling-2'],
    });

    // All intents share one groupId so the display can present them as one unit.
    const groupIds = new Set(result.intents.map((i) => i.groupId));
    expect(groupIds.size).toBe(1);
  });

  it('throws when there are no siblings (a split needs at least one sibling)', () => {
    expect(() =>
      composeSplitIntents({
        projectId: 'proj-1',
        original: { id: 'notion:original-id', sections: sections('x') },
        siblings: [],
      }),
    ).toThrow(/at least one sibling/);
  });

  it('rejects a sibling ref that collides with the reserved original ref', () => {
    expect(() =>
      composeSplitIntents({
        projectId: 'proj-1',
        original: { id: 'notion:original-id', sections: sections('x') },
        siblings: [{ ref: ORIGINAL_REF, fields: { databaseId: 'db-1', title: 'x' } }],
      }),
    ).toThrow(/reserved/);
  });
});
