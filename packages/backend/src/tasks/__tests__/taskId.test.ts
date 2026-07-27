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
