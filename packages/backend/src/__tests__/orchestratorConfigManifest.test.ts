import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadOrchestratorConfig } from '../session/orchestrator-config';

// The repo root's own .claude-orchestrator.yml is what the orchestrator
// reads for this project (claude-dashboard). test: [] silently disables the
// test.request lane (resolveTestRequestExecutionInputs returns null), so a
// regression here goes unnoticed until every test.request on this project
// is refused. Assert it stays populated and stays in sync with what CI
// actually runs, so the two can't drift apart.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

describe('.claude-orchestrator.yml test: manifest', () => {
  it('declares a non-empty test command list', () => {
    const config = loadOrchestratorConfig(REPO_ROOT);
    expect(config.test.length).toBeGreaterThan(0);
  });

  it('matches the test commands CI runs in .github/workflows/build.yml', () => {
    const config = loadOrchestratorConfig(REPO_ROOT);
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, '.github', 'workflows', 'build.yml'),
      'utf-8',
    );
    const ciTestCommands = [...workflow.matchAll(/run: (npm run test -w \S+)/g)].map(
      (m) => m[1],
    );

    expect(ciTestCommands.length).toBeGreaterThan(0);
    expect(new Set(config.test)).toEqual(new Set(ciTestCommands));
  });
});
