import { describe, it, expect } from 'vitest';
import type { NotionTask } from '../../notion/types';
import { isGroomCandidate, passesGroomDepGate } from '../planningCandidates';

function task(overrides: Partial<NotionTask> = {}): NotionTask {
  return {
    id: 'task-1',
    title: 'A task',
    status: '🔲 Backlog',
    type: '💻 Code',
    dependsOn: [],
    notionUrl: '',
    ...overrides,
  };
}

describe('passesGroomDepGate', () => {
  it('requires a 📐 Design/📋 Planning dep to be ✅ Done', () => {
    const t = task({ dependsOn: ['design-dep'] });
    const notDone = new Map([
      ['design-dep', task({ id: 'design-dep', type: '📐 Design', status: '📐 In Progress' })],
    ]);
    expect(passesGroomDepGate(t, notDone)).toBe(false);

    const done = new Map([
      ['design-dep', task({ id: 'design-dep', type: '📐 Design', status: '✅ Done' })],
    ]);
    expect(passesGroomDepGate(t, done)).toBe(true);
  });

  it('requires an other-Type dep to be groomed past 🔲 Backlog (at 🗂️ Ready or beyond)', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const stillBacklog = new Map([
      ['code-dep', task({ id: 'code-dep', type: '💻 Code', status: '🔲 Backlog' })],
    ]);
    expect(passesGroomDepGate(t, stillBacklog)).toBe(false);

    const groomed = new Map([
      ['code-dep', task({ id: 'code-dep', type: '💻 Code', status: '🗂️ Ready' })],
    ]);
    expect(passesGroomDepGate(t, groomed)).toBe(true);
  });

  it('fails closed when a dep is missing from the board cache', () => {
    const t = task({ dependsOn: ['missing-dep'] });
    expect(passesGroomDepGate(t, new Map())).toBe(false);
  });

  it('passes with no dependencies', () => {
    expect(passesGroomDepGate(task(), new Map())).toBe(true);
  });
});

describe('isGroomCandidate', () => {
  const baseDeps = {
    tasksById: new Map<string, NotionTask>(),
    hasActiveSession: () => false,
    inCrashCooldown: () => false,
  };

  it('rejects a task that is not still 🔲 Backlog', () => {
    const t = task({ status: '🗂️ Ready' });
    expect(isGroomCandidate(t, baseDeps)).toBe(false);
  });

  it('skips a task with an active session (dedup)', () => {
    const t = task();
    expect(
      isGroomCandidate(t, { ...baseDeps, hasActiveSession: () => true }),
    ).toBe(false);
  });

  it('skips a task within its crash-budget cooldown', () => {
    const t = task();
    expect(
      isGroomCandidate(t, { ...baseDeps, inCrashCooldown: () => true }),
    ).toBe(false);
  });

  it('accepts a Backlog task with no active session, no cooldown, and a clear dep-gate', () => {
    const t = task();
    expect(isGroomCandidate(t, baseDeps)).toBe(true);
  });
});
