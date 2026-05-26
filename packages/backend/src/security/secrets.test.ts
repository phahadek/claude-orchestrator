import { describe, it, expect, afterEach } from 'vitest';
import {
  getSecret,
  setSecretProvider,
  resetSecretProvider,
} from './secrets';

afterEach(() => {
  resetSecretProvider();
  delete process.env['_TEST_SECRET_KEY'];
});

describe('getSecret', () => {
  it('returns env value when env is set', () => {
    process.env['_TEST_SECRET_KEY'] = 'test-value-123';
    expect(getSecret('_TEST_SECRET_KEY')).toBe('test-value-123');
  });

  it('returns undefined when env is not set', () => {
    expect(getSecret('_TEST_SECRET_KEY')).toBeUndefined();
  });

  it('returns NOTION_API_KEY from env', () => {
    const original = process.env['NOTION_API_KEY'];
    process.env['NOTION_API_KEY'] = 'ntn_testkey1234567890';
    expect(getSecret('NOTION_API_KEY')).toBe('ntn_testkey1234567890');
    if (original === undefined) {
      delete process.env['NOTION_API_KEY'];
    } else {
      process.env['NOTION_API_KEY'] = original;
    }
  });

  it('uses a custom provider when one is installed', () => {
    setSecretProvider((name) => (name === 'MY_SECRET' ? 'vault-value' : undefined));
    expect(getSecret('MY_SECRET')).toBe('vault-value');
    expect(getSecret('OTHER')).toBeUndefined();
  });

  it('falls back to env after resetSecretProvider', () => {
    setSecretProvider(() => 'overridden');
    resetSecretProvider();
    process.env['_TEST_SECRET_KEY'] = 'env-val';
    expect(getSecret('_TEST_SECRET_KEY')).toBe('env-val');
  });
});
