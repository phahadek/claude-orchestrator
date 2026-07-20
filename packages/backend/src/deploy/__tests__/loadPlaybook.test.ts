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
import type {
  StepDescriptor,
  StepKind,
  FailureDiagnosis,
  CompanionDecl,
} from '../playbookSchema';

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

    const shellKind: StepKind = 'shell';
    const expectedFirstStep: Pick<StepDescriptor, 'id' | 'kind' | 'is_prod_mutating'> = {
      id: 'pull',
      kind: shellKind,
      is_prod_mutating: false,
    };
    const expectedSecondStep: Pick<
      StepDescriptor,
      'id' | 'kind' | 'run_as' | 'is_prod_mutating' | 'changed_paths' | 'rollback_ref'
    > = {
      id: 'restart',
      kind: 'confirm-gate',
      run_as: 'deploy',
      is_prod_mutating: true,
      changed_paths: ['packages/backend/**'],
      rollback_ref: 'pull',
    };
    const expectedDiagnosis: FailureDiagnosis = {
      symptom: '502 after restart',
      cause: 'service not yet up',
      action: 'poll health endpoint',
    };
    const expectedCompanion: CompanionDecl = {
      name: 'sidecar',
      host: 'sidecar-host',
      trigger_paths: ['packages/sidecar/**'],
      redeploy_instruction: 'ssh sidecar-host and run deploy.sh',
      hazards: ['never restart sidecar during market hours'],
    };

    expect(result.playbook.steps).toHaveLength(2);
    expect(result.playbook.steps[0]).toMatchObject(expectedFirstStep);
    expect(result.playbook.steps[1]).toMatchObject(expectedSecondStep);
    expect(result.playbook.hazards).toEqual(['never run npm as root']);
    expect(result.playbook.failure_diagnoses).toEqual([expectedDiagnosis]);
    expect(result.playbook.companions).toEqual([expectedCompanion]);
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
