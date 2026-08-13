import { describe, it, expect } from 'vitest';
import { taskNameFromNotionUrl } from '../notionUrl';

describe('taskNameFromNotionUrl', () => {
  it('converts a full URL with slug + UUID to a readable title', () => {
    const url =
      'https://www.notion.so/example-task-with-slug-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(taskNameFromNotionUrl(url)).toBe('Example task with slug');
  });

  it('converts a hyphenated slug without colons', () => {
    const url =
      'https://www.notion.so/another-example-task-cccccccccccccccccccccccccccccccc';
    expect(taskNameFromNotionUrl(url)).toBe('Another example task');
  });

  it('falls back to raw URL when path has only a UUID (no slug)', () => {
    const url = 'https://www.notion.so/dddddddddddddddddddddddddddddddd';
    expect(taskNameFromNotionUrl(url)).toBe(url);
  });

  it('falls back to raw URL for an invalid URL string', () => {
    const url = 'not-a-url';
    expect(taskNameFromNotionUrl(url)).toBe(url);
  });

  it('decodes percent-encoded non-ASCII characters (emoji, em-dash) instead of returning garbled bytes', () => {
    const url =
      'https://www.notion.so/' +
      encodeURIComponent('fix-emoji-🎉-task—name') +
      '-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    expect(taskNameFromNotionUrl(url)).toBe('Fix emoji 🎉 task—name');
  });

  it('falls back gracefully without throwing on a malformed percent-sequence', () => {
    const url =
      'https://www.notion.so/fix-100%zz-done-ffffffffffffffffffffffffffffffff';
    expect(() => taskNameFromNotionUrl(url)).not.toThrow();
    expect(taskNameFromNotionUrl(url)).toBe('Fix 100%zz done');
  });
});
