import { describe, it, expect } from 'vitest';
import {
  admitTargetedRetest,
  classifyTestRunOutcome,
  expandTargetedCommand,
  resolveTargetedCommands,
  TARGETED_RETEST_MAX_IDS,
} from '../testRequestLane';
import { testRequestRunSatisfiesGate } from '../../session/AgentSession';
import type { TestRequestRunRow } from '../../db/types';

const baseSpec = {
  projectId: 'proj-1',
  contentHash: 'hash-1',
  worktreePath: '/tmp/none',
  timeoutSec: 60,
  maxRssMb: 0,
  sessionId: null,
  runOrigin: null,
  producer: 'session_test_request',
} as unknown as Parameters<typeof admitTargetedRetest>[0];

function makeRun(overrides: Partial<TestRequestRunRow>): TestRequestRunRow {
  return {
    id: 'run-1',
    project_id: 'proj-1',
    content_hash: 'hash-1',
    session_id: 's',
    state: 'passed',
    output: '',
    requested_at: 1,
    started_at: 1,
    finished_at: 2,
    structured_result: null,
    failure_reason: null,
    concurrent_run_count: 0,
    oom_killed: 0,
    ...overrides,
  } as TestRequestRunRow;
}

describe('targeted retest lane', () => {
  it('expands {{test_ids}} with shell-quoted ids', () => {
    expect(expandTargetedCommand('pytest {{test_ids}}', ['a::b', "c'd"])).toBe(
      "pytest 'a::b' 'c'\\''d'",
    );
  });

  it('refuses a request over the id cap rather than truncating', () => {
    const testIds = Array.from(
      { length: TARGETED_RETEST_MAX_IDS + 1 },
      (_, i) => `t${i}`,
    );
    const r = admitTargetedRetest({
      ...baseSpec,
      testIds,
      targetedCommands: ['pytest {{test_ids}}'],
    });
    expect(r).toEqual({ ok: false, reason: 'too_many_test_ids' });
  });

  it('refuses an empty id set', () => {
    const r = admitTargetedRetest({
      ...baseSpec,
      testIds: [],
      targetedCommands: ['pytest {{test_ids}}'],
    });
    expect(r).toEqual({ ok: false, reason: 'no_test_ids' });
  });

  it('returns no targeted command when the project has no template', () => {
    expect(resolveTargetedCommands({ test_targeted: [] })).toBeNull();
  });

  it('never lets a targeted run satisfy the PR-creation gate', () => {
    expect(testRequestRunSatisfiesGate(makeRun({ run_kind: 'targeted' }))).toBe(
      false,
    );
    expect(testRequestRunSatisfiesGate(makeRun({ run_kind: 'full' }))).toBe(
      true,
    );
  });

  it('classifies a passed targeted run as passed-targeted', () => {
    expect(
      classifyTestRunOutcome(makeRun({ run_kind: 'targeted' })).outcome,
    ).toBe('passed-targeted');
  });
});
