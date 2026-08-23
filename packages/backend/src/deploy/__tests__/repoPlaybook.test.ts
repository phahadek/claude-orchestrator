/**
 * Validates the orchestrator's own repo-committed `.claude-deploy-playbook.yml`
 * against playbookSchema — the file `/deploy` actually reads for this project.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { loadDeployPlaybook } from '../loadPlaybook';
import { validateDeployBindings } from '../deployBindingsSchema';

const REPO_ROOT = path.join(__dirname, '../../../../..');
const BINDINGS_PATH = path.join(
  REPO_ROOT,
  'config',
  'projects',
  'claude-orchestrator',
  'deploy-bindings.yml',
);

function loadRepoBindings() {
  const raw = yaml.load(fs.readFileSync(BINDINGS_PATH, 'utf-8'));
  const result = validateDeployBindings(raw);
  if ('errors' in result) {
    throw new Error(
      `config/projects/claude-orchestrator/deploy-bindings.yml is invalid: ${result.errors.join('; ')}`,
    );
  }
  return result.bindings;
}

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

  it("sync-runtime runs a real rsync into this host's runtime directory, referenced via the RUNTIME_DIR binding", () => {
    const result = loadDeployPlaybook(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const syncStep = result.playbook.steps.find((s) => s.id === 'sync-runtime');
    expect(syncStep).toBeDefined();
    expect(syncStep?.command_or_prompt).toMatch(/^rsync\b/);
    expect(syncStep?.command_or_prompt).toMatch(/--delete/);
    expect(syncStep?.command_or_prompt).toContain('$RUNTIME_DIR');
    expect(syncStep?.command_or_prompt).not.toMatch(/\/srv\/orchestrator/);

    const bindings = loadRepoBindings();
    expect(bindings.RUNTIME_DIR).toBe('/srv/orchestrator/runtime');
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

  it('report-in is an engine-handled step that carries no command — no credential, no curl, no loopback hop', () => {
    const result = loadDeployPlaybook(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reportIn = result.playbook.steps.find((s) => s.id === 'report-in');
    expect(reportIn).toBeDefined();
    expect(reportIn?.kind).toBe('report-in');
    expect(reportIn?.command_or_prompt).toBeUndefined();
  });

  it('record-deployed-sha is still ordered after report-in and targets the DEPLOYED_SHA_PATH binding', () => {
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
    // Post-success bookkeeping (runs after verify already passed) — a
    // failure here means "re-write the marker," never a rollback
    // candidate, so it's deliberately not prod-mutating.
    expect(recordSha?.is_prod_mutating).toBe(false);
    expect(recordSha?.command_or_prompt).toContain('$DEPLOYED_SHA_PATH');
    expect(recordSha?.command_or_prompt).not.toMatch(/\/srv\/orchestrator/);

    const bindings = loadRepoBindings();
    const targetPath = bindings.DEPLOYED_SHA_PATH;
    expect(targetPath).toBeDefined();
    expect(path.isAbsolute(targetPath)).toBe(true);
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

  it("restart's identity_capture curls the build-sha route's actual mount path (/api/deploy/build-sha), not the unmounted SPA-shadowed /deploy/build-sha", () => {
    const result = loadDeployPlaybook(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const restart = result.playbook.steps.find((s) => s.id === 'restart');
    expect(restart).toBeDefined();
    expect(restart?.identity_capture).toContain(
      'http://localhost:3000/api/deploy/build-sha',
    );
  });

  it('carries no device-token credential literal — report-in no longer references it at all', () => {
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, '.claude-deploy-playbook.yml'),
      'utf-8',
    );
    expect(raw).not.toContain('ORCHESTRATOR_DEVICE_TOKEN');
    // A device token is a long opaque string; guard against anything that
    // looks like one having been pasted in literally.
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
  });
});
