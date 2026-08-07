import { describe, it, expect } from 'vitest';
import {
  checkReadiness,
  parseManualVerificationItems,
  parseOperationalSeedItems,
  checkAccretionContentMatch,
  extractDeclaredWrites,
} from '../readinessGate';

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

  it('does not flag the generic Open Questions / deferral checks for 🔎 Investigation (its own Deliverables/decision-branch floor facts still apply)', () => {
    // Investigation's Tier-1/Tier-2 exemption is about the *generic* Open
    // Questions / deferral checks — it still needs its own Deliverables
    // heading and decision-branch structure (see the floor-facts describe
    // block below), so this body satisfies those to isolate the exemption.
    const investigationBody =
      '## Deliverables\n- A go/no-go decision.\n\n## Context\n- If the spike succeeds, file the Code task.\n- If it fails, file a follow-on Investigation.\n\n' +
      openQuestionsBody +
      deferralBody;
    expect(checkReadiness(investigationBody, '🔎 Investigation')).toEqual([]);
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

describe('checkReadiness — 🔧 Operational floor facts', () => {
  const validBody =
    '## Targets / surfaces affected\n- billing config catalog\n\n### 👁️ Manual verification\n- seed present on prod; worker reconciled and captured the change signal\n';

  it('passes a clean Operational body', () => {
    expect(checkReadiness(validBody, '🔧 Operational')).toEqual([]);
  });

  it('fails when Targets / surfaces affected is missing', () => {
    const body =
      '### 👁️ Manual verification\n- seed present on prod; worker reconciled and captured the change signal\n';
    const violations = checkReadiness(body, '🔧 Operational');
    expect(
      violations.some(
        (v) => v.tier === 'structural' && v.detail.includes('Targets'),
      ),
    ).toBe(true);
  });

  it('fails when Targets / surfaces affected is present but empty', () => {
    const body =
      '## Targets / surfaces affected\nNone\n\n### 👁️ Manual verification\n- seed present on prod; worker reconciled and captured the change signal\n';
    const violations = checkReadiness(body, '🔧 Operational');
    expect(
      violations.some(
        (v) => v.tier === 'structural' && v.detail.includes('Targets'),
      ),
    ).toBe(true);
  });

  it('fails when Manual verification lacks reconcile-and-capture language', () => {
    const body =
      '## Targets / surfaces affected\n- billing config catalog\n\n### 👁️ Manual verification\n- looks fine\n';
    const violations = checkReadiness(body, '🔧 Operational');
    expect(
      violations.some(
        (v) => v.tier === 'lexical' && v.detail.includes('reconcile'),
      ),
    ).toBe(true);
  });

  it('passes when reconcile and capture are stated separately, order-agnostic', () => {
    const body =
      '## Targets / surfaces affected\n- billing config catalog\n\n### 👁️ Manual verification\n- captured evidence that the worker reconciled the change\n';
    expect(checkReadiness(body, '🔧 Operational')).toEqual([]);
  });

  it('still blocks on a deferral phrase (Tier 2 not exempted for Operational)', () => {
    const body =
      validBody + '\nThe retry policy will be decide during implementation.';
    const violations = checkReadiness(body, '🔧 Operational');
    expect(violations.some((v) => v.tier === 'lexical')).toBe(true);
  });

  it('a sample body missing Targets / surfaces affected is blocked by checkReadiness', () => {
    const body =
      '### 👁️ Manual verification\n- seed present on prod; worker reconciled and captured the change signal\n';
    expect(checkReadiness(body, '🔧 Operational').length).toBeGreaterThan(0);
  });

  it('a sample body containing a deferral phrase is still blocked', () => {
    const body =
      validBody + '\nThe retry policy will be decide during implementation.';
    expect(checkReadiness(body, '🔧 Operational').length).toBeGreaterThan(0);
  });

  it('does not accept a required heading that only appears inside a fenced code block', () => {
    const body =
      '## Example\n```\n## Targets / surfaces affected\n- billing config catalog\n```\n\n### 👁️ Manual verification\n- seed present on prod; worker reconciled and captured the change signal\n';
    const violations = checkReadiness(body, '🔧 Operational');
    expect(
      violations.some(
        (v) => v.tier === 'structural' && v.detail.includes('Targets'),
      ),
    ).toBe(true);
  });

  it('still detects a genuine top-level required heading outside any fence', () => {
    const body = '```\nsome unrelated example\n```\n\n' + validBody;
    expect(checkReadiness(body, '🔧 Operational')).toEqual([]);
  });
});

describe('checkReadiness — 🔎 Investigation floor facts', () => {
  const validBody =
    '## Deliverables\n- A go/no-go decision plus follow-on tasks.\n\n## Context\n- If latency regressed after the deploy, file a Code rollback task.\n- If it did not, file a follow-on Investigation into the alert itself.\n';

  it('passes a clean Investigation body', () => {
    expect(checkReadiness(validBody, '🔎 Investigation')).toEqual([]);
  });

  it('fails when Deliverables is missing', () => {
    const body =
      '## Context\n- If latency regressed, file a rollback task.\n- If not, investigate the alert.\n';
    const violations = checkReadiness(body, '🔎 Investigation');
    expect(
      violations.some(
        (v) => v.tier === 'structural' && v.detail.includes('Deliverables'),
      ),
    ).toBe(true);
  });

  it('fails when Deliverables is present but empty', () => {
    const body =
      '## Deliverables\nNone\n\n## Context\n- If latency regressed, file a rollback task.\n- If not, investigate the alert.\n';
    const violations = checkReadiness(body, '🔎 Investigation');
    expect(
      violations.some(
        (v) => v.tier === 'structural' && v.detail.includes('Deliverables'),
      ),
    ).toBe(true);
  });

  it('fails when Context has no enumerated decision-branch structure', () => {
    const body =
      '## Deliverables\n- A go/no-go decision.\n\n## Context\nLatency looked elevated yesterday, worth a look.\n';
    const violations = checkReadiness(body, '🔎 Investigation');
    expect(
      violations.some(
        (v) => v.tier === 'structural' && v.detail.includes('decision-branch'),
      ),
    ).toBe(true);
  });

  it('accepts a plain list as a lenient decision-branch structure (no literal a/b/c lettering required)', () => {
    const body =
      '## Deliverables\n- A go/no-go decision.\n\n## Context\n- Root cause is the retry storm.\n- Root cause is the upstream outage.\n';
    expect(checkReadiness(body, '🔎 Investigation')).toEqual([]);
  });

  it("Investigation's existing Tier-1/Tier-2 exemption is unchanged: a live Open Questions section and a deferral phrase are not flagged", () => {
    const body =
      validBody +
      '\n## Open Questions\n- Which alert threshold?\n\nThe retry policy will be decide during implementation.';
    expect(checkReadiness(body, '🔎 Investigation')).toEqual([]);
  });

  it('a sample body missing Deliverables is blocked by checkReadiness', () => {
    const body =
      '## Context\n- If latency regressed, file a rollback task.\n- If not, investigate the alert.\n';
    expect(checkReadiness(body, '🔎 Investigation').length).toBeGreaterThan(0);
  });

  it('a sample body whose Context lacks any enumerated decision-branch structure surfaces as a violation', () => {
    const body =
      '## Deliverables\n- A go/no-go decision.\n\n## Context\nLatency looked elevated yesterday, worth a look.\n';
    expect(checkReadiness(body, '🔎 Investigation').length).toBeGreaterThan(0);
  });
});

describe('parseManualVerificationItems', () => {
  it('parses bulleted items under a "### 👁️ Manual verification" heading', () => {
    const body =
      '## Summary\nStuff.\n\n### 👁️ Manual verification\n- Click the button and confirm a toast appears\n- Reload the page and confirm state persists\n';
    expect(parseManualVerificationItems(body)).toEqual([
      'Click the button and confirm a toast appears',
      'Reload the page and confirm state persists',
    ]);
  });

  it('parses numbered items and stops at the next heading', () => {
    const body =
      '## 👁️ Manual verification\n1. First check\n2. Second check\n\n## Next section\n- Not a manual verification item\n';
    expect(parseManualVerificationItems(body)).toEqual([
      'First check',
      'Second check',
    ]);
  });

  it('returns an empty array when there is no Manual verification section', () => {
    const body = '## Summary\nNo such section here.\n';
    expect(parseManualVerificationItems(body)).toEqual([]);
  });

  it('returns an empty array for an explicit "None" section', () => {
    const body = '### 👁️ Manual verification\nNone\n';
    expect(parseManualVerificationItems(body)).toEqual([]);
  });
});

describe('parseOperationalSeedItems', () => {
  it('parses bulleted items under a "## Operational seed" heading', () => {
    const body =
      '## Summary\nStuff.\n\n## Operational seed\n- Set default retry count to 3\n- Enable the new feature flag\n';
    expect(parseOperationalSeedItems(body)).toEqual([
      'Set default retry count to 3',
      'Enable the new feature flag',
    ]);
  });

  it('matches any heading level and stops at the next heading', () => {
    const body =
      '### Operational Seed\n1. First seed\n2. Second seed\n\n## Next section\n- Not an operational seed item\n';
    expect(parseOperationalSeedItems(body)).toEqual([
      'First seed',
      'Second seed',
    ]);
  });

  it('returns an empty array when there is no Operational seed section', () => {
    const body = '## Summary\nNo such section here.\n';
    expect(parseOperationalSeedItems(body)).toEqual([]);
  });

  it('returns an empty array for the rendered "None." placeholder', () => {
    const body = '## Operational seed\nNone.\n';
    expect(parseOperationalSeedItems(body)).toEqual([]);
  });
});

describe('checkAccretionContentMatch', () => {
  it('passes when N stripped items match N accreted items', () => {
    const result = checkAccretionContentMatch(
      'gate_contribution',
      ['Check the toast appears', 'Check state persists'],
      ['Check the toast appears', 'Check state persists'],
    );
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('is order- and case/whitespace-insensitive', () => {
    const result = checkAccretionContentMatch(
      'gate_contribution',
      ['Check A', 'Check B'],
      ['  check b  ', 'CHECK A'],
    );
    expect(result.ok).toBe(true);
  });

  it('hard-blocks when fewer items were accreted than stripped', () => {
    const result = checkAccretionContentMatch(
      'gate_contribution',
      ['Check A', 'Check B'],
      ['Check A'],
    );
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('gate_contribution content mismatch');
    expect(result.reasons[0]).toContain('Check B');
  });

  it('hard-blocks on an item-correspondence mismatch even with equal counts', () => {
    const result = checkAccretionContentMatch(
      'gate_contribution',
      ['Check A', 'Check B'],
      ['Check A', 'Something unrelated'],
    );
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('Check B');
  });

  it('allows extra accreted items beyond what was stripped (groomer-added observations)', () => {
    const result = checkAccretionContentMatch(
      'gate_contribution',
      ['Check A'],
      ['Check A', 'Groomer-added extra check'],
    );
    expect(result.ok).toBe(true);
  });

  it('is a no-op when nothing was stripped', () => {
    const result = checkAccretionContentMatch('gate_contribution', [], []);
    expect(result.ok).toBe(true);
  });
});

describe('checkReadiness — Declared writes section', () => {
  it('does not flag a well-formed, fully-tagged Declared writes section', () => {
    const body =
      '## Declared writes\n' +
      '- `Bash(npm ci:*)` — Non-Prod-Mutating\n' +
      '- `Bash(git push origin HEAD:*)` — Prod-Mutating\n';
    const violations = checkReadiness(body);
    expect(violations).toHaveLength(0);
  });

  it('does not block Ready on an entry missing its Prod-Mutating tag — it defaults to Prod-Mutating instead of failing open', () => {
    const body = '## Declared writes\n- `mcp__github__merge_pull_request`\n';
    const violations = checkReadiness(body);
    expect(violations).toHaveLength(0);

    const entries = extractDeclaredWrites(body);
    expect(entries).toEqual([
      { capability: 'mcp__github__merge_pull_request', prodMutating: true },
    ]);
  });

  it('defaults an ambiguously-tagged entry to Prod-Mutating rather than failing open', () => {
    const body = '## Declared writes\n- `Bash(npm ci:*)` — TBD\n';
    const entries = extractDeclaredWrites(body);
    expect(entries).toEqual([
      { capability: 'Bash(npm ci:*)', prodMutating: true },
    ]);
  });

  it('recognizes an unambiguous Non-Prod-Mutating tag as eligible for auto-approval', () => {
    const body = '## Declared writes\n- `Bash(npm ci:*)` — Non-Prod-Mutating\n';
    const entries = extractDeclaredWrites(body);
    expect(entries).toEqual([
      { capability: 'Bash(npm ci:*)', prodMutating: false },
    ]);
  });

  it('blocks Ready on a malformed entry with no discernible capability', () => {
    const body = '## Declared writes\n- ``\n';
    const violations = checkReadiness(body);
    expect(
      violations.some(
        (v) => v.tier === 'structural' && v.detail.includes('malformed'),
      ),
    ).toBe(true);
    expect(extractDeclaredWrites(body)).toEqual([]);
  });

  it('is empty for a task body with no Declared writes section', () => {
    expect(extractDeclaredWrites('## Some other section\ncontent')).toEqual([]);
    expect(checkReadiness('## Some other section\ncontent')).toHaveLength(0);
  });

  it('treats a "None" Declared writes section as empty, not malformed', () => {
    const body = '## Declared writes\nNone\n';
    expect(extractDeclaredWrites(body)).toEqual([]);
    expect(checkReadiness(body)).toHaveLength(0);
  });
});
