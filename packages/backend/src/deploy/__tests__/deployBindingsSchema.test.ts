/**
 * Tests for deployBindingsSchema (packages/backend/src/deploy/deployBindingsSchema.ts).
 */

import { describe, it, expect } from 'vitest';
import { validateDeployBindings, substituteBindings } from '../deployBindingsSchema';

describe('validateDeployBindings', () => {
  it('accepts a well-formed mapping of shell-identifier names to string values', () => {
    const result = validateDeployBindings({ DB_HOST: 'db.internal', _foo: 'bar' });
    expect(result).toEqual({ bindings: { DB_HOST: 'db.internal', _foo: 'bar' } });
  });

  it('treats an absent/null document as an empty binding map', () => {
    expect(validateDeployBindings(undefined)).toEqual({ bindings: {} });
    expect(validateDeployBindings(null)).toEqual({ bindings: {} });
  });

  it('rejects a non-mapping document', () => {
    const result = validateDeployBindings(['a', 'b']);
    expect('errors' in result).toBe(true);
  });

  it('rejects a binding name that is not a valid shell/env-var identifier', () => {
    const result = validateDeployBindings({ '1-bad-name': 'x' });
    if (!('errors' in result)) throw new Error('expected errors');
    expect(result.errors[0]).toMatch(/valid shell\/env-var identifier/);
  });

  it('rejects a non-string binding value', () => {
    const result = validateDeployBindings({ PORT: 5432 });
    if (!('errors' in result)) throw new Error('expected errors');
    expect(result.errors[0]).toMatch(/must be a string value/);
  });
});

describe('substituteBindings', () => {
  it('substitutes a braced reference', () => {
    const result = substituteBindings('curl ${HOST}/health', { HOST: 'db.internal' });
    expect(result).toEqual({ ok: true, value: 'curl db.internal/health' });
  });

  it('substitutes a bare reference', () => {
    const result = substituteBindings('echo $NAME', { NAME: 'proj' });
    expect(result).toEqual({ ok: true, value: 'echo proj' });
  });

  it('fails closed on an undefined binding reference', () => {
    const result = substituteBindings('curl ${MISSING}/health', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/undefined binding reference "MISSING"/);
    }
  });

  it('passes text through unchanged when it has no references', () => {
    const result = substituteBindings('plain text', { UNUSED: 'x' });
    expect(result).toEqual({ ok: true, value: 'plain text' });
  });
});
