import { describe, it, expect } from 'vitest';
import {
  enforcePassEvidenceContract,
  hasOperationalEvidence,
} from '../gateItemVerifier';

describe('hasOperationalEvidence', () => {
  it('is true for evidence.basis "operational"', () => {
    expect(hasOperationalEvidence({ basis: 'operational' })).toBe(true);
  });

  it('is true for an array basis that includes "operational"', () => {
    expect(hasOperationalEvidence({ basis: ['source', 'operational'] })).toBe(
      true,
    );
  });

  it('is false for evidence.basis "source"', () => {
    expect(hasOperationalEvidence({ basis: 'source' })).toBe(false);
  });

  it('is false for missing/malformed evidence', () => {
    expect(hasOperationalEvidence(undefined)).toBe(false);
    expect(hasOperationalEvidence(null)).toBe(false);
    expect(hasOperationalEvidence('some string')).toBe(false);
    expect(hasOperationalEvidence({})).toBe(false);
  });
});

describe('enforcePassEvidenceContract', () => {
  it('downgrades a source-only pass to needs-setup', () => {
    const result = enforcePassEvidenceContract({
      disposition: 'pass',
      evidence: { basis: 'source', note: 'read the component, looks right' },
    });
    expect(result.disposition).toBe('needs-setup');
    expect(result.evidence).toMatchObject({
      reason: expect.stringContaining('operational'),
    });
  });

  it('downgrades a pass with no evidence at all', () => {
    const result = enforcePassEvidenceContract({ disposition: 'pass' });
    expect(result.disposition).toBe('needs-setup');
  });

  it('keeps a pass grounded in operational evidence', () => {
    const result = enforcePassEvidenceContract({
      disposition: 'pass',
      evidence: { basis: 'operational', note: 'audit_log shows the deploy' },
    });
    expect(result.disposition).toBe('pass');
  });

  it('leaves fail and needs-setup dispositions untouched', () => {
    const fail = enforcePassEvidenceContract({
      disposition: 'fail',
      evidence: { basis: 'source' },
    });
    expect(fail.disposition).toBe('fail');

    const needsSetup = enforcePassEvidenceContract({
      disposition: 'needs-setup',
    });
    expect(needsSetup.disposition).toBe('needs-setup');
  });
});
