import { describe, it, expect } from 'vitest';
import {
  evaluateCodeAutoApprove,
  extractDeclaredPaths,
  memberTaskId,
  type CodeAutoApproveInput,
} from '../codeAutoApprove';
import { extractPathToken } from '../groomLoad';

function eligibleInput(): CodeAutoApproveInput {
  return {
    taskId: 'abc123',
    groomingGate: {
      size_check: { decision: 'no_split', loc: 120, files: 3 },
      seam_check: { decision: 'single_seam', seams: [] },
    },
    readinessAndGatePass: true,
    sessionStagedPickOne: false,
    members: [
      { kind: 'task.setDependsOn', taskId: 'abc123' },
      { kind: 'task.updateBody', taskId: 'abc123' },
      { kind: 'task.setStatus', taskId: 'abc123' },
    ],
    touchedPaths: ['packages/backend/src/foo.ts'],
    proposedDependsOn: ['dep1', 'dep2'],
    currentDependsOn: ['dep1'],
    tripwire: { matched: false, matches: [], version: 1 },
  };
}

function failedIds(input: CodeAutoApproveInput): string[] {
  return evaluateCodeAutoApprove(input)
    .conditions.filter((c) => !c.passed)
    .map((c) => c.id);
}

describe('evaluateCodeAutoApprove', () => {
  it('passes a fully eligible group', () => {
    const v = evaluateCodeAutoApprove(eligibleInput());
    expect(v.eligible).toBe(true);
    expect(failedIds(eligibleInput())).toEqual([]);
  });

  it('condition 1: fails on readiness/gate failure or unknown', () => {
    expect(
      failedIds({ ...eligibleInput(), readinessAndGatePass: false }),
    ).toEqual(['readiness_and_gate']);
    expect(
      failedIds({ ...eligibleInput(), readinessAndGatePass: null }),
    ).toEqual(['readiness_and_gate']);
  });

  it('condition 2: fails when the session staged a pickOne or it is unknown', () => {
    expect(
      failedIds({ ...eligibleInput(), sessionStagedPickOne: true }),
    ).toEqual(['no_decision_pick_one']);
    expect(
      failedIds({ ...eligibleInput(), sessionStagedPickOne: null }),
    ).toEqual(['no_decision_pick_one']);
  });

  it.each([
    ['split decision', { decision: 'split_now', loc: 10, files: 1 }],
    ['loc over 400', { decision: 'no_split', loc: 401, files: 1 }],
    ['files over 10', { decision: 'no_split', loc: 10, files: 11 }],
    ['missing loc', { decision: 'no_split', files: 1 }],
    ['non-numeric files', { decision: 'no_split', loc: 10, files: '3' }],
  ])('condition 3: fails on %s', (_name, size_check) => {
    const input = eligibleInput();
    input.groomingGate = { ...input.groomingGate, size_check };
    expect(failedIds(input)).toEqual(['size']);
  });

  it('condition 3: passes at the exact boundaries', () => {
    const input = eligibleInput();
    input.groomingGate = {
      ...input.groomingGate,
      size_check: { decision: 'no_split', loc: 400, files: 10 },
    };
    expect(failedIds(input)).toEqual([]);
  });

  it.each([
    ['missing seam_check', null],
    ['split_now', { decision: 'split_now', seams: [] }],
    [
      'cohesive with 3 seams',
      {
        decision: 'cohesive',
        seams: [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }],
      },
    ],
    [
      'cohesive with a schema seam',
      { decision: 'cohesive', seams: [{ kind: 'schema' }] },
    ],
    ['malformed seams', { decision: 'cohesive', seams: 'x' }],
  ])('condition 4: fails on %s', (_name, seam_check) => {
    const input = eligibleInput();
    input.groomingGate = { ...input.groomingGate, seam_check };
    expect(failedIds(input)).toEqual(['seams']);
  });

  it('condition 4: passes cohesive with 2 non-schema seams', () => {
    const input = eligibleInput();
    input.groomingGate = {
      ...input.groomingGate,
      seam_check: {
        decision: 'cohesive',
        seams: [{ kind: 'api' }, { kind: 'ui' }],
      },
    };
    expect(failedIds(input)).toEqual([]);
  });

  it('condition 5: fails on a migration path or unknown paths', () => {
    expect(
      failedIds({
        ...eligibleInput(),
        touchedPaths: ['packages/backend/src/db/migrations/0042.sql'],
      }),
    ).toEqual(['no_migration_path']);
    expect(failedIds({ ...eligibleInput(), touchedPaths: null })).toEqual([
      'no_migration_path',
    ]);
    expect(failedIds({ ...eligibleInput(), touchedPaths: [] })).toEqual([
      'no_migration_path',
    ]);
  });

  it.each([
    ['a task.create member', { kind: 'task.create', taskId: 'abc123' }],
    ['a decision.pickOne member', { kind: 'decision.pickOne', taskId: null }],
    ['a member on another task', { kind: 'task.setProperties', taskId: 'zzz' }],
    [
      'a member with an unknown task',
      { kind: 'task.updateBody', taskId: null },
    ],
  ])('condition 6: fails with %s', (_name, extra) => {
    const input = eligibleInput();
    input.members = [...input.members, extra];
    expect(failedIds(input)).toEqual(['member_kinds_single_task']);
  });

  it('condition 6: passes a realistic group with gate.accrete and seed.stage on the same task', () => {
    const input = eligibleInput();
    input.members = [
      { kind: 'task.setStatus', taskId: 'abc123' },
      { kind: 'task.setDependsOn', taskId: 'abc123' },
      { kind: 'task.patchBodySection', taskId: 'abc123' },
      { kind: 'gate.accrete', taskId: 'abc-123' },
      { kind: 'seed.stage', taskId: 'abc123' },
    ];
    expect(failedIds(input)).toEqual([]);
  });

  it.each([
    ['gate.accrete on another task', { kind: 'gate.accrete', taskId: 'zzz' }],
    ['seed.stage on another task', { kind: 'seed.stage', taskId: 'zzz' }],
    ['a seed.stage with no task', { kind: 'seed.stage', taskId: null }],
    ['a task.setType member', { kind: 'task.setType', taskId: 'abc123' }],
    [
      'an arch.createUnit member',
      { kind: 'arch.createUnit', taskId: 'abc123' },
    ],
    ['an arch.updateUnit member', { kind: 'arch.updateUnit', taskId: null }],
  ])('condition 6: fails with %s', (_name, extra) => {
    const input = eligibleInput();
    input.members = [
      ...input.members,
      { kind: 'gate.accrete', taskId: 'abc123' },
      extra,
    ];
    expect(failedIds(input)).toEqual(['member_kinds_single_task']);
  });

  it('memberTaskId reads sourceTask.id only for accretion kinds', () => {
    const payload = { sourceTask: { id: 'abc123' } };
    expect(memberTaskId('gate.accrete', payload)).toBe('abc123');
    expect(memberTaskId('seed.stage', payload)).toBe('abc123');
    expect(memberTaskId('task.setStatus', payload)).toBeNull();
    expect(memberTaskId('task.setStatus', { taskId: 't' })).toBe('t');
    expect(memberTaskId('gate.accrete', null)).toBeNull();
  });

  it('condition 7: fails when an existing dependency edge is removed or current is unknown', () => {
    expect(
      failedIds({
        ...eligibleInput(),
        proposedDependsOn: ['dep2'],
        currentDependsOn: ['dep1'],
      }),
    ).toEqual(['depends_on_superset']);
    expect(failedIds({ ...eligibleInput(), currentDependsOn: null })).toEqual([
      'depends_on_superset',
    ]);
  });

  it('condition 7: dependency comparison ignores id dashes', () => {
    expect(
      failedIds({
        ...eligibleInput(),
        proposedDependsOn: ['aaaa-bbbb'],
        currentDependsOn: ['aaaabbbb'],
      }),
    ).toEqual([]);
  });

  it('condition 8: fails on a tripwire match or an unevaluated tripwire', () => {
    expect(
      failedIds({
        ...eligibleInput(),
        tripwire: {
          matched: true,
          matches: [
            { class: 'auth', term: 'token', source: 'body', where: 'x' },
          ],
          version: 1,
        },
      }),
    ).toEqual(['tripwire_clear']);
    expect(failedIds({ ...eligibleInput(), tripwire: null })).toEqual([
      'tripwire_clear',
    ]);
  });
});

