import { describe, it, expect } from 'vitest';
import {
  applyTriageFloor,
  hasOpenQuestionsHeading,
  isInteractiveTaskType,
  INTERACTIVE_TASK_TYPES,
} from '../triage';
import { DEFERRAL_PHRASES, checkReadiness } from '../../tasks/readinessGate';

describe('isInteractiveTaskType / INTERACTIVE_TASK_TYPES', () => {
  it('treats 📐 Design and 📋 Planning as interactive', () => {
    expect(isInteractiveTaskType('📐 Design')).toBe(true);
    expect(isInteractiveTaskType('📋 Planning')).toBe(true);
    expect(INTERACTIVE_TASK_TYPES.has('📐 Design')).toBe(true);
  });

  it('does not treat 💻 Code (auto-dispatched) as interactive', () => {
    expect(isInteractiveTaskType('💻 Code')).toBe(false);
    expect(isInteractiveTaskType(undefined)).toBe(false);
  });
});

describe('hasOpenQuestionsHeading', () => {
  it('is true for a live "## Open Questions" heading', () => {
    expect(
      hasOpenQuestionsHeading('## Open Questions\n- a real question'),
    ).toBe(true);
  });

  it('is false when the body has no such heading at all', () => {
    expect(hasOpenQuestionsHeading('## Summary\nAll good.')).toBe(false);
  });
});

describe('applyTriageFloor', () => {
  const CLEAN_FACTS = {
    hardBlockDepNotDone: false,
    hasOpenQuestionsHeading: true,
    hasRoutedConstraintConflict: false,
  };

  it('leaves a clean proposal clean when every fact is clean', () => {
    const result = applyTriageFloor({
      proposedVerdict: 'clean',
      ...CLEAN_FACTS,
    });
    expect(result).toEqual({ verdict: 'clean', reasons: [] });
  });

  it('returns blocked when a hard-block dependency is not Done', () => {
    const result = applyTriageFloor({
      proposedVerdict: 'clean',
      ...CLEAN_FACTS,
      hardBlockDepNotDone: true,
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('takes priority over a missing heading and a routed conflict when a hard-block dep is also not Done', () => {
    const result = applyTriageFloor({
      proposedVerdict: 'clean',
      hardBlockDepNotDone: true,
      hasOpenQuestionsHeading: false,
      hasRoutedConstraintConflict: true,
    });
    expect(result.verdict).toBe('blocked');
  });

  it('returns needs-attention when the body lacks a "## Open Questions" heading', () => {
    const result = applyTriageFloor({
      proposedVerdict: 'clean',
      ...CLEAN_FACTS,
      hasOpenQuestionsHeading: false,
    });
    expect(result.verdict).toBe('needs-attention');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('downgrades a routed constraint-conflict out of a clean proposal', () => {
    const result = applyTriageFloor({
      proposedVerdict: 'clean',
      ...CLEAN_FACTS,
      hasRoutedConstraintConflict: true,
    });
    expect(result.verdict).toBe('needs-attention');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('does not touch an already non-clean proposal on a routed constraint-conflict (only downgrades from clean)', () => {
    const result = applyTriageFloor({
      proposedVerdict: 'blocked',
      ...CLEAN_FACTS,
      hasRoutedConstraintConflict: true,
    });
    expect(result).toEqual({ verdict: 'blocked', reasons: [] });
  });

  it('never upgrades a judged needs-attention/blocked verdict back to clean', () => {
    const needsAttention = applyTriageFloor({
      proposedVerdict: 'needs-attention',
      ...CLEAN_FACTS,
    });
    expect(needsAttention.verdict).toBe('needs-attention');

    const blocked = applyTriageFloor({
      proposedVerdict: 'blocked',
      ...CLEAN_FACTS,
    });
    expect(blocked.verdict).toBe('blocked');
  });

  it('a Design open question containing a Tier-2 deferral phrase does not force needs-attention (advisory-only for Design)', () => {
    const phrase = DEFERRAL_PHRASES[0];
    const body = `## Open Questions\n- Should we do X? ${phrase} once scoped.\n`;

    // The Tier-2 lexical scan does flag this body...
    const violations = checkReadiness(body);
    expect(violations.some((v) => v.tier === 'lexical')).toBe(true);

    // ...but the triage floor never consults it, so a clean judgment call
    // survives untouched as long as the heading is live and every other
    // fact is clean.
    const result = applyTriageFloor({
      proposedVerdict: 'clean',
      ...CLEAN_FACTS,
      hasOpenQuestionsHeading: hasOpenQuestionsHeading(body),
    });
    expect(result).toEqual({ verdict: 'clean', reasons: [] });
  });
});
