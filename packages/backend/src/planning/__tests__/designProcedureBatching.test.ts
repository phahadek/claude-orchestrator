import { describe, it, expect } from 'vitest';
import {
  CORE_PRINCIPLES,
  ORDERED_STEPS,
  renderPrinciple,
  stepSummaryFor,
  renderHardRulesMarkdown,
} from '../procedureCore';

describe('design procedure — zero listed Open Questions is a decision space to reconstruct, not a blocked state', () => {
  const zeroQuestionsPrinciple = CORE_PRINCIPLES.find(
    (p) => p.id === 'design-zero-open-questions-reconstruct',
  )!;
  const zeroQuestionsText = renderPrinciple(zeroQuestionsPrinciple, 'design');

  const loadStep = ORDERED_STEPS.find((s) => s.id === 'deterministic-load')!;
  const loadStepText = stepSummaryFor(loadStep, 'design');

  it('is defined and scoped to design only', () => {
    expect(zeroQuestionsPrinciple).toBeDefined();
    expect(zeroQuestionsPrinciple.appliesTo).toEqual(['design']);
  });

  it('renders guidance to reconstruct the decision space from the task body, not to report a blocked state', () => {
    expect(zeroQuestionsText).toMatch(
      /is a normal input to reconstruct, not a blocked state/i,
    );
    expect(zeroQuestionsText).toMatch(
      /reconstruct the decision space it implies from scratch/i,
    );
    expect(zeroQuestionsText).not.toMatch(/end the turn and surface it/i);
  });

  it('stages one decision.pickOne per body-recorded decision, with the recorded answer as the recommended option', () => {
    expect(zeroQuestionsText).toMatch(
      /every decision the body\s+records as already made becomes its own `decision\.pickOne`/i,
    );
    expect(zeroQuestionsText).toMatch(
      /the body’s recorded answer supplied as the\s+recommended `options\[\]` entry/i,
    );
    expect(zeroQuestionsText).toMatch(/never a distinct "confirm this" kind/i);
  });

  it('still requires the completeness critic and the architecture write on a reconstructed pass', () => {
    expect(zeroQuestionsText).toMatch(/DO run the completeness critic/i);
    expect(zeroQuestionsText).toMatch(
      /the architecture write\(s\), and the\s+follow-on `task\.create` set on every reconstructed decision/i,
    );
  });

  it('states planning.noOp is the terminal action only when no decision space exists at all, and must be staged', () => {
    expect(zeroQuestionsText).toMatch(
      /`planning\.noOp` is the terminal action ONLY when the task body genuinely\s+carries no decision space at all/i,
    );
    expect(zeroQuestionsText).toMatch(
      /even then it must be staged,\s+naming why nothing needs reconstructing, never replaced by a prose\s+write-up in chat/i,
    );
  });

  it('the Deterministic load step distinguishes a genuinely failed digest load (still blocked) from a loaded digest with zero Open Questions (not blocked)', () => {
    expect(loadStepText).toMatch(
      /digest that genuinely fails to load[\s\S]*is still a blocked state to report/i,
    );
    expect(loadStepText).toMatch(
      /A digest that loads successfully but lists zero Open Questions\s+is NOT that case/i,
    );
  });

  it('the assembled hard-rules markdown carries the reconstruct-don’t-block guidance for design', () => {
    const rendered = renderHardRulesMarkdown();
    expect(rendered).toMatch(
      /Zero listed Open Questions is a decision space to reconstruct, never a blocked state/i,
    );
  });
});

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
