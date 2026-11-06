import { describe, it, expect } from 'vitest';
import {
  insertTestRequestRun,
  ingestTestRunResultsTx,
  computeTestFailureBreadthFlag,
} from '../../db/queries';
import { normalizeFailureMessage } from '../failureSignature';

const OWN = { sessionIds: [], worktreePaths: ['/wt/own'] };

function seedOtherOrigins(
  project: string,
  testId: string,
  messages: Array<string | undefined>,
): void {
  messages.forEach((failureMessage, i) => {
    const id = `run-${project}-${i}`;
    insertTestRequestRun(
      id,
      project,
      `hash-${project}-${i}`,
      null,
      Date.now(),
      null,
      undefined,
      null,
      'running',
      'full',
      null,
      `/wt/other-${project}-${i}`,
    );
    ingestTestRunResultsTx(
      id,
      project,
      [
        {
          test_id: testId,
          name: 'x',
          outcome: 'failed',
          duration_ms: 1,
          failureMessage,
        },
      ],
      null,
      false,
      false,
    );
  });
}

const flag = (testId: string, subject: string | null) =>
  computeTestFailureBreadthFlag(testId, 24, 3, Date.now() + 1000, OWN, subject)
    .flagged;

describe('normalizeFailureMessage', () => {
  it('keeps asserted literals, small integers included', () => {
    expect(normalizeFailureMessage('Unexpected [183]')).not.toBe(
      normalizeFailureMessage('Unexpected [184]'),
    );
  });

  it('strips hashes, paths, durations, timestamps, addresses and line:col', () => {
    const a =
      'Unexpected [183] at /tmp/abc123/src/x.ts:10:5 after 120ms (a1b2c3d4e5f6) 2026-01-01T10:00:00Z 0xdeadbeef01';
    const b =
      'Unexpected [183] at /home/u/other/src/x.ts:99:1 after 3.5s (0f9e8d7c6b5a) 2026-02-02T11:11:11Z 0x1234567890';
    expect(normalizeFailureMessage(a)).toBe(normalizeFailureMessage(b));
  });
});

describe('signature-matched breadth', () => {
  it('does not excuse a subject whose literal differs from the fleet', () => {
    seedOtherOrigins('sig-diff', 't.a', [
      'Unexpected [184]',
      'Unexpected [184]',
      'Unexpected [184]',
    ]);
    expect(flag('t.a', 'Unexpected [183]')).toBe(false);
    expect(flag('t.a', 'Unexpected [184]')).toBe(true);
  });

  it('excuses when the fleet differs only in volatile tokens', () => {
    seedOtherOrigins('sig-vol', 't.b', [
      'Unexpected [183] at /tmp/aa/x.ts:1:2 in 10ms',
      'Unexpected [183] at /tmp/bb/x.ts:3:4 in 25ms',
      'Unexpected [183] at /var/cc/x.ts:5:6 in 7ms',
    ]);
    expect(flag('t.b', 'Unexpected [183] at /tmp/zz/x.ts:9:9 in 99ms')).toBe(
      true,
    );
  });

  it('message-less rows are not evidence for a subject with a message', () => {
    seedOtherOrigins('sig-null', 't.c', [undefined, undefined, undefined]);
    expect(flag('t.c', 'Unexpected [183]')).toBe(false);
  });

  it('a message-less subject keeps test_id-only counting', () => {
    seedOtherOrigins('sig-any', 't.d', ['x', undefined, 'y']);
    expect(flag('t.d', null)).toBe(true);
    expect(flag('t.d', '')).toBe(true);
  });
});
