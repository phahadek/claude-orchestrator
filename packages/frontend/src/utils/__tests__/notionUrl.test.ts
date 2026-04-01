import { describe, it, expect } from 'vitest';
import { taskNameFromNotionUrl } from '../notionUrl';

describe('taskNameFromNotionUrl', () => {
  it('converts a full URL with slug + UUID to a readable title', () => {
    const url =
      'https://www.notion.so/bug-completed-sessions-stay-marked-as-Running-33422f9152f38167908ff30f10547e3e';
    expect(taskNameFromNotionUrl(url)).toBe(
      'Bug completed sessions stay marked as Running',
    );
  });

  it('converts a hyphenated slug without colons', () => {
    const url =
      'https://www.notion.so/ux-replace-session-card-title-with-Notion-task-name-33522f9152f3819f9fabffb8253dfb07';
    expect(taskNameFromNotionUrl(url)).toBe(
      'Ux replace session card title with Notion task name',
    );
  });

  it('falls back to raw URL when path has only a UUID (no slug)', () => {
    const url = 'https://www.notion.so/33422f9152f38167908ff30f10547e3e';
    expect(taskNameFromNotionUrl(url)).toBe(url);
  });

  it('falls back to raw URL for an invalid URL string', () => {
    const url = 'not-a-url';
    expect(taskNameFromNotionUrl(url)).toBe(url);
  });
});
