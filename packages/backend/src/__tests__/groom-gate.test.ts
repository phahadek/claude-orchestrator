import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// Path to the hook script (worktree root → scripts/)
const HOOK = resolve(__dirname, '../../../../scripts/groom-gate.mjs');

const PAGE_ID = '38b22f9152f38146a48bf10cf51cacdb';
const TOOL_NAME = 'mcp__claude_ai_Notion__notion-update-page';

// A fully-valid state entry satisfying the three pre-existing gates
const VALID_BASE = {
  signoff: { by: 'test-user', at: '2026-06-26T00:00:00.000Z' },
  hard_block_deps: [],
  size_check: { decision: 'n/a' },
};

function makeStateFile(cwd: string, entries: Record<string, unknown>) {
  const stateDir = join(cwd, '.skill-cache', 'grooming', 'M-test');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'grooming-state.json'), JSON.stringify(entries));
}

function runGate(cwd: string, pageId: string) {
  const stdin = JSON.stringify({
    tool_name: TOOL_NAME,
    tool_input: {
      command: 'update_properties',
      page_id: pageId,
      properties: { Status: '🗂️ Ready' },
    },
    cwd,
  });
  return spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
  });
}

describe('groom-gate.mjs — repo_assignment check', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks a multi-repo task with repo: null', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, {
      [PAGE_ID]: {
        ...VALID_BASE,
        repo_assignment: { multi_repo: true, repo: null },
      },
    });
    const r = runGate(tmpDir, PAGE_ID);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('multi-repo project');
  });

  it('blocks a multi-repo task with repo: ""', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, {
      [PAGE_ID]: {
        ...VALID_BASE,
        repo_assignment: { multi_repo: true, repo: '' },
      },
    });
    const r = runGate(tmpDir, PAGE_ID);
    expect(r.status).toBe(2);
  });

  it('blocks a multi-repo task with repo: "  " (whitespace only)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, {
      [PAGE_ID]: {
        ...VALID_BASE,
        repo_assignment: { multi_repo: true, repo: '  ' },
      },
    });
    const r = runGate(tmpDir, PAGE_ID);
    expect(r.status).toBe(2);
  });

  it('allows a multi-repo task when repo is assigned', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, {
      [PAGE_ID]: {
        ...VALID_BASE,
        repo_assignment: { multi_repo: true, repo: 'claude-orchestrator' },
      },
    });
    const r = runGate(tmpDir, PAGE_ID);
    expect(r.status).toBe(0);
  });

  it('allows a single-repo task (multi_repo: false, no repo required)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, {
      [PAGE_ID]: {
        ...VALID_BASE,
        repo_assignment: { multi_repo: false, repo: null },
      },
    });
    const r = runGate(tmpDir, PAGE_ID);
    expect(r.status).toBe(0);
  });

  it('allows when repo_assignment is absent (fail-open)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, { [PAGE_ID]: { ...VALID_BASE } });
    const r = runGate(tmpDir, PAGE_ID);
    expect(r.status).toBe(0);
  });
});

describe('groom-gate.mjs — regression: pre-existing gate checks', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks when signoff is missing', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, {
      [PAGE_ID]: { hard_block_deps: [], size_check: { decision: 'n/a' } },
    });
    const r = runGate(tmpDir, PAGE_ID);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('sign-off');
  });

  it('blocks when hard_block_deps is null', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, {
      [PAGE_ID]: {
        signoff: { by: 'u', at: '2026-06-26T00:00:00Z' },
        hard_block_deps: null,
        size_check: { decision: 'n/a' },
      },
    });
    const r = runGate(tmpDir, PAGE_ID);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('hard_block_deps');
  });

  it('blocks when size_check is missing', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, {
      [PAGE_ID]: {
        signoff: { by: 'u', at: '2026-06-26T00:00:00Z' },
        hard_block_deps: [],
      },
    });
    const r = runGate(tmpDir, PAGE_ID);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('size_check');
  });

  it('allows when all three original fields are valid and repo_assignment absent', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, { [PAGE_ID]: { ...VALID_BASE } });
    const r = runGate(tmpDir, PAGE_ID);
    expect(r.status).toBe(0);
  });

  it('exits 0 for non-Ready status updates (out of scope)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    // state entry is incomplete — would block if gate were reached
    makeStateFile(tmpDir, { [PAGE_ID]: {} });
    const stdin = JSON.stringify({
      tool_name: TOOL_NAME,
      tool_input: {
        command: 'update_properties',
        page_id: PAGE_ID,
        properties: { Status: '🔲 Backlog' },
      },
      cwd: tmpDir,
    });
    const r = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });

  it('exits 0 for non-property-update commands (out of scope)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'groom-gate-'));
    makeStateFile(tmpDir, { [PAGE_ID]: {} });
    const stdin = JSON.stringify({
      tool_name: TOOL_NAME,
      tool_input: { command: 'append_blocks', page_id: PAGE_ID },
      cwd: tmpDir,
    });
    const r = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });
});
