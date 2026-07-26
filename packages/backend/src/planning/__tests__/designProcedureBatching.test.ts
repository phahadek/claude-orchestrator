import { describe, it, expect } from 'vitest';
import {
  CORE_PRINCIPLES,
  ORDERED_STEPS,
  renderPrinciple,
  stepSummaryFor,
  renderHardRulesMarkdown,
} from '../procedureCore';

describe('design procedure — independent Open Questions can stage in the same turn', () => {
  const questionBundling = CORE_PRINCIPLES.find(
    (p) => p.id === 'design-no-question-bundling',
  )!;
  const questionBundlingText = renderPrinciple(questionBundling, 'design');

  const feedbackStep = ORDERED_STEPS.find(
    (s) => s.id === 'incorporate-feedback',
  )!;
  const turnSkeletonText = stepSummaryFor(feedbackStep, 'design');

  it('is defined and scoped to design only', () => {
    expect(questionBundling).toBeDefined();
    expect(questionBundling.appliesTo).toEqual(['design']);
  });

  it('states that multiple independent Open Questions may be staged in the same turn, each as its own intent', () => {
    expect(questionBundlingText).toMatch(
      /every Open Question whose answer is independent of the others in the same turn, each as its own `decision\.pickOne` intent/i,
    );
  });

  it('still requires exactly one Open Question resolution per decision.pickOne intent', () => {
    expect(questionBundlingText).toMatch(
      /exactly one Open Question's resolution per `decision\.pickOne` intent/i,
    );
    expect(questionBundlingText).toMatch(
      /DO NOT bundle multiple questions into one `decision\.pickOne` intent/i,
    );
  });

  it('still instructs holding a question whose answer depends on an unresolved one', () => {
    expect(questionBundlingText).toMatch(
      /DO hold a question whose answer depends on another still-unresolved question/i,
    );
  });

  it('contains no per-turn staging limit', () => {
    expect(questionBundlingText).not.toMatch(/staged per turn/i);
    expect(questionBundlingText).not.toMatch(
      /never more than one question.s resolution/i,
    );
  });

  it('agrees with the turn-skeleton text — neither states a one-question-per-turn limit', () => {
    expect(turnSkeletonText).not.toMatch(/staged per turn/i);
    expect(turnSkeletonText).not.toMatch(
      /batch multiple questions. resolutions into one pass/i,
    );
    expect(turnSkeletonText).toMatch(
      /stage every independent Open Question in the same turn, each as its own intent/i,
    );
  });

  it('task.updateBody is still described as staged exactly once, after the completeness critic', () => {
    expect(questionBundlingText).toMatch(
      /`task\.updateBody` \(the Implementation notes\) is staged exactly once, as the final step, only after every question is settled and the completeness critic below has run/i,
    );
  });

  it('the assembled hard-rules markdown carries no per-turn staging limit anywhere', () => {
    const rendered = renderHardRulesMarkdown();
    expect(rendered).not.toMatch(/staged per turn/i);
    expect(rendered).not.toMatch(
      /batch-lock multiple questions into one pass/i,
    );
  });
});
