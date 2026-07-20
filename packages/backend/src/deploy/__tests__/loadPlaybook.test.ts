/**
 * Tests for loadDeployPlaybook (packages/backend/src/deploy/loadPlaybook.ts).
 *
 * AC: a valid .claude-deploy-playbook.yml parses to the typed model; an
 * absent or invalid one is reported (not improvised) — /deploy stops on it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadDeployPlaybook } from '../loadPlaybook';

describe('loadDeployPlaybook', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-playbook-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports absent when .claude-deploy-playbook.yml does not exist', () => {
    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no deploy playbook found/);
    }
  });

  it('parses a valid playbook to the typed model', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      `
steps:
  - id: pull
    kind: shell
    command_or_prompt: "git pull"
    is_prod_mutating: false
    supports_dry_run: true
  - id: restart
    kind: confirm-gate
    command_or_prompt: "systemctl restart app"
    run_as: deploy
    is_prod_mutating: true
    changed_paths:
      - "packages/backend/**"
    rollback_ref: pull
hazards:
  - "never run npm as root"
failure_diagnoses:
  - symptom: "502 after restart"
    cause: "service not yet up"
    action: "poll health endpoint"
companions:
  - name: sidecar
    host: sidecar-host
    trigger_paths:
      - "packages/sidecar/**"
    redeploy_instruction: "ssh sidecar-host and run deploy.sh"
    hazards:
      - "never restart sidecar during market hours"
`,
    );

    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.playbook.steps).toHaveLength(2);
    expect(result.playbook.steps[0]).toMatchObject({
      id: 'pull',
      kind: 'shell',
      is_prod_mutating: false,
    });
    expect(result.playbook.steps[1]).toMatchObject({
      id: 'restart',
      kind: 'confirm-gate',
      run_as: 'deploy',
      is_prod_mutating: true,
      changed_paths: ['packages/backend/**'],
      rollback_ref: 'pull',
    });
    expect(result.playbook.hazards).toEqual(['never run npm as root']);
    expect(result.playbook.failure_diagnoses).toEqual([
      {
        symptom: '502 after restart',
        cause: 'service not yet up',
        action: 'poll health endpoint',
      },
    ]);
    expect(result.playbook.companions).toEqual([
      {
        name: 'sidecar',
        host: 'sidecar-host',
        trigger_paths: ['packages/sidecar/**'],
        redeploy_instruction: 'ssh sidecar-host and run deploy.sh',
        hazards: ['never restart sidecar during market hours'],
      },
    ]);
  });

  it('reports invalid instead of falling back to a guessed playbook', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      `
steps:
  - id: pull
    kind: not-a-real-kind
    command_or_prompt: "git pull"
    is_prod_mutating: false
`,
    );

    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid deploy playbook/);
      expect(result.reason).toMatch(/kind/);
    }
  });

  it('reports invalid when steps is empty', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      'steps: []\n',
    );
    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(false);
  });

  it('reports invalid when the YAML fails to parse', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      'steps: [\n  - this is not valid yaml: [\n',
    );
    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/failed to parse/);
    }
  });
});
