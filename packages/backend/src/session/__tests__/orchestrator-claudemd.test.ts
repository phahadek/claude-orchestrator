import { describe, it, expect } from 'vitest';
import { buildOrchestratorClaudeMd } from '../orchestrator-claudemd';
import { buildSessionContext } from '../ContextBuilder';

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

  describe('local-context removal', () => {
    it('never includes a host-local-context section', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).not.toContain('## Local Context');
      expect(output).not.toContain('local-context.md');
    });
  });

  describe('Responding to Review Comments section (MCP verdict-delivery tool)', () => {
    it('documents the review.disposition tool and the three disposition values', () => {
      const output = buildOrchestratorClaudeMd(BASE_PARAMS);
      expect(output).toContain('## Responding to Review Comments');
      expect(output).toContain('mcp__orchestrator__review.disposition');
      expect(output).toContain('comment_id');
      expect(output).toContain('disposition');
      expect(output).toContain('"addressed"');
      expect(output).toContain('"wont_fix"');
      expect(output).toContain('"out_of_scope"');
      expect(output).toContain('reason');
    });

    it('omits the section for local-only git mode (no PR review threads)', () => {
      const output = buildOrchestratorClaudeMd({
        ...BASE_PARAMS,
        gitMode: 'local-only',
      });
      expect(output).not.toContain('## Responding to Review Comments');
    });
  });
});

describe('assembled session instructions include the review.disposition MCP tool', () => {
  const contextParams = {
    taskName: 'test-task',
    taskUrl: 'https://example.com/task',
    projectContextUrl: 'https://example.com/project',
    targetBranch: 'dev',
    projectDir: '/tmp/project',
    worktreePath: '/tmp/worktree',
  };

  it('initial-dispatch path (buildSessionContext without pre-fetched task content)', () => {
    // Mirrors SessionManager's initial dispatch call site (SessionManager.ts,
    // the `buildSessionContext` call inside the non-planning/non-review branch).
    const output = buildSessionContext(contextParams);
    expect(output).toContain('## Responding to Review Comments');
    expect(output).toContain('mcp__orchestrator__review.disposition');
  });

  it('resume-rebuild path (buildSessionContext rebuilt from a persisted session row)', () => {
    // Mirrors SessionManager's `_buildAndWriteResumeSystemPrompt`, which rebuilds
    // the system prompt for a resumed session from the DB row rather than fresh
    // dispatch params — guards against a cached/short-circuited resume path that
    // silently skips this instruction.
    const output = buildSessionContext({
      ...contextParams,
      taskContent: 'pre-fetched task spec markdown',
    });
    expect(output).toContain('## Responding to Review Comments');
    expect(output).toContain('mcp__orchestrator__review.disposition');
  });
});
