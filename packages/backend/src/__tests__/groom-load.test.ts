import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdtempSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const LOADER = resolve(__dirname, '../../../../scripts/groom-load.mjs');

// Fixture board rows: Code + Tooling (need gate_contribution) + Gate (the target) + Design (exempt)
const GATE_TASK_ID = 'gateabc12345678901234567890abcd';
const CODE_TASK_ID = 'codeabc12345678901234567890abcd';
const TOOL_TASK_ID = 'toolabc12345678901234567890abcd';
const DSGN_TASK_ID = 'dsgnaabc12345678901234567890abc';

const FIXTURE_ROWS = [
  {
    id: CODE_TASK_ID,
    'Task Name': 'Implement feature A',
    Type: '💻 Code',
    Status: '🔲 Backlog',
    'Depends On': '',
    Priority: '',
    url: 'n/a',
  },
  {
    id: TOOL_TASK_ID,
    'Task Name': 'Set up CI pipeline',
    Type: '🛠️ Tooling',
    Status: '🔲 Backlog',
    'Depends On': '',
    Priority: '',
    url: 'n/a',
  },
  {
    id: GATE_TASK_ID,
    'Task Name': 'M-test Manual Verification Gate',
    Type: '🚦 Gate',
    Status: '🗂️ Ready',
    'Depends On': '',
    Priority: '',
    url: 'n/a',
  },
  {
    id: DSGN_TASK_ID,
    'Task Name': 'Design auth flow',
    Type: '📐 Design',
    Status: '🔲 Backlog',
    'Depends On': '',
    Priority: '',
    url: 'n/a',
  },
];

function setupEnv(tmpDir: string) {
  // Stub scripts dir: notion-query returns fixture board; notion-page returns empty markdown
  const stubDir = join(tmpDir, 'scripts');
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, 'notion-query.mjs'),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(FIXTURE_ROWS))} + '\\n');\n`,
  );
  writeFileSync(
    join(stubDir, 'notion-page.mjs'),
    `#!/usr/bin/env node\nprocess.stdout.write('# Task\\n\\nNo content.\\n');\n`,
  );

  // Minimal git repo on 'dev' branch
  const repoDir = join(tmpDir, 'repo');
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, 'README.md'), 'test');
  spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  spawnSync('git', ['config', 'user.name', 'Test'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  spawnSync('git', ['add', '.'], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'init'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  spawnSync('git', ['branch', '-m', 'dev'], { cwd: repoDir, encoding: 'utf8' });

  // Manifest
  const configDir = join(tmpDir, 'config');
  const projectDir = join(configDir, 'projects', 'repo');
  mkdirSync(projectDir, { recursive: true });
  const manifest = {
    integration_branch: 'dev',
    milestones: { 'M-test': { board: 'fake-board-id', neighbours: [] } },
    status_vocab: {
      backlog: '🔲 Backlog',
      ready: '🗂️ Ready',
      done: '✅ Done',
      deferred: '⏭️ Deferred',
    },
    context_pages: [],
    packages: [],
    area_aliases: {},
  };
  const manifestPath = join(projectDir, 'grooming.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));

  return { stubDir, repoDir, manifestPath };
}

function runLoader(repoDir: string, manifestPath: string, stubDir: string) {
  return spawnSync(
    process.execPath,
    [
      LOADER,
      '--milestone',
      'M-test',
      '--repo',
      repoDir,
      '--manifest',
      manifestPath,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GROOM_SCRIPTS_DIR_OVERRIDE: stubDir },
    },
  );
}

describe('groom-load.mjs — gate_contribution seeding', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records milestone_gate_task_id in context-bundle.json', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-load-'));
    const { stubDir, repoDir, manifestPath } = setupEnv(tmpDir);
    const r = runLoader(repoDir, manifestPath, stubDir);
    expect(r.status).toBe(0);

    const bundlePath = join(
      repoDir,
      '.skill-cache',
      'grooming',
      'M-test',
      'context-bundle.json',
    );
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    expect(bundle.milestone_gate_task_id).toBe(GATE_TASK_ID);
  });

  it('seeds gate_contribution: null and type for a Code task', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-load-'));
    const { stubDir, repoDir, manifestPath } = setupEnv(tmpDir);
    const r = runLoader(repoDir, manifestPath, stubDir);
    expect(r.status).toBe(0);

    const statePath = join(
      repoDir,
      '.skill-cache',
      'grooming',
      'M-test',
      'grooming-state.json',
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const codeEntry = state[CODE_TASK_ID];
    expect(codeEntry).toBeDefined();
    expect(codeEntry.type).toBe('💻 Code');
    expect(codeEntry.gate_contribution).toBeNull();
  });

  it('seeds gate_contribution: null and type for a Tooling task', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-load-'));
    const { stubDir, repoDir, manifestPath } = setupEnv(tmpDir);
    const r = runLoader(repoDir, manifestPath, stubDir);
    expect(r.status).toBe(0);

    const statePath = join(
      repoDir,
      '.skill-cache',
      'grooming',
      'M-test',
      'grooming-state.json',
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const toolEntry = state[TOOL_TASK_ID];
    expect(toolEntry).toBeDefined();
    expect(toolEntry.type).toBe('🛠️ Tooling');
    expect(toolEntry.gate_contribution).toBeNull();
  });

  it('seeds gate_contribution: {decision:"n/a"} for a Design task (exempt type)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-load-'));
    const { stubDir, repoDir, manifestPath } = setupEnv(tmpDir);
    const r = runLoader(repoDir, manifestPath, stubDir);
    expect(r.status).toBe(0);

    const statePath = join(
      repoDir,
      '.skill-cache',
      'grooming',
      'M-test',
      'grooming-state.json',
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const dsgnEntry = state[DSGN_TASK_ID];
    expect(dsgnEntry).toBeDefined();
    expect(dsgnEntry.type).toBe('📐 Design');
    expect(dsgnEntry.gate_contribution).toEqual({ decision: 'n/a' });
  });

  it('seeds gate_contribution back-compat for existing entries missing the field', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-load-'));
    const { stubDir, repoDir, manifestPath } = setupEnv(tmpDir);

    // Pre-seed a state file that lacks gate_contribution (simulates a pre-migration cache)
    const stateDir = join(repoDir, '.skill-cache', 'grooming', 'M-test');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'grooming-state.json'),
      JSON.stringify({
        [CODE_TASK_ID]: {
          title: 'Old title',
          status: '🔲 Backlog',
          signoff: null,
          hard_block_deps: null,
          size_check: null,
          // no gate_contribution, no type
        },
      }),
    );

    const r = runLoader(repoDir, manifestPath, stubDir);
    expect(r.status).toBe(0);

    const statePath = join(stateDir, 'grooming-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const codeEntry = state[CODE_TASK_ID];
    expect(codeEntry.type).toBe('💻 Code');
    expect(codeEntry.gate_contribution).toBeNull(); // seeded null for Code task
  });
});
