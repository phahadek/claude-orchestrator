import { describe, it, expect } from 'vitest';
import { normalizeTaskId } from '../taskId';

describe('normalizeTaskId — hyphenation canonicalization', () => {
  const hyphenated = '3aa22f91-52f3-81a7-a58b-db94fe13e649';
  const hyphenless = '3aa22f9152f381a7a58bdb94fe13e649';
  const expected = `notion:${hyphenated}`;

  it('canonicalizes a bare hyphenless Notion UUID', () => {
    expect(normalizeTaskId(hyphenless)).toBe(expected);
  });

  it('canonicalizes a bare hyphenated Notion UUID (idempotent)', () => {
    expect(normalizeTaskId(hyphenated)).toBe(expected);
  });

  it('canonicalizes a notion:-prefixed hyphenless id', () => {
    expect(normalizeTaskId(`notion:${hyphenless}`)).toBe(expected);
  });

  it('canonicalizes a notion:-prefixed hyphenated id (idempotent)', () => {
    expect(normalizeTaskId(`notion:${hyphenated}`)).toBe(expected);
  });

  it('is case-insensitive on the hex digits', () => {
    expect(normalizeTaskId(hyphenless.toUpperCase())).toBe(expected);
  });

  it('leaves non-UUID-shaped ids (e.g. Jira keys) untouched', () => {
    expect(normalizeTaskId('jira:PROJ-123')).toBe('jira:PROJ-123');
  });

  it('leaves short yaml slugs untouched', () => {
    expect(normalizeTaskId('yaml:my-task-slug')).toBe('yaml:my-task-slug');
  });
});

describe('normalizeTaskId — default-source parameter', () => {
  const hyphenated = '3aa22f91-52f3-81a7-a58b-db94fe13e649';

  it('defaults an unprefixed id to notion: when no default-source is given', () => {
    expect(normalizeTaskId(hyphenated)).toBe(`notion:${hyphenated}`);
  });

  it('wraps an unprefixed id under the given default source when one is passed', () => {
    expect(normalizeTaskId('my-task-slug', 'yaml')).toBe('yaml:my-task-slug');
  });

  it('still keeps an already-prefixed id\'s own source, ignoring the default-source argument', () => {
    expect(normalizeTaskId(`notion:${hyphenated}`, 'yaml')).toBe(
      `notion:${hyphenated}`,
    );
  });
});
