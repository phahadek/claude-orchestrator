import { describe, it, expect } from 'vitest';
import {
  evaluateCodeAutoApprove,
  extractTouchedPaths,
  type CodeAutoApproveInput,
} from '../codeAutoApprove';

const CLEAN_BODY = [
  '## Summary',
  'Tweak a label.',
  '## Files / paths affected',
  '- `packages/frontend/src/components/Label.tsx`',
  '## Acceptance criteria',
  '- renders',
].join('\n');

function eligibleInput(
  overrides: Partial<CodeAutoApproveInput> = {},
): CodeAutoApproveInput {
  return {
    taskType: '💻 Code',
    readinessAndGroomingGatePassed: true,
    sessionStagedDecisionPickOne: false,
    groomingGate: {
      size_check: { decision: 'no_split', loc: 120, files: 3 },
      seam_check: {
        decision: 'single_seam',
        seams: [{ kind: 'ui', what: 'x' }],
      },
    },
    body: CLEAN_BODY,
    members: [
      { kind: 'task.setStatus', taskId: 't-1' },
      { kind: 'task.updateBody', taskId: 't-1' },
      { kind: 'task.setDependsOn', taskId: 't-1' },
    ],
    proposedDependsOn: [['a', 'b']],
    currentDependsOn: ['a'],
    ...overrides,
  };
}

function failedIds(input: CodeAutoApproveInput): string[] {
  return evaluateCodeAutoApprove(input)
    .evidence.conditions.filter((c) => !c.passed)
    .map((c) => c.id);
}

describe('evaluateCodeAutoApprove', () => {
  it('is eligible when every condition holds, with evidence', () => {
    const result = evaluateCodeAutoApprove(eligibleInput());
    expect(result.eligible).toBe(true);
    expect(result.evidence.standard).toBe('code-auto-approve');
    expect(result.evidence.tripwireMatches).toEqual([]);
  });

  it('condition 1: fails when the readiness/grooming gate did not pass', () => {
    expect(
      failedIds(eligibleInput({ readinessAndGroomingGatePassed: false })),
    ).toEqual(['readiness_and_grooming_gate']);
  });

  it.each([true, null])(
    'condition 2: fails when decision.pickOne is %s',
    (value) => {
      expect(
        failedIds(eligibleInput({ sessionStagedDecisionPickOne: value })),
      ).toEqual(['no_decision_pick_one']);
    },
  );

  it.each([
    ['split_now', 120, 3],
    ['no_split', 401, 3],
    ['no_split', 120, 11],
    ['no_split', '120', 3],
    ['no_split', 120, undefined],
  ])('condition 3: fails for size_check %s/%s/%s', (decision, loc, files) => {
    const input = eligibleInput();
    input.groomingGate = {
      ...input.groomingGate,
      size_check: { decision, loc, files },
    };
    expect(failedIds(input)).toEqual(['size_check']);
  });

  it('condition 3: fails when size_check is missing', () => {
    const input = eligibleInput();
    input.groomingGate = { seam_check: input.groomingGate?.seam_check };
    expect(failedIds(input)).toEqual(['size_check']);
  });

  it.each([
    [{ decision: 'split_now', seams: [] }],
    [
      {
        decision: 'cohesive',
        seams: [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }],
      },
    ],
    [{ decision: 'cohesive', seams: [{ kind: 'schema' }] }],
    [{ decision: 'cohesive' }],
    [{ decision: 'single_seam', seams: [{ kind: 'schema' }] }],
  ])('condition 4: fails for seam_check %j', (seam_check) => {
    const input = eligibleInput();
    input.groomingGate = { ...input.groomingGate, seam_check };
    expect(failedIds(input)).toEqual(['seam_check']);
  });

  it('condition 4: accepts cohesive with two non-schema seams', () => {
    const input = eligibleInput();
    input.groomingGate = {
      ...input.groomingGate,
      seam_check: {
        decision: 'cohesive',
        seams: [{ kind: 'a' }, { kind: 'b' }],
      },
    };
    expect(evaluateCodeAutoApprove(input).eligible).toBe(true);
  });

  it('condition 5: fails when a touched path is a migration', () => {
    const body = CLEAN_BODY.replace(
      'packages/frontend/src/components/Label.tsx',
      'packages/backend/src/db/migrations/0042_x.sql',
    );
    expect(failedIds(eligibleInput({ body }))).toContain('no_migrations_path');
  });

  it('condition 5: fails closed when the body is unknown', () => {
    expect(failedIds(eligibleInput({ body: null }))).toEqual(
      expect.arrayContaining(['no_migrations_path', 'tripwire']),
    );
  });

  it.each([
    ['gate.accrete'],
    ['task.create'],
    ['task.setType'],
    ['decision.pickOne'],
  ])('condition 6: fails when a member is %s', (kind) => {
    const input = eligibleInput();
    input.members = [...input.members, { kind, taskId: 't-1' }];
    expect(failedIds(input)).toEqual(['member_kinds']);
  });

  it('condition 6: fails when members span two tasks', () => {
    const input = eligibleInput();
    input.members = [
      ...input.members,
      { kind: 'task.updateBody', taskId: 't-2' },
    ];
    expect(failedIds(input)).toEqual(['member_kinds']);
  });

  it('condition 7: fails when a Depends On edge is removed', () => {
    expect(
      failedIds(
        eligibleInput({ proposedDependsOn: [['b']], currentDependsOn: ['a'] }),
      ),
    ).toEqual(['depends_on_superset']);
  });

  it('condition 7: fails closed when the current Depends On is unknown', () => {
    expect(failedIds(eligibleInput({ currentDependsOn: null }))).toEqual([
      'depends_on_superset',
    ]);
  });

  it('condition 8: fails and records matches when the tripwire matches', () => {
    const body = `${CLEAN_BODY}\nAdds a retry with backoff.`;
    const result = evaluateCodeAutoApprove(eligibleInput({ body }));
    expect(result.eligible).toBe(false);
    expect(
      result.evidence.conditions.find((c) => c.id === 'tripwire')?.passed,
    ).toBe(false);
    expect(result.evidence.tripwireMatches.length).toBeGreaterThan(0);
  });

  it('is never eligible for a non-Code task', () => {
    expect(failedIds(eligibleInput({ taskType: '🔧 Tooling' }))).toContain(
      'is_code_task',
    );
  });
});

describe('extractTouchedPaths', () => {
  it('reads paths only from the Files / paths affected section', () => {
    expect(extractTouchedPaths(CLEAN_BODY)).toEqual([
      'packages/frontend/src/components/Label.tsx',
    ]);
  });
});
