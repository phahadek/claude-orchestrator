import { describe, it, expect } from 'vitest';
import { checkReadiness } from '../readinessGate';

describe('checkReadiness — Tier 1 (structural)', () => {
  it('flags a body with a non-empty Open Questions section', () => {
    const body = '## Open Questions\n- Which retry policy should we use?\n';
    const violations = checkReadiness(body);
    expect(violations.some((v) => v.tier === 'structural')).toBe(true);
  });

  it('does not flag a body with an Open questions resolved summary (no live heading)', () => {
    const body =
      '## Open questions resolved\n| Question | Resolution |\n| --- | --- |\n| Retry policy? | Exponential backoff |\n';
    const violations = checkReadiness(body);
    expect(violations.some((v) => v.tier === 'structural')).toBe(false);
  });

  it('does not flag an empty Open Questions section', () => {
    const body = '## Open Questions\nNone\n\n## Next section\ncontent';
    const violations = checkReadiness(body);
    expect(violations.some((v) => v.tier === 'structural')).toBe(false);
  });
});

describe('checkReadiness — Tier 2 (lexical)', () => {
  it('flags a deferral phrase in prose', () => {
    const body = 'The retry policy will be decide during implementation.';
    const violations = checkReadiness(body);
    expect(violations.some((v) => v.tier === 'lexical')).toBe(true);
  });

  it('matches case-insensitively', () => {
    const body = 'DECIDE DURING IMPLEMENTATION.';
    const violations = checkReadiness(body);
    expect(violations.some((v) => v.tier === 'lexical')).toBe(true);
  });

  it('does not flag a phrase inside a fenced code block', () => {
    const body = '```\nthis is decide during implementation\n```';
    const violations = checkReadiness(body);
    expect(violations.some((v) => v.tier === 'lexical')).toBe(false);
  });

  it('does not flag a phrase inside inline code', () => {
    const body = 'See `decide during implementation` in the old draft.';
    const violations = checkReadiness(body);
    expect(violations.some((v) => v.tier === 'lexical')).toBe(false);
  });

  it('does not flag a phrase inside a block-quote', () => {
    const body = '> decide during implementation\n\nActual plan is fixed.';
    const violations = checkReadiness(body);
    expect(violations.some((v) => v.tier === 'lexical')).toBe(false);
  });
});

describe('checkReadiness — Tier 2 (grooming-instruction residue)', () => {
  it('flags "confirm ... at grooming" residue', () => {
    const body = 'Files affected: confirm the exact module at grooming.';
    const violations = checkReadiness(body);
    expect(
      violations.some(
        (v) => v.tier === 'lexical' && v.detail.includes('residue'),
      ),
    ).toBe(true);
  });

  it('flags "pin at grooming" residue', () => {
    const body = 'Version to pin at grooming once the API is stable.';
    const violations = checkReadiness(body);
    expect(
      violations.some(
        (v) => v.tier === 'lexical' && v.detail.includes('residue'),
      ),
    ).toBe(true);
  });

  it('flags "decide during grooming" residue', () => {
    const body = 'We will decide the retry count during grooming.';
    const violations = checkReadiness(body);
    expect(
      violations.some(
        (v) => v.tier === 'lexical' && v.detail.includes('residue'),
      ),
    ).toBe(true);
  });

  it('does not flag a body legitimately containing and/or', () => {
    const body =
      'The handler accepts a string and/or a Buffer as input, whichever the caller supplies.';
    const violations = checkReadiness(body);
    expect(violations).toEqual([]);
  });

  it('does not flag "confirm" or "at grooming" mentioned separately, without both on one line', () => {
    const body =
      'Confirm the deploy succeeded.\n\nThis was decided at grooming already, not deferred.';
    const violations = checkReadiness(body);
    expect(violations.some((v) => v.detail.includes('residue'))).toBe(false);
  });
});

describe('checkReadiness — type-aware Open Questions / deferral exemption', () => {
  const openQuestionsBody =
    '## Open Questions\n- Which retry policy should we use?\n';
  const deferralBody = 'The retry policy will be decide during implementation.';

  it('does not flag a non-empty Open Questions section for 📐 Design', () => {
    expect(checkReadiness(openQuestionsBody, '📐 Design')).toEqual([]);
  });

  it('still flags a non-empty Open Questions section for 💻 Code', () => {
    const violations = checkReadiness(openQuestionsBody, '💻 Code');
    expect(violations.some((v) => v.tier === 'structural')).toBe(true);
  });

  it('does not flag a deferral phrase for 📐 Design', () => {
    expect(checkReadiness(deferralBody, '📐 Design')).toEqual([]);
  });

  it('still flags a deferral phrase for 💻 Code', () => {
    const violations = checkReadiness(deferralBody, '💻 Code');
    expect(violations.some((v) => v.tier === 'lexical')).toBe(true);
  });

  it('does not flag Open Questions / deferral for 📋 Planning', () => {
    expect(checkReadiness(openQuestionsBody, '📋 Planning')).toEqual([]);
    expect(checkReadiness(deferralBody, '📋 Planning')).toEqual([]);
  });

  it('does not flag Open Questions / deferral for 🔎 Investigation', () => {
    expect(checkReadiness(openQuestionsBody, '🔎 Investigation')).toEqual([]);
    expect(checkReadiness(deferralBody, '🔎 Investigation')).toEqual([]);
  });

  it('does not flag Open Questions / deferral for 🧪 Testing', () => {
    expect(checkReadiness(openQuestionsBody, '🧪 Testing')).toEqual([]);
    expect(checkReadiness(deferralBody, '🧪 Testing')).toEqual([]);
  });

  it('flags structural grooming residue for both 📐 Design and 💻 Code', () => {
    const residueBody = 'Files affected: confirm the exact module at grooming.';
    const designViolations = checkReadiness(residueBody, '📐 Design');
    const codeViolations = checkReadiness(residueBody, '💻 Code');
    expect(designViolations.some((v) => v.detail.includes('residue'))).toBe(
      true,
    );
    expect(codeViolations.some((v) => v.detail.includes('residue'))).toBe(true);
  });
});
