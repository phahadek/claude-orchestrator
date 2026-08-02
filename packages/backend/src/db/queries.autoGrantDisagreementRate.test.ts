/**
 * Tests for getAutoGrantDisagreementRate — the per-(project, milestone, kind)
 * auto-grant disagreement-rate signal.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from './db';
import { getAutoGrantDisagreementRate } from './queries';
import { insertItem as insertGateItem, appendEvent as appendGateEvent } from '../gate/gateStore';
import { insertItem as insertSeedItem, appendEvent as appendSeedEvent } from '../seed/seedStore';

const PROJECT = 'proj-1';
const MILESTONE = 'M1';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM seed_item').run();
  db.prepare('DELETE FROM seed_item_source').run();
  db.prepare('DELETE FROM seed_item_event').run();
});

let intentSeq = 0;
function insertStagedIntent(opts: {
  kind: 'gate.accrete' | 'seed.stage';
  sourceTaskId: string;
  state: 'committed' | 'approved';
  autoApproved: boolean;
}): void {
  intentSeq += 1;
  const now = Date.now();
  db.prepare(
    `
      INSERT INTO staged_intent
        (id, kind, payload, payload_hash, task_id, project_id, milestone, state, annotation, created_at, updated_at)
      VALUES
        (@id, @kind, @payload, @payload_hash, @task_id, @project_id, @milestone, @state, @annotation, @created_at, @updated_at)
    `,
  ).run({
    id: `intent-${intentSeq}`,
    kind: opts.kind,
    payload: JSON.stringify({ sourceTask: { id: opts.sourceTaskId } }),
    payload_hash: `hash-${intentSeq}`,
    task_id: opts.sourceTaskId,
    project_id: PROJECT,
    milestone: MILESTONE,
    state: opts.state,
    annotation: opts.autoApproved ? JSON.stringify({ autoApproved: true }) : null,
    created_at: now,
    updated_at: now,
  });
}

describe('getAutoGrantDisagreementRate', () => {
  it('returns a null rate when there are no auto-granted commits', () => {
    const result = getAutoGrantDisagreementRate(PROJECT, MILESTONE, 'gate.accrete');
    expect(result).toEqual({
      kind: 'gate.accrete',
      project: PROJECT,
      milestone: MILESTONE,
      total: 0,
      disagreed: 0,
      rate: null,
    });
  });

  it('counts a gate.accrete commit whose item later failed as disagreed', () => {
    const item = insertGateItem({
      project: PROJECT,
      milestone: MILESTONE,
      text: 'Verify X',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:task-1', sourceTaskTitle: 'Task 1' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });
    appendGateEvent(item.id, { disposition: 'fail', at: '2024-01-02T00:00:00Z' });

    insertStagedIntent({
      kind: 'gate.accrete',
      sourceTaskId: 'notion:task-1',
      state: 'committed',
      autoApproved: true,
    });

    const result = getAutoGrantDisagreementRate(PROJECT, MILESTONE, 'gate.accrete');
    expect(result.total).toBe(1);
    expect(result.disagreed).toBe(1);
    expect(result.rate).toBe(1);
  });

  it('does not count a single needs-setup disposition as disagreement', () => {
    const item = insertGateItem({
      project: PROJECT,
      milestone: MILESTONE,
      text: 'Verify Y',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:task-2', sourceTaskTitle: 'Task 2' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });
    appendGateEvent(item.id, { disposition: 'needs-setup', at: '2024-01-02T00:00:00Z' });

    insertStagedIntent({
      kind: 'gate.accrete',
      sourceTaskId: 'notion:task-2',
      state: 'committed',
      autoApproved: true,
    });

    const result = getAutoGrantDisagreementRate(PROJECT, MILESTONE, 'gate.accrete');
    expect(result.total).toBe(1);
    expect(result.disagreed).toBe(0);
    expect(result.rate).toBe(0);
  });

  it('counts a needs-setup disposition recurring 2+ times as disagreement', () => {
    const item = insertGateItem({
      project: PROJECT,
      milestone: MILESTONE,
      text: 'Verify Z',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:task-3', sourceTaskTitle: 'Task 3' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });
    appendGateEvent(item.id, { disposition: 'needs-setup', at: '2024-01-02T00:00:00Z' });
    appendGateEvent(item.id, { disposition: 'needs-setup', at: '2024-01-03T00:00:00Z' });

    insertStagedIntent({
      kind: 'gate.accrete',
      sourceTaskId: 'notion:task-3',
      state: 'committed',
      autoApproved: true,
    });

    const result = getAutoGrantDisagreementRate(PROJECT, MILESTONE, 'gate.accrete');
    expect(result.total).toBe(1);
    expect(result.disagreed).toBe(1);
  });

  it('excludes operator-approved (non-auto-granted) commits from numerator and denominator', () => {
    const item = insertGateItem({
      project: PROJECT,
      milestone: MILESTONE,
      text: 'Verify W',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:task-4', sourceTaskTitle: 'Task 4' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });
    appendGateEvent(item.id, { disposition: 'fail', at: '2024-01-02T00:00:00Z' });

    insertStagedIntent({
      kind: 'gate.accrete',
      sourceTaskId: 'notion:task-4',
      state: 'committed',
      autoApproved: false,
    });

    const result = getAutoGrantDisagreementRate(PROJECT, MILESTONE, 'gate.accrete');
    expect(result.total).toBe(0);
    expect(result.disagreed).toBe(0);
    expect(result.rate).toBeNull();
  });

  it('excludes non-committed (still-staged/approved) auto-granted rows', () => {
    insertGateItem({
      project: PROJECT,
      milestone: MILESTONE,
      text: 'Verify V',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:task-5', sourceTaskTitle: 'Task 5' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });

    insertStagedIntent({
      kind: 'gate.accrete',
      sourceTaskId: 'notion:task-5',
      state: 'approved',
      autoApproved: true,
    });

    const result = getAutoGrantDisagreementRate(PROJECT, MILESTONE, 'gate.accrete');
    expect(result.total).toBe(0);
  });

  it('counts a seed.stage commit whose item was later blocked as disagreed', () => {
    const item = insertSeedItem({
      project: PROJECT,
      milestone: MILESTONE,
      spec: 'Seed a demo account',
      sources: [{ sourceTaskId: 'notion:task-6', sourceTaskTitle: 'Task 6' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });
    appendSeedEvent(item.id, {
      outcome: 'blocked',
      filedFollowon: 'notion:followon',
      at: '2024-01-02T00:00:00Z',
    });

    insertStagedIntent({
      kind: 'seed.stage',
      sourceTaskId: 'notion:task-6',
      state: 'committed',
      autoApproved: true,
    });

    const result = getAutoGrantDisagreementRate(PROJECT, MILESTONE, 'seed.stage');
    expect(result.total).toBe(1);
    expect(result.disagreed).toBe(1);
    expect(result.rate).toBe(1);
  });

  it('keeps gate.accrete and seed.stage rates independent per kind', () => {
    const gateItem = insertGateItem({
      project: PROJECT,
      milestone: MILESTONE,
      text: 'Verify A',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:task-7', sourceTaskTitle: 'Task 7' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });
    appendGateEvent(gateItem.id, { disposition: 'pass', at: '2024-01-02T00:00:00Z' });
    insertStagedIntent({
      kind: 'gate.accrete',
      sourceTaskId: 'notion:task-7',
      state: 'committed',
      autoApproved: true,
    });

    const seedItem = insertSeedItem({
      project: PROJECT,
      milestone: MILESTONE,
      spec: 'Seed B',
      sources: [{ sourceTaskId: 'notion:task-8', sourceTaskTitle: 'Task 8' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });
    appendSeedEvent(seedItem.id, {
      outcome: 'blocked',
      filedFollowon: 'notion:followon-2',
      at: '2024-01-02T00:00:00Z',
    });
    insertStagedIntent({
      kind: 'seed.stage',
      sourceTaskId: 'notion:task-8',
      state: 'committed',
      autoApproved: true,
    });

    const gateResult = getAutoGrantDisagreementRate(PROJECT, MILESTONE, 'gate.accrete');
    const seedResult = getAutoGrantDisagreementRate(PROJECT, MILESTONE, 'seed.stage');
    expect(gateResult.total).toBe(1);
    expect(gateResult.disagreed).toBe(0);
    expect(seedResult.total).toBe(1);
    expect(seedResult.disagreed).toBe(1);
  });
});
