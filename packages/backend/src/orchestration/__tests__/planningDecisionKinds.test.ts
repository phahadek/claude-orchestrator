import { describe, it, expect } from 'vitest';
import { hasStagedDecision } from '../planningDecisionKinds';
import type { StagedIntentRow } from '../../db/types';

function row(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  return {
    id: 'intent-1',
    kind: 'task.setStatus',
    payload: '{}',
    payload_hash: 'hash',
    task_id: null,
    project_id: 'proj-1',
    session_id: 'session-1',
    group_id: null,
    milestone: null,
    state: 'committed',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    investigation: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as StagedIntentRow;
}

describe('hasStagedDecision — gate.verify', () => {
  it('recognizes a staged gate.verify intent as a real decision', () => {
    expect(hasStagedDecision([row({ kind: 'gate.verify' })])).toBe(true);
  });

  it('is false when nothing decision-bearing has been staged', () => {
    expect(
      hasStagedDecision([row({ kind: 'session.requestCapability' })]),
    ).toBe(false);
    expect(hasStagedDecision([])).toBe(false);
  });

  it('is false for a withdrawn planning.noOp — a withdrawn marker is not evidence of a decision the session stands behind', () => {
    expect(
      hasStagedDecision([
        row({ kind: 'planning.noOp', state: 'withdrawn' }),
      ]),
    ).toBe(false);
  });

  it('is true for a committed planning.noOp', () => {
    expect(
      hasStagedDecision([row({ kind: 'planning.noOp', state: 'committed' })]),
    ).toBe(true);
  });

  it('is false for decision.pickOne alone — an answered Open Question is not itself a decision the session committed to', () => {
    expect(
      hasStagedDecision([row({ kind: 'decision.pickOne', state: 'committed' })]),
    ).toBe(false);
  });
});
