/**
 * Assertion coverage for the two "blocked intent" feedback message sites
 * (stagedIntents.ts's formatStageTimeBlockFeedback and
 * PlanningOrchestrator.ts's formatDispositionMessage's auto-pushback branch):
 * both must tell the session to supersede ONLY the named blocked intent and
 * leave its unblocked group siblings in place — before this fix the
 * instruction was singular ("supersedes set to <id>") with nothing telling
 * the session that untouched siblings must not be re-staged, and a grooming
 * session read that gap as license to supersede its whole group.
 */

import { describe, it, expect } from 'vitest';

describe('blocked-intent supersede-scope wording', () => {
  it('formatStageTimeBlockFeedback (routes/stagedIntents.ts) names supersede-only-the-blocked-intent and leave-siblings-in-place', async () => {
    const { formatStageTimeBlockFeedback } = await import('../stagedIntents');
    const intent = {
      id: 'intent-123',
      kind: 'task.setStatus',
    } as Parameters<typeof formatStageTimeBlockFeedback>[0];
    const message = formatStageTimeBlockFeedback(
      intent,
      'some validation failure',
    );

    expect(message).toMatch(/supersedes set to "intent-123"/);
    expect(message).toMatch(/only this blocked intent/i);
    expect(message).toMatch(/siblings.*must be left in place/i);
  });

  it('formatDispositionMessage (orchestration/PlanningOrchestrator.ts) auto-pushback branch names supersede-only-the-rejected-intent and leave-siblings-in-place', async () => {
    const { formatDispositionMessage } =
      await import('../../orchestration/PlanningOrchestrator');
    const intent = {
      id: 'intent-456',
      kind: 'gate.accrete',
    } as Parameters<typeof formatDispositionMessage>[0];
    const message = formatDispositionMessage(
      intent,
      'pushback',
      'validation failed',
      null,
      'auto',
    );

    expect(message).toMatch(/supersedes set to "intent-456"/);
    expect(message).toMatch(/only this rejected intent/i);
    expect(message).toMatch(/siblings.*must be left in place/i);
  });

  it('formatDispositionMessage operator-pushback branch (unaffected) does not carry the auto-validation wording', async () => {
    const { formatDispositionMessage } =
      await import('../../orchestration/PlanningOrchestrator');
    const intent = {
      id: 'intent-789',
      kind: 'task.setStatus',
    } as Parameters<typeof formatDispositionMessage>[0];
    const message = formatDispositionMessage(
      intent,
      'pushback',
      'operator feedback',
      null,
      'operator',
    );

    expect(message).not.toMatch(/supersedes/);
  });
});
