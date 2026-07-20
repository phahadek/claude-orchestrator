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
