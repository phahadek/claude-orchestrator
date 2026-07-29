import { describe, it, expect } from 'vitest';
import {
  CORE_PRINCIPLES,
  ORDERED_STEPS,
  renderPrinciple,
  stepSummaryFor,
  renderHardRulesMarkdown,
} from '../procedureCore';

describe('design procedure — one Open Question per turn, no parallel staging', () => {
  const oneQuestionPerTurn = CORE_PRINCIPLES.find(
    (p) => p.id === 'design-one-question-per-turn',
  )!;
  const oneQuestionPerTurnText = renderPrinciple(oneQuestionPerTurn, 'design');

  const feedbackStep = ORDERED_STEPS.find(
    (s) => s.id === 'incorporate-feedback',
  )!;
  const turnSkeletonText = stepSummaryFor(feedbackStep, 'design');

  it('is defined and scoped to design only', () => {
    expect(oneQuestionPerTurn).toBeDefined();
    expect(oneQuestionPerTurn.appliesTo).toEqual(['design']);
  });

  it('instructs handling the task body’s Open Questions one at a time, in the order they are written', () => {
    expect(oneQuestionPerTurnText).toMatch(
      /handle the task\s+body's listed Open Questions one at a time, in the order they are written/i,
    );
  });

  it('never permits staging more than one Open Question in the same turn', () => {
    expect(oneQuestionPerTurnText).toMatch(
      /DO NOT stage two Open Questions, however independent they appear, in the\s+same turn/i,
    );
    expect(oneQuestionPerTurnText).not.toMatch(
      /DO stage every Open Question whose answer is independent of the others in the same turn/i,
    );
    expect(turnSkeletonText).not.toMatch(
      /stage every\s+independent Open Question in the same turn/i,
    );
  });

  it('still requires exactly one Open Question resolution per decision.pickOne intent', () => {
    expect(oneQuestionPerTurnText).toMatch(
      /exactly one Open Question's resolution per `decision\.pickOne` intent/i,
    );
    expect(oneQuestionPerTurnText).toMatch(
      /DO NOT bundle multiple questions into one `decision\.pickOne` intent/i,
    );
  });

  it('holds a question whose answer depends on an unresolved one, and states the dependency rather than staging it', () => {
    expect(oneQuestionPerTurnText).toMatch(
      /DO hold a question whose answer depends on another\s+still-unresolved question, and say so plainly/i,
    );
    expect(turnSkeletonText).toMatch(
      /hold\s+a question whose answer depends on another still-unresolved question,\s+stating the dependency/i,
    );
  });

  it('task.updateBody is still described as staged exactly once, after every question and the completeness critic', () => {
    expect(oneQuestionPerTurnText).toMatch(
      /`task\.updateBody` \(the\s+Implementation notes\) is staged exactly once, the last of the\s+decision-recording steps/i,
    );
  });

  it('does not describe task.updateBody as the session-ending final step', () => {
    expect(oneQuestionPerTurnText).not.toMatch(/as the final step/i);
  });

  it('the assembled hard-rules markdown carries no permission to stage multiple Open Questions per turn', () => {
    const rendered = renderHardRulesMarkdown();
    expect(rendered).not.toMatch(
      /stage every independent Open Question in the same turn/i,
    );
    expect(rendered).not.toMatch(
      /independent Open Questions still stage in the same turn/i,
    );
  });
});
