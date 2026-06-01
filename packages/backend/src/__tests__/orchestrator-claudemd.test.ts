import { describe, it, expect } from 'vitest';
import { buildOrchestratorClaudeMd } from '../session/orchestrator-claudemd';

const baseParams = {
  taskName: 'test-task',
  taskUrl: 'https://notion.so/test-task',
  projectContextUrl: 'https://notion.so/project',
  targetBranch: 'dev',
  worktreePath: '/worktrees/abc123',
};

describe('buildOrchestratorClaudeMd — Pre-PR Gate', () => {
  it('does not include lint or format:check commands by default', () => {
    const output = buildOrchestratorClaudeMd(baseParams);
    const prGateSection = output.slice(
      output.indexOf('## Pre-PR Gate'),
      output.indexOf('## Forbidden Actions'),
    );
    expect(prGateSection).not.toContain('npm run lint');
    expect(prGateSection).not.toContain('npm run format:check');
  });

  it('shows fallback when verify is omitted', () => {
    const output = buildOrchestratorClaudeMd(baseParams);
    expect(output).toContain(
      'No local verify step configured — CI is the gate.',
    );
  });

  it('shows fallback when verify is an empty array', () => {
    const output = buildOrchestratorClaudeMd({ ...baseParams, verify: [] });
    expect(output).toContain(
      'No local verify step configured — CI is the gate.',
    );
  });

  it('lists each verify command in numbered steps', () => {
    const output = buildOrchestratorClaudeMd({
      ...baseParams,
      verify: ['npx tsc --noEmit', 'npx vite build'],
    });
    const prGateSection = output.slice(
      output.indexOf('## Pre-PR Gate'),
      output.indexOf('## Forbidden Actions'),
    );
    expect(prGateSection).toContain('`npx tsc --noEmit`');
    expect(prGateSection).toContain('`npx vite build`');
    expect(prGateSection).not.toContain('No local verify step');
  });

  it('stage step appears after verify commands', () => {
    const output = buildOrchestratorClaudeMd({
      ...baseParams,
      verify: ['npx tsc --noEmit', 'npx vite build'],
    });
    const buildIdx = output.indexOf('npx vite build');
    const stageIdx = output.indexOf('Stage only your implementation files');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(stageIdx).toBeGreaterThan(buildIdx);
  });
});

