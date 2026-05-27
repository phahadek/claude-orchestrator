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

  // GitHub OAuth variants
  it('redacts gho_* (GitHub OAuth token)', () => {
    expect(scrubSecrets('token=gho_abcdefghijklmnopqrst')).toBe('token=[REDACTED]');
  });

  it('redacts ghu_* (GitHub user-to-server token)', () => {
    expect(scrubSecrets('token=ghu_abcdefghijklmnopqrst')).toBe('token=[REDACTED]');
  });

  it('redacts ghr_* (GitHub refresh token)', () => {
    expect(scrubSecrets('token=ghr_abcdefghijklmnopqrst')).toBe('token=[REDACTED]');
  });

  it('redacts ghs_* (GitHub server-to-server token)', () => {
    expect(scrubSecrets('token=ghs_abcdefghijklmnopqrst')).toBe('token=[REDACTED]');
  });

  it('redacts ghi_* (GitHub installation token)', () => {
    expect(scrubSecrets('token=ghi_abcdefghijklmnopqrst')).toBe('token=[REDACTED]');
  });

  // Slack variants (tokens are fake/test-only, not real credentials)
  it('redacts xoxb-* (Slack bot token)', () => {
    expect(scrubSecrets('xoxb-FAKEWORKSPACE-FAKEUSER-FAKETOKEN')).toBe('[REDACTED]');
  });

  it('redacts xoxp-* (Slack user token)', () => {
    expect(scrubSecrets('xoxp-FAKEWORKSPACE-FAKEUSER-FAKETOKEN')).toBe('[REDACTED]');
  });

  it('redacts xoxa-* (Slack app token)', () => {
    expect(scrubSecrets('xoxa-FAKEWORKSPACE-FAKEUSER-FAKETOKEN')).toBe('[REDACTED]');
  });

  it('redacts xoxr-* (Slack refresh token)', () => {
    expect(scrubSecrets('xoxr-FAKEWORKSPACE-FAKEUSER-FAKETOKEN')).toBe('[REDACTED]');
  });

  it('redacts xoxs-* (Slack legacy token)', () => {
    expect(scrubSecrets('xoxs-FAKEWORKSPACE-FAKEUSER-FAKETOKEN')).toBe('[REDACTED]');
  });

  // Bearer context rule
  it('redacts Bearer token (opaque JWT)', () => {
    expect(scrubSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('redacts Bearer token case-insensitively', () => {
    expect(scrubSecrets('authorization: bearer xyz123abc')).toBe(
      'authorization: bearer [REDACTED]',
    );
  });

  it('redacts Bearer token with no length minimum', () => {
    expect(scrubSecrets('Authorization: Bearer short')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('redacts Bearer-wrapped prefixed token as single redaction', () => {
    expect(scrubSecrets('Authorization: Bearer ghp_abcdefghijklmnopqrst')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  // Nested object with Bearer context
  it('redacts Bearer tokens in nested objects', () => {
    const input = {
      headers: {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        other: 'safe-value',
      },
      token: 'gho_abcdefghijklmnopqrst',
    };
    const result = scrubSecrets(input);
    expect((result.headers as { authorization: string }).authorization).toBe(
      'Bearer [REDACTED]',
    );
    expect((result.headers as { other: string }).other).toBe('safe-value');
    expect((result as { token: string }).token).toBe('[REDACTED]');
  });
});
