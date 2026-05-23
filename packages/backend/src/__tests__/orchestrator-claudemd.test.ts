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
  it('includes npm run lint and npm run format:check by default', () => {
    const output = buildOrchestratorClaudeMd(baseParams);
    expect(output).toContain('npm run lint');
    expect(output).toContain('npm run format:check');
  });

  it('renders lint step after build step and before stage step', () => {
    const output = buildOrchestratorClaudeMd(baseParams);
    const buildIdx = output.indexOf('npx vite build');
    const lintIdx = output.indexOf('npm run lint');
    const formatIdx = output.indexOf('npm run format:check');
    const stageIdx = output.indexOf('Stage only your implementation files');

    expect(buildIdx).toBeGreaterThan(-1);
    expect(lintIdx).toBeGreaterThan(buildIdx);
    expect(formatIdx).toBeGreaterThan(lintIdx);
    expect(stageIdx).toBeGreaterThan(formatIdx);
  });

  it('respects lint and formatCheck overrides from prGate', () => {
    const output = buildOrchestratorClaudeMd({
      ...baseParams,
      prGate: {
        typeCheck: 'npx tsc --noEmit',
        build: 'npx vite build',
        lint: 'npx eslint . --custom-flag',
        formatCheck: 'npx prettier --check .',
      },
    });
    expect(output).toContain('npx eslint . --custom-flag');
    expect(output).toContain('npx prettier --check .');
    expect(output).not.toContain('npm run lint');
    expect(output).not.toContain('npm run format:check');
  });

  it('still includes lint and format steps when prGate is omitted entirely', () => {
    const output = buildOrchestratorClaudeMd({ ...baseParams });
    expect(output).toContain('npm run lint');
    expect(output).toContain('npm run format:check');
    expect(output).toContain('npx tsc --noEmit');
    expect(output).toContain('npx vite build');
  });

  it('uses default lint/format when prGate omits those fields', () => {
    const output = buildOrchestratorClaudeMd({
      ...baseParams,
      prGate: {
        typeCheck: 'custom tsc',
        build: 'custom build',
      },
    });
    expect(output).toContain('custom tsc');
    expect(output).toContain('custom build');
    expect(output).toContain('npm run lint');
    expect(output).toContain('npm run format:check');
  });
});
