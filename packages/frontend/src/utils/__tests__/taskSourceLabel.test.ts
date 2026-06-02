import { describe, it, expect } from 'vitest';
import {
  getTaskSourceLinkLabel,
  getTaskSourceShortLabel,
} from '../taskSourceLabel';

describe('getTaskSourceLinkLabel', () => {
  it("returns 'Notion ↗' for notion", () => {
    expect(getTaskSourceLinkLabel('notion')).toBe('Notion ↗');
  });

  it("returns 'Issue ↗' for github", () => {
    expect(getTaskSourceLinkLabel('github')).toBe('Issue ↗');
  });

  it("returns 'YAML' for yaml", () => {
    expect(getTaskSourceLinkLabel('yaml')).toBe('YAML');
  });

  it("returns 'Jira ↗' for jira", () => {
    expect(getTaskSourceLinkLabel('jira')).toBe('Jira ↗');
  });
});

describe('getTaskSourceShortLabel', () => {
  it("returns 'Notion' for notion", () => {
    expect(getTaskSourceShortLabel('notion')).toBe('Notion');
  });

  it("returns 'GitHub' for github", () => {
    expect(getTaskSourceShortLabel('github')).toBe('GitHub');
  });

  it("returns 'YAML' for yaml", () => {
    expect(getTaskSourceShortLabel('yaml')).toBe('YAML');
  });

  it("returns 'Jira' for jira", () => {
    expect(getTaskSourceShortLabel('jira')).toBe('Jira');
  });
});
