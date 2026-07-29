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
    const expectedFirstStep: Pick<
      StepDescriptor,
      'id' | 'kind' | 'is_prod_mutating'
    > = {
      id: 'pull',
      kind: shellKind,
      is_prod_mutating: false,
    };
    const expectedSecondStep: Pick<
      StepDescriptor,
      | 'id'
      | 'kind'
      | 'run_as'
      | 'is_prod_mutating'
      | 'changed_paths'
      | 'rollback_ref'
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

  it('rejects a shell step whose command is prose instead of an executable command', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      `
steps:
  - id: sync-runtime
    kind: shell
    command_or_prompt: "rsync the built workspace into the runtime directory, excluding .git, .claude, *.db*, and .env"
    is_prod_mutating: true
`,
    );

    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid deploy playbook/);
      expect(result.reason).toMatch(
        /command_or_prompt for a shell step must be an executable command, not prose/,
      );
    }
  });

  it('accepts valid shell commands for shell and validation steps', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      `
steps:
  - id: sync
    kind: shell
    command_or_prompt: "rsync -az --exclude node_modules ./dist/ deploy@target:/srv/app/"
    is_prod_mutating: true
  - id: install
    kind: shell
    command_or_prompt: "npm ci"
    is_prod_mutating: false
  - id: fetch
    kind: shell
    command_or_prompt: "git fetch origin"
    is_prod_mutating: false
  - id: health
    kind: validation
    command_or_prompt: "curl -sf http://localhost:3000/health"
    is_prod_mutating: false
    poll_until: "curl -sf http://localhost:3000/health"
`,
    );

    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(true);
  });

  it('accepts the real rsync -a sync-runtime command despite the bare short flag', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      `
steps:
  - id: sync-runtime
    kind: shell
    command_or_prompt: "rsync -a --delete --exclude='.git/' --exclude='.claude/' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='.env' ./ /srv/orchestrator/runtime/"
    is_prod_mutating: true
`,
    );

    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(true);
  });

  it('accepts short flags, path segments, and flag values that merely contain a stopword substring', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      `
steps:
  - id: archive
    kind: shell
    command_or_prompt: "tar -an -f /srv/into/the/archive.tar --exclude=the ./dist/"
    is_prod_mutating: false
`,
    );

    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(true);
  });

  it('accepts the full current .claude-deploy-playbook.yml from this repo checkout', () => {
    const repoRoot = path.resolve(__dirname, '../../../../..');
    const result = loadDeployPlaybook(repoRoot);
    expect(result.ok).toBe(true);
  });

  it('accepts a natural-language prompt for an agentic step', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      `
steps:
  - id: sanity-check
    kind: agentic
    command_or_prompt: "review the deploy logs for unexpected errors and summarize findings"
    is_prod_mutating: false
`,
    );

    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(true);
  });

  it('accepts a report-in step with no command_or_prompt', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      `
steps:
  - id: report-in
    kind: report-in
    is_prod_mutating: false
`,
    );

    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.playbook.steps[0].kind).toBe('report-in');
    expect(result.playbook.steps[0].command_or_prompt).toBeUndefined();
  });

  it('rejects a report-in step that also carries a command_or_prompt', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-deploy-playbook.yml'),
      `
steps:
  - id: report-in
    kind: report-in
    command_or_prompt: "curl -f http://localhost:3000/api/deploy/report-in"
    is_prod_mutating: false
`,
    );

    const result = loadDeployPlaybook(tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(
      /command_or_prompt must be absent for a report-in step/,
    );
  });
});
