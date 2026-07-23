/**
 * Validates the orchestrator's own repo-committed `.claude-deploy-playbook.yml`
 * against playbookSchema — the file `/deploy` actually reads for this project.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadDeployPlaybook } from '../loadPlaybook';

const REPO_ROOT = path.join(__dirname, '../../../../..');

describe('the repo-committed deploy playbook', () => {
  it('exists at the repo root and validates against playbookSchema', () => {
    const result = loadDeployPlaybook(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.playbook.steps.length).toBeGreaterThan(0);
  });

  it('is host-agnostic: no absolute host paths or hostnames leak into it', () => {
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, '.claude-deploy-playbook.yml'),
      'utf-8',
    );
    expect(raw).not.toMatch(/\/srv\//);
    expect(raw).not.toMatch(/\/home\//);
    expect(raw).not.toMatch(/ssh\s+\S+@/);
  });

  it("prod-mutating steps carry no run_as — they run as the engine's own runtime user, not a sudo -u switch to a placeholder that may not exist on the host", () => {
    const result = loadDeployPlaybook(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const prodMutatingSteps = result.playbook.steps.filter(
      (step) => step.is_prod_mutating,
    );
    expect(prodMutatingSteps.length).toBeGreaterThan(0);
    for (const step of prodMutatingSteps) {
      expect(step.run_as).toBeUndefined();
    }
  });
});
