import { describe, it, expect } from 'vitest';
import type { StagedIntent } from '../../api/stagedIntents';
import { triageVerdict, taskIdFor } from '../triageVerdict';

function readyIntent(
  taskId: string,
  groomingGate: Record<string, unknown>,
): StagedIntent[] {
  return [
    {
      id: `${taskId}-status`,
      kind: 'task.setStatus',
      payload: { taskId, status: 'Ready', groomingGate },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'groom-session-1',
      groupId: 'group-1',
      state: 'staged',
    },
  ];
}

describe('triageVerdict', () => {
  it('returns the proposed verdict for a 📐 Design group', () => {
    const intents = readyIntent('t-design', {
      type: '📐 Design',
      triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
    });
    expect(triageVerdict(intents)).toBe('clean');
  });

  it('returns the proposed verdict for a 📋 Planning group', () => {
    const intents = readyIntent('t-planning', {
      type: '📋 Planning',
      triage: { proposedVerdict: 'blocked', hasOpenQuestionsHeading: true },
    });
    expect(triageVerdict(intents)).toBe('blocked');
  });

  it('returns null for a 💻 Code group even when a clean verdict is present in the payload', () => {
    const intents = readyIntent('t-code', {
      type: '💻 Code',
      triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
    });
    expect(triageVerdict(intents)).toBeNull();
  });

  it('returns null for a 🔎 Investigation group even when a clean verdict is present in the payload', () => {
    const intents = readyIntent('t-investigation', {
      type: '🔎 Investigation',
      triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
    });
    expect(triageVerdict(intents)).toBeNull();
  });

  it('returns null for a 🔧 Operational group even when a clean verdict is present in the payload', () => {
    const intents = readyIntent('t-operational', {
      type: '🔧 Operational',
      triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
    });
    expect(triageVerdict(intents)).toBeNull();
  });

  it('returns null when groomingGate.type is missing, even with a verdict present (pre-fix record)', () => {
    const intents = readyIntent('t-untyped', {
      triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
    });
    expect(triageVerdict(intents)).toBeNull();
  });

  it('returns null when there is no triage block at all', () => {
    const intents = readyIntent('t-no-triage', { type: '📐 Design' });
    expect(triageVerdict(intents)).toBeNull();
  });

  it('returns null for an empty intents array', () => {
    expect(triageVerdict([])).toBeNull();
  });
});

describe('taskIdFor', () => {
  it('returns the task id of the Ready-flip intent', () => {
    const intents = readyIntent('t-design', { type: '📐 Design' });
    expect(taskIdFor(intents)).toBe('t-design');
  });

  it('returns null when there is no Ready-flip intent', () => {
    expect(taskIdFor([])).toBeNull();
  });
});
