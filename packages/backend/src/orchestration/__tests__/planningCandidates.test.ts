import { describe, it, expect } from 'vitest';
import type { NotionTask } from '../../notion/types';
import {
  isGroomCandidate,
  passesGroomDepGate,
  isDesignCandidate,
  passesDesignDepGate,
} from '../planningCandidates';

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
      [
        'design-dep',
        task({ id: 'design-dep', type: '📐 Design', status: '📐 In Progress' }),
      ],
    ]);
    expect(passesGroomDepGate(t, notDone)).toBe(false);

    const done = new Map([
      [
        'design-dep',
        task({ id: 'design-dep', type: '📐 Design', status: '✅ Done' }),
      ],
    ]);
    expect(passesGroomDepGate(t, done)).toBe(true);
  });

  it('requires an other-Type dep to be groomed past 🔲 Backlog (at 🗂️ Ready or beyond)', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const stillBacklog = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '🔲 Backlog' }),
      ],
    ]);
    expect(passesGroomDepGate(t, stillBacklog)).toBe(false);

    const groomed = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '🗂️ Ready' }),
      ],
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
    hasRunningGroomSession: () => false,
    hasUndispositionedGroomIntent: () => false,
    inCrashCooldown: () => false,
  };

  it('rejects a task that is not still 🔲 Backlog', () => {
    const t = task({ status: '🗂️ Ready' });
    expect(isGroomCandidate(t, baseDeps)).toBe(false);
  });

  it('skips a task with an active standard session (dedup)', () => {
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

  it('skips a task with a groom session still running', () => {
    const t = task();
    expect(
      isGroomCandidate(t, { ...baseDeps, hasRunningGroomSession: () => true }),
    ).toBe(false);
  });

  it('skips a task with an idle groom session holding at least one undispositioned intent', () => {
    const t = task();
    expect(
      isGroomCandidate(t, {
        ...baseDeps,
        hasUndispositionedGroomIntent: () => true,
      }),
    ).toBe(false);
  });

  it("re-qualifies once the idle groom session's intents are dispositioned", () => {
    const t = task();
    expect(
      isGroomCandidate(t, {
        ...baseDeps,
        hasRunningGroomSession: () => false,
        hasUndispositionedGroomIntent: () => false,
      }),
    ).toBe(true);
  });
});

describe('passesDesignDepGate', () => {
  it('requires every dep to be ✅ Done, regardless of Type', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const notDone = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '🗂️ Ready' }),
      ],
    ]);
    expect(passesDesignDepGate(t, notDone)).toBe(false);

    const done = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '✅ Done' }),
      ],
    ]);
    expect(passesDesignDepGate(t, done)).toBe(true);
  });

  it('fails closed when a dep is missing from the board cache', () => {
    const t = task({ dependsOn: ['missing-dep'] });
    expect(passesDesignDepGate(t, new Map())).toBe(false);
  });

  it('passes with no dependencies', () => {
    expect(passesDesignDepGate(task(), new Map())).toBe(true);
  });
});

describe('isDesignCandidate', () => {
  const baseDeps = {
    tasksById: new Map<string, NotionTask>(),
    hasActiveSession: () => false,
    hasActiveDesignSession: () => false,
    inCrashCooldown: () => false,
    armed: true,
  };

  it('excludes a 🗂️ Ready 📐 Design task while the design flow is disarmed', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(isDesignCandidate(t, { ...baseDeps, armed: false })).toBe(false);
  });

  it('includes a 🗂️ Ready 📐 Design task once the design flow is armed', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(isDesignCandidate(t, baseDeps)).toBe(true);
  });

  it('includes a 🗂️ Ready 📋 Planning task once armed', () => {
    const t = task({ status: '🗂️ Ready', type: '📋 Planning' });
    expect(isDesignCandidate(t, baseDeps)).toBe(true);
  });

  it('rejects a task that is not 🗂️ Ready', () => {
    const t = task({ status: '🔲 Backlog', type: '📐 Design' });
    expect(isDesignCandidate(t, baseDeps)).toBe(false);
  });

  it('rejects a Ready task of a non-design/planning Type', () => {
    const t = task({ status: '🗂️ Ready', type: '💻 Code' });
    expect(isDesignCandidate(t, baseDeps)).toBe(false);
  });

  it('skips a task with an active standard session (dedup)', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(
      isDesignCandidate(t, { ...baseDeps, hasActiveSession: () => true }),
    ).toBe(false);
  });

  it('skips a task with an active design session (dedup)', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(
      isDesignCandidate(t, {
        ...baseDeps,
        hasActiveDesignSession: () => true,
      }),
    ).toBe(false);
  });

  it('skips a task within its crash-budget cooldown', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(
      isDesignCandidate(t, { ...baseDeps, inCrashCooldown: () => true }),
    ).toBe(false);
  });

  it('rejects when the design dep-gate fails', () => {
    const t = task({
      status: '🗂️ Ready',
      type: '📐 Design',
      dependsOn: ['code-dep'],
    });
    const notDone = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '🗂️ Ready' }),
      ],
    ]);
    expect(isDesignCandidate(t, { ...baseDeps, tasksById: notDone })).toBe(
      false,
    );
  });
});