describe('buildOrchestratorClaudeMd — taskBackend wording', () => {
  describe('notion backend (default)', () => {
    it('Task Assignment uses "Notion task" label', () => {
      const output = buildOrchestratorClaudeMd(baseParams);
      const assignSection = output.slice(
        output.indexOf('## Task Assignment'),
        output.indexOf('## Lifecycle'),
      );
      expect(assignSection).toContain('**Notion task**');
    });

    it('Lifecycle step 1 fetches Notion pages', () => {
      const output = buildOrchestratorClaudeMd(baseParams);
      expect(output).toContain('Fetch the Notion task page and project context page.');
    });

    it('Status Ownership uses Notion wording', () => {
      const output = buildOrchestratorClaudeMd(baseParams);
      const statusSection = output.slice(
        output.indexOf('## Status Ownership'),
        output.indexOf('## Efficiency Rules'),
      );
      expect(statusSection).toContain('Do NOT update Notion task status.');
      expect(statusSection).toContain('Do NOT call any Notion API to change task status.');
    });

    it('PR body template uses "## Notion Task"', () => {
      const output = buildOrchestratorClaudeMd(baseParams);
      expect(output).toContain('## Notion Task');
    });

    it('matches snapshot', () => {
      expect(buildOrchestratorClaudeMd(baseParams)).toMatchSnapshot();
    });
  });

  describe('github backend', () => {
    const githubParams = { ...baseParams, taskBackend: 'github' as const };

    it('Task Assignment uses "GitHub issue" label', () => {
      const output = buildOrchestratorClaudeMd(githubParams);
      const assignSection = output.slice(
        output.indexOf('## Task Assignment'),
        output.indexOf('## Lifecycle'),
      );
      expect(assignSection).toContain('**GitHub issue**');
    });

    it('Lifecycle step 1 fetches via gh CLI', () => {
      const output = buildOrchestratorClaudeMd(githubParams);
      expect(output).toContain('Fetch the GitHub issue via the gh CLI.');
    });

    it('Status Ownership uses GitHub wording', () => {
      const output = buildOrchestratorClaudeMd(githubParams);
      const statusSection = output.slice(
        output.indexOf('## Status Ownership'),
        output.indexOf('## Efficiency Rules'),
      );
      expect(statusSection).toContain('Do NOT update GitHub issue status.');
      expect(statusSection).toContain('Do NOT call any GitHub API to change task status.');
    });

    it('PR body template uses "## GitHub Issue"', () => {
      const output = buildOrchestratorClaudeMd(githubParams);
      expect(output).toContain('## GitHub Issue');
    });

    it('contains no "Notion" substring (regression)', () => {
      const output = buildOrchestratorClaudeMd(githubParams);
      expect(output).not.toContain('Notion');
    });

    it('matches snapshot', () => {
      expect(buildOrchestratorClaudeMd(githubParams)).toMatchSnapshot();
    });
  });

  describe('jira backend', () => {
    const jiraParams = { ...baseParams, taskBackend: 'jira' as const };

    it('Task Assignment uses "Jira issue" label', () => {
      const output = buildOrchestratorClaudeMd(jiraParams);
      const assignSection = output.slice(
        output.indexOf('## Task Assignment'),
        output.indexOf('## Lifecycle'),
      );
      expect(assignSection).toContain('**Jira issue**');
    });

    it('Lifecycle step 1 fetches the Jira issue', () => {
      const output = buildOrchestratorClaudeMd(jiraParams);
      expect(output).toContain('Fetch the Jira issue.');
    });

    it('Status Ownership uses Jira wording', () => {
      const output = buildOrchestratorClaudeMd(jiraParams);
      const statusSection = output.slice(
        output.indexOf('## Status Ownership'),
        output.indexOf('## Efficiency Rules'),
      );
      expect(statusSection).toContain('Do NOT update Jira issue status.');
      expect(statusSection).toContain('Do NOT call any Jira API to change task status.');
    });

    it('PR body template uses "## Jira Issue"', () => {
      const output = buildOrchestratorClaudeMd(jiraParams);
      expect(output).toContain('## Jira Issue');
    });

    it('contains no "Notion" substring (regression)', () => {
      const output = buildOrchestratorClaudeMd(jiraParams);
      expect(output).not.toContain('Notion');
    });

    it('matches snapshot', () => {
      expect(buildOrchestratorClaudeMd(jiraParams)).toMatchSnapshot();
    });
  });

  describe('local backend', () => {
    const localParams = { ...baseParams, taskBackend: 'local' as const };

    it('Task Assignment uses "Task" label', () => {
      const output = buildOrchestratorClaudeMd(localParams);
      const assignSection = output.slice(
        output.indexOf('## Task Assignment'),
        output.indexOf('## Lifecycle'),
      );
      expect(assignSection).toContain('**Task**');
    });

    it('Lifecycle reads tasks.yaml instead of remote fetch', () => {
      const output = buildOrchestratorClaudeMd(localParams);
      expect(output).toContain('tasks.yaml');
      expect(output).toContain('skip remote fetch');
    });

    it('Status Ownership uses generic task source wording', () => {
      const output = buildOrchestratorClaudeMd(localParams);
      const statusSection = output.slice(
        output.indexOf('## Status Ownership'),
        output.indexOf('## Efficiency Rules'),
      );
      expect(statusSection).toContain('Do NOT update Task status.');
      expect(statusSection).toContain('Do NOT call any task source to change task status.');
    });

    it('PR body template uses "## Task"', () => {
      const output = buildOrchestratorClaudeMd(localParams);
      expect(output).toContain('## Task\n<link to the task page>');
    });

    it('contains no "Notion" substring (regression)', () => {
      const output = buildOrchestratorClaudeMd(localParams);
      expect(output).not.toContain('Notion');
    });

    it('matches snapshot', () => {
      expect(buildOrchestratorClaudeMd(localParams)).toMatchSnapshot();
    });
  });
});
