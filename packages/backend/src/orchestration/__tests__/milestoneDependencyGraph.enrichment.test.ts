import { describe, it, expect } from 'vitest';
import { computeMilestoneDependencyCandidates } from '../milestoneDependencyGraph';

const empty = { packages: [], files: [] };

describe('computeMilestoneDependencyCandidates enrichment', () => {
  it('carries title/type/status and ranks shared-file above shared-package-only', () => {
    const [subject] = computeMilestoneDependencyCandidates([
      {
        id: 'a',
        status: '🔲 Backlog',
        dependsOn: [],
        regions: { packages: ['pkg/x'], files: ['pkg/x/f.ts'] },
      },
      {
        id: 'b',
        title: 'Package only',
        type: '💻 Code',
        status: '🗂️ Ready',
        dependsOn: [],
        regions: { packages: ['pkg/x'], files: [] },
      },
      {
        id: 'c',
        title: 'Shares file',
        type: '💻 Code',
        status: '🔲 Backlog',
        dependsOn: [],
        regions: { packages: ['pkg/x'], files: ['pkg/x/f.ts'] },
      },
    ]);
    expect(subject.candidateBlockers.map((c) => c.taskId)).toEqual(['c', 'b']);
    expect(subject.candidateBlockers[0]).toMatchObject({
      title: 'Shares file',
      type: '💻 Code',
      status: '🔲 Backlog',
    });
  });

  it('adds body-named tasks and staged siblings with reasons naming their source', () => {
    const [subject] = computeMilestoneDependencyCandidates(
      [
        {
          id: 'a',
          status: '🔲 Backlog',
          dependsOn: [],
          regions: empty,
          mentionedTaskIds: ['b'],
        },
        { id: 'b', status: '🔲 Backlog', dependsOn: [], regions: empty },
      ],
      [{ id: 'staged-intent:s1', title: 'Sibling', type: '💻 Code' }],
    );
    const byId = Object.fromEntries(
      subject.candidateBlockers.map((c) => [c.taskId, c]),
    );
    expect(byId['b'].reason).toContain('named in task body');
    expect(byId['staged-intent:s1'].reason).toContain('same group or batch');
  });
});