describe('extractDeclaredPaths', () => {
  it('reads path tokens from the Files / paths affected section only', () => {
    const body = [
      '## Summary',
      '- `not/a/path.ts`',
      '## Files / paths affected',
      '- packages/backend/src/a.ts',
      '- `packages/backend/src/db/migrations/1.sql` (new)',
      '## Acceptance criteria',
      '- `other/file.ts`',
    ].join('\n');
    expect(extractDeclaredPaths(body, extractPathToken)).toEqual([
      'packages/backend/src/a.ts',
      'packages/backend/src/db/migrations/1.sql',
    ]);
  });

  it('returns null when the section is absent', () => {
    expect(extractDeclaredPaths('## Summary\nx', extractPathToken)).toBeNull();
  });

  it('reads paths from a "## Files affected" heading', () => {
    const body = [
      '## Summary',
      'x',
      '## Files affected',
      '- packages/backend/src/a.ts',
      '- `packages/backend/src/b.ts` (update)',
      '## Acceptance criteria',
      '- `other/file.ts`',
    ].join('\n');
    expect(extractDeclaredPaths(body, extractPathToken)).toEqual([
      'packages/backend/src/a.ts',
      'packages/backend/src/b.ts',
    ]);
  });

  it('returns null when only a non-prefix (shadowing) heading mentions files', () => {
    const body = ['## Context', '### Notes on files', '- packages/a.ts'].join(
      '\n',
    );
    expect(extractDeclaredPaths(body, extractPathToken)).toBeNull();
  });

  it('feeds no_migration_path from a "## Files affected" body', () => {
    const run = (line: string) =>
      failedIds({
        ...eligibleInput(),
        touchedPaths: extractDeclaredPaths(
          `## Files affected\n- ${line}`,
          extractPathToken,
        ),
      });
    expect(run('packages/backend/src/db/migrations/0042.sql')).toEqual([
      'no_migration_path',
    ]);
    expect(run('packages/backend/src/foo.ts')).toEqual([]);
  });
});
