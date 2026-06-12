import { describe, it, expect } from 'vitest';
import { buildOrchestratorClaudeMd } from '../orchestrator-claudemd';

const BASE_PARAMS = {
  taskName: 'test-task',
  taskUrl: 'https://example.com/task',
  projectContextUrl: 'https://example.com/project',
  targetBranch: 'dev',
  worktreePath: '/tmp/worktree',
};

describe('buildOrchestratorClaudeMd', () => {
  describe('Context Efficiency section', () => {
    it('includes the Context Efficiency heading', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).toContain('## Context Efficiency');
    });

    it('includes the grep-first / offset-limit guidance bullet', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).toContain('offset');
      expect(output).toContain('limit');
      expect(output).toContain('Grep first');
    });

    it('includes the scoped-grep guidance bullet', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).toContain('Scope every Grep');
    });

    it('includes the no-re-read-after-edit guidance bullet', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).toContain("Don't re-read after editing");
    });

    it('includes the reference-module guidance bullet', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).toContain('Reference modules');
    });

    it('renders for all task-backend variants', () => {
      const backends = ['notion', 'local', 'jira', 'github'] as const;
      for (const taskBackend of backends) {
        const output = buildOrchestratorClaudeMd({
          ...BASE_PARAMS,
          taskBackend,
        });
        expect(output).toContain('## Context Efficiency');
      }
    });

    it('renders for local-only git mode', () => {
      const output = buildOrchestratorClaudeMd({
        ...BASE_PARAMS,
        gitMode: 'local-only',
      });
      expect(output).toContain('## Context Efficiency');
    });

    it('stays within a reasonable length budget (under 20 000 chars)', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output.length).toBeLessThan(20_000);
    });
  });

  describe('PR body marker (no scratch-file instructions)', () => {
    it('instructs sessions to emit a <pr-body> marker, not write a file', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).toContain('<pr-body>');
    });

    it('does NOT instruct writing pr-body.md', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).not.toContain('pr-body.md');
    });

    it('does NOT instruct running gh pr create', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).not.toContain('gh pr create');
    });

    it('does NOT include --body-file flag in PR creation instructions', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).not.toContain('--body-file');
    });

    it('omits PR format section and marker for local-only git mode', () => {
      const output = buildOrchestratorClaudeMd({
        ...BASE_PARAMS,
        gitMode: 'local-only',
      });
      expect(output).not.toContain('## PR Format Standards');
      expect(output).not.toContain('<pr-body>');
    });
  });
});
