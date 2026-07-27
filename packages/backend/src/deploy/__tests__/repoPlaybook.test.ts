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

  it('carries no ssh remote-host bindings — this repo deploys in place, not over ssh', () => {
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, '.claude-deploy-playbook.yml'),
      'utf-8',
    );
    expect(raw).not.toMatch(/ssh\s+\S+@/);
  });

  it("sync-runtime runs a real rsync into this host's runtime directory", () => {
    const result = loadDeployPlaybook(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const syncStep = result.playbook.steps.find((s) => s.id === 'sync-runtime');
    expect(syncStep).toBeDefined();
    expect(syncStep?.command_or_prompt).toMatch(/^rsync\b/);
    expect(syncStep?.command_or_prompt).toMatch(/--delete/);
    expect(syncStep?.command_or_prompt).toContain('/srv/orchestrator/runtime/');
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

  it('has no step of kind agentic — the agentic spawner does not exist yet, so every agentic step stalls a run', () => {
    const result = loadDeployPlaybook(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const agenticSteps = result.playbook.steps.filter(
      (step) => step.kind === 'agentic',
    );
    expect(agenticSteps).toEqual([]);
  });

  it('report-in is a shell step that posts to the deploy report-in route with the registry project id, not the config-dir name', () => {
    const result = loadDeployPlaybook(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reportIn = result.playbook.steps.find((s) => s.id === 'report-in');
    expect(reportIn).toBeDefined();
    expect(reportIn?.kind).toBe('shell');
    expect(reportIn?.command_or_prompt).toMatch(/\/api\/deploy\/report-in\b/);
    expect(reportIn?.command_or_prompt).toContain(
      '\\"projectId\\":\\"claude-dashboard\\"',
    );
    expect(reportIn?.command_or_prompt).not.toContain('claude-orchestrator');
  });

  it('record-deployed-sha is still ordered after report-in and targets a directory that exists', () => {
    const result = loadDeployPlaybook(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.playbook.steps.map((s) => s.id);
    const reportInIndex = ids.indexOf('report-in');
    const recordShaIndex = ids.indexOf('record-deployed-sha');
    expect(reportInIndex).toBeGreaterThanOrEqual(0);
    expect(recordShaIndex).toBeGreaterThan(reportInIndex);

    const recordSha = result.playbook.steps.find(
      (s) => s.id === 'record-deployed-sha',
    );
    expect(recordSha?.kind).toBe('shell');
    expect(recordSha?.is_prod_mutating).toBe(true);

    const match = recordSha?.command_or_prompt.match(/>\s*(\S+)/);
    expect(match).toBeTruthy();
    const targetPath = match![1];
    expect(path.isAbsolute(targetPath)).toBe(true);
    expect(fs.existsSync(path.dirname(targetPath))).toBe(true);
  });

  it('report-in and record-deployed-sha carry no rollback_ref — they are informational bookkeeping after the last prod-mutating step, with nothing to roll back', () => {
    const result = loadDeployPlaybook(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reportIn = result.playbook.steps.find((s) => s.id === 'report-in');
    const recordSha = result.playbook.steps.find(
      (s) => s.id === 'record-deployed-sha',
    );
    expect(reportIn?.rollback_ref).toBeUndefined();
    expect(recordSha?.rollback_ref).toBeUndefined();
  });

  it('carries no device-token credential literal — the report-in step references it indirectly via env', () => {
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, '.claude-deploy-playbook.yml'),
      'utf-8',
    );
    expect(raw).toContain('$ORCHESTRATOR_DEVICE_TOKEN');
    // A device token is a long opaque string; guard against anything that
    // looks like one having been pasted in literally alongside the env ref.
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
  });
});
