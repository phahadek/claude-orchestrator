import { describe, it, expect } from 'vitest';
import { buildSessionContext } from './ContextBuilder';

const BASE_PARAMS = {
  taskName: 'some-task',
  taskUrl: 'https://example.com/task/1',
  projectContextUrl: 'https://example.com/context',
  targetBranch: 'dev',
  projectDir: '/tmp/does-not-exist-project-dir',
  worktreePath: '/tmp/does-not-exist-worktree',
};

describe('buildSessionContext()', () => {
  it('accepts taskBackend: "jira" and produces context without throwing', () => {
    const result = buildSessionContext({
      ...BASE_PARAMS,
      taskBackend: 'jira',
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('Jira issue');
    expect(result).toContain('## Jira Issue');
  });

  it('falls back to notion wording when taskBackend is absent', () => {
    const result = buildSessionContext(BASE_PARAMS);
    expect(result).toContain('Notion task');
    expect(result).toContain('## Notion Task');
  });
});
