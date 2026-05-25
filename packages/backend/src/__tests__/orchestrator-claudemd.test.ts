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
