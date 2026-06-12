import { describe, it, expect } from 'vitest';
import { ALLOWED_TOOLS } from '../config';

describe('ALLOWED_TOOLS — backend-owned PR operations are excluded', () => {
  it('does not contain the mcp__github__* wildcard', () => {
    expect(ALLOWED_TOOLS).not.toContain('mcp__github__*');
  });

  it('does not grant sessions create_pull_request access', () => {
    expect(ALLOWED_TOOLS).not.toContain('mcp__github__create_pull_request');
  });

  it('does not grant sessions merge_pull_request access', () => {
    expect(ALLOWED_TOOLS).not.toContain('mcp__github__merge_pull_request');
  });

  it('retains push_files so sessions can push code', () => {
    expect(ALLOWED_TOOLS).toContain('mcp__github__push_files');
  });

  it('retains github read tools sessions need', () => {
    const readTools = [
      'mcp__github__get_issue',
      'mcp__github__get_pull_request',
      'mcp__github__get_pull_request_files',
      'mcp__github__list_pull_requests',
      'mcp__github__list_issues',
      'mcp__github__search_code',
      'mcp__github__search_issues',
      'mcp__github__search_repositories',
    ];
    for (const tool of readTools) {
      expect(ALLOWED_TOOLS).toContain(tool);
    }
  });
});
