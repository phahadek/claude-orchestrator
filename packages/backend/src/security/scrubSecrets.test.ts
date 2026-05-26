import { describe, it, expect } from 'vitest';
import { scrubSecrets } from './scrubSecrets';

describe('scrubSecrets', () => {
  it('redacts sk-ant-* pattern in a flat string', () => {
    expect(scrubSecrets('key is sk-ant-api03-abc1234567890xyz')).toBe(
      'key is [REDACTED]',
    );
  });

  it('redacts ghp_* pattern in a flat string', () => {
    expect(scrubSecrets('token ghp_abcdefghijklmnopqrst')).toBe(
      'token [REDACTED]',
    );
  });

  it('redacts ntn_* pattern in a flat string', () => {
    expect(scrubSecrets('notion ntn_abcdefghijklmnopqrst')).toBe(
      'notion [REDACTED]',
    );
  });

  it('redacts secret_* pattern in a flat string', () => {
    expect(scrubSecrets('value secret_abcdefghijklmnopqrst')).toBe(
      'value [REDACTED]',
    );
  });

  it('redacts secrets at any depth in a nested object', () => {
    const input = {
      level1: {
        key: 'sk-ant-api03-supersecretkey01234',
        level2: {
          arr: ['ghp_sometoken1234567890', 'safe-value'],
          nested: { token: 'ntn_notiontoken1234567890' },
        },
      },
    };
    const result = scrubSecrets(input);
    expect((result.level1 as { key: string }).key).toBe('[REDACTED]');
    expect((result.level1.level2 as { arr: string[] }).arr[0]).toBe(
      '[REDACTED]',
    );
    expect((result.level1.level2 as { arr: string[] }).arr[1]).toBe(
      'safe-value',
    );
    expect((result.level1.level2.nested as { token: string }).token).toBe(
      '[REDACTED]',
    );
  });

  it('leaves non-secret strings unchanged', () => {
    expect(scrubSecrets('hello world')).toBe('hello world');
    expect(scrubSecrets('sk-ant-short')).toBe('sk-ant-short'); // too short
  });

  it('passes through numbers, booleans, and null unchanged', () => {
    expect(scrubSecrets(42)).toBe(42);
    expect(scrubSecrets(true)).toBe(true);
    expect(scrubSecrets(null)).toBe(null);
  });

  it('does not mutate the input object', () => {
    const input = { secret: 'sk-ant-api03-mutationcheck1234' };
    scrubSecrets(input);
    expect(input.secret).toBe('sk-ant-api03-mutationcheck1234');
  });

  it('redacts multiple secrets in a single string', () => {
    const s = 'a=sk-ant-api03-first1234567890 b=ghp_second1234567890';
    expect(scrubSecrets(s)).toBe('a=[REDACTED] b=[REDACTED]');
  });
});
