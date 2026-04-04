import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildOrchestratorClaudeMd } from './orchestrator-claudemd';
import { buildSessionContext, stripOrchestratorHeader } from './ContextBuilder';
import { loadOrchestratorConfig } from './orchestrator-config';

const defaultParams = {
  taskName: 'My test task',
  taskUrl: 'https://www.notion.so/abc123',
  projectContextUrl: 'https://www.notion.so/ctx456',
  targetBranch: 'dev',
  worktreePath: '/fake/worktree/path',
};

describe('buildOrchestratorClaudeMd', () => {
  it('returns a string containing all 11 required sections', () => {
    const result = buildOrchestratorClaudeMd(defaultParams);

    // Section 1: Header with override warning
    expect(result).toContain('# Orchestrator Rules (DO NOT OVERRIDE)');
    expect(result).toContain('take priority over any');

    // Section 2: Task assignment
    expect(result).toContain('## Task Assignment');
    expect(result).toContain(defaultParams.taskName);
    expect(result).toContain(defaultParams.taskUrl);
    expect(result).toContain(defaultParams.projectContextUrl);

    // Section 3: Lifecycle steps
    expect(result).toContain('## Lifecycle');
    expect(result).toContain('feature/<task-name>');

    // Section 4: Status ownership
    expect(result).toContain('## Status Ownership');
    expect(result).toContain('Do NOT update Notion task status');
    expect(result).toContain('Do NOT call any Notion API');

    // Section 5: PR format standards
    expect(result).toContain('## PR Format Standards');
    expect(result).toContain('feat: <task-name>');
    expect(result).toContain('## Summary');
    expect(result).toContain('## Notion Task');
    expect(result).toContain('## Automated Tests');
    expect(result).toContain('## Files Changed');

    // Section 6: Branch rules
    expect(result).toContain('## Branch Rules');
    expect(result).toContain(`Never commit directly to \`${defaultParams.targetBranch}\``);

    // Section 7: Pre-PR gate
    expect(result).toContain('## Pre-PR Gate');
    expect(result).toContain('npx tsc --noEmit');
    expect(result).toContain('npx vite build');

    // Section 8: Forbidden actions
    expect(result).toContain('## Forbidden Actions');
    expect(result).toContain('Never push directly to');
    expect(result).toContain('Never force push');

    // Section 9: Git isolation
    expect(result).toContain('## Git Isolation');
    expect(result).toContain('inside the worktree directory');
    expect(result).toContain('git -C <path>');

    // Section 10: Bash rules
    expect(result).toContain('## Bash Rules (Permission System)');
    expect(result).toContain('One command per Bash call');
    expect(result).toContain('mcp__github__create_pull_request');
  });

  it('uses custom prGate commands when provided', () => {
    const result = buildOrchestratorClaudeMd({
      ...defaultParams,
      prGate: { typeCheck: 'dotnet build', build: 'dotnet test' },
    });
    expect(result).toContain('`dotnet build`');
    expect(result).toContain('`dotnet test`');
    // Pre-PR Gate section should not contain the Node.js defaults
    const prGateSection = result.slice(
      result.indexOf('## Pre-PR Gate'),
      result.indexOf('## Forbidden Actions'),
    );
    expect(prGateSection).not.toContain('npx tsc');
    expect(prGateSection).not.toContain('npx vite');
  });

  it('uses custom bashRules when provided', () => {
    const result = buildOrchestratorClaudeMd({
      ...defaultParams,
      bashRules: ['Use `dotnet` for builds and tests. Do not use `npm` or `npx`.'],
    });
    expect(result).toContain('**Rule 5 — Use `dotnet` for builds and tests');
    // Bash Rules section should not contain the npx rule
    const bashSection = result.slice(result.indexOf('## Bash Rules (Permission System)'));
    expect(bashSection).not.toContain('npx tsc');
  });

  it('renders multi-line bashRules with heading and body', () => {
    const result = buildOrchestratorClaudeMd({
      ...defaultParams,
      bashRules: ['First line heading.\nSecond line body.'],
    });
    expect(result).toContain('**Rule 5 — First line heading.**');
    expect(result).toContain('Second line body.');
  });

  it('renders multiple bashRules as Rule 5, Rule 6, etc.', () => {
    const result = buildOrchestratorClaudeMd({
      ...defaultParams,
      bashRules: ['Rule A.', 'Rule B.'],
    });
    expect(result).toContain('**Rule 5 — Rule A.**');
    expect(result).toContain('**Rule 6 — Rule B.**');
  });

  it('falls back to npx default when prGate and bashRules are omitted', () => {
    const result = buildOrchestratorClaudeMd(defaultParams);
    expect(result).toContain('npx tsc --noEmit');
    expect(result).toContain('npx vite build');
    expect(result).toContain('**Rule 5 — Use `npx` instead of bare tool names.**');
  });

  it('includes worktree path in Git Isolation section', () => {
    const result = buildOrchestratorClaudeMd({
      ...defaultParams,
      worktreePath: '/my/worktree/dir',
    });
    expect(result).toContain('Your worktree directory is `/my/worktree/dir`');
    expect(result).toContain('Never navigate to or operate on any parent directory');
  });

  it('interpolates taskName, taskUrl, projectContextUrl, and targetBranch', () => {
    const params = {
      taskName: 'Fix the thing',
      taskUrl: 'https://www.notion.so/task-999',
      projectContextUrl: 'https://www.notion.so/ctx-888',
      targetBranch: 'main',
      worktreePath: '/fake/path',
    };
    const result = buildOrchestratorClaudeMd(params);

    expect(result).toContain('Fix the thing');
    expect(result).toContain('https://www.notion.so/task-999');
    expect(result).toContain('https://www.notion.so/ctx-888');
    expect(result).toContain('`main`');
    // targetBranch used in lifecycle and branch rules
    expect(result).toContain(`from \`main\``);
  });
});

describe('orchestrator CLAUDE.md merge logic (section 10)', () => {
  let tmpDir: string;
  let worktreePath: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
    projectDir = path.join(tmpDir, 'project');
    worktreePath = path.join(tmpDir, 'worktree');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Simulate the merge logic from SessionManager.start() so we can test it
   * in isolation without spawning a real session.
   */
  function writeMergedClaudeMd(taskName: string, taskUrl: string): void {
    const content = buildSessionContext({
      taskName,
      taskUrl,
      projectContextUrl: 'https://www.notion.so/ctx',
      targetBranch: 'dev',
      projectDir,
      worktreePath,
    });
    fs.writeFileSync(path.join(worktreePath, 'CLAUDE.md'), content, 'utf-8');
  }

  it('writes merged CLAUDE.md to the worktree path, not the project directory', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Original', 'utf-8');

    writeMergedClaudeMd('Task A', 'https://www.notion.so/task-a');

    expect(fs.existsSync(path.join(worktreePath, 'CLAUDE.md'))).toBe(true);
    // Project dir has its own CLAUDE.md — confirm it was not replaced
    const projectContent = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(projectContent).toBe('# Original');
  });

  it('when project has no CLAUDE.md, only orchestrator content is written (no error)', () => {
    // No project CLAUDE.md
    expect(fs.existsSync(path.join(projectDir, 'CLAUDE.md'))).toBe(false);

    expect(() => writeMergedClaudeMd('Task B', 'https://www.notion.so/task-b')).not.toThrow();

    const written = fs.readFileSync(path.join(worktreePath, 'CLAUDE.md'), 'utf-8');
    expect(written).toContain('# Orchestrator Rules (DO NOT OVERRIDE)');
    // No project instructions separator when there is no project CLAUDE.md
    expect(written).not.toContain('# Project Instructions');
  });

  it('when project has a CLAUDE.md, it appears after the orchestrator section with a separator', () => {
    const projectContent = '# Project Rules\n\nDo stuff the project way.';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), projectContent, 'utf-8');

    writeMergedClaudeMd('Task C', 'https://www.notion.so/task-c');

    const written = fs.readFileSync(path.join(worktreePath, 'CLAUDE.md'), 'utf-8');

    // Orchestrator section comes first
    const orchestratorIdx = written.indexOf('# Orchestrator Rules');
    const separatorIdx = written.indexOf('---\n\n# Project Instructions');
    const projectIdx = written.indexOf('# Project Rules');

    expect(orchestratorIdx).toBeGreaterThanOrEqual(0);
    expect(separatorIdx).toBeGreaterThan(orchestratorIdx);
    expect(projectIdx).toBeGreaterThan(separatorIdx);

    // Project content is present verbatim
    expect(written).toContain(projectContent);
  });

  it('original project CLAUDE.md is unchanged after merge', () => {
    const original = '# My Project\n\nOriginal content here.';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), original, 'utf-8');

    writeMergedClaudeMd('Task D', 'https://www.notion.so/task-d');

    const afterMerge = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(afterMerge).toBe(original);
  });
});

describe('stripOrchestratorHeader', () => {
  it('returns the input unchanged when it does not start with orchestrator rules', () => {
    const md = '# My Project\n\nSome instructions.';
    expect(stripOrchestratorHeader(md)).toBe(md);
  });

  it('strips orchestrator header and returns content after "# Project Instructions"', () => {
    const md = [
      '# Orchestrator Rules (DO NOT OVERRIDE)',
      '',
      '## Task Assignment',
      '- Task: old task',
      '',
      '---',
      '',
      '# Project Instructions',
      '',
      '# My Project',
      '',
      'Real instructions here.',
    ].join('\n');
    const result = stripOrchestratorHeader(md);
    expect(result).toBe('# My Project\n\nReal instructions here.');
    expect(result).not.toContain('Orchestrator Rules');
    expect(result).not.toContain('old task');
  });

  it('returns empty string when entire file is orchestrator content with no project instructions', () => {
    const md = [
      '# Orchestrator Rules (DO NOT OVERRIDE)',
      '',
      '## Task Assignment',
      '- Task: some task',
    ].join('\n');
    expect(stripOrchestratorHeader(md)).toBe('');
  });

  it('handles double-nested orchestrator pollution (orchestrator → project instructions → orchestrator → project instructions)', () => {
    // This is the actual bug scenario: project CLAUDE.md was polluted, then
    // embedded as "Project Instructions", creating nested orchestrator headers.
    const md = [
      '# Orchestrator Rules (DO NOT OVERRIDE)',
      'Stale task rules',
      '',
      '# Project Instructions',
      '',
      '# Orchestrator Rules (DO NOT OVERRIDE)',
      'Even staler rules',
      '',
      '# Project Instructions',
      '',
      '# Real Project Content',
      'The actual instructions.',
    ].join('\n');
    const result = stripOrchestratorHeader(md);
    // First strip removes the outer orchestrator header, exposing the inner one.
    // The inner one still starts with "# Orchestrator Rules" so a second call
    // would strip it too. But one level of stripping is sufficient for our use
    // case since buildSessionContext calls it once before embedding.
    expect(result).toContain('# Orchestrator Rules');
    // The important thing is that the outer stale orchestrator header is gone.
    expect(result).not.toContain('Stale task rules');
  });
});

describe('buildSessionContext strips polluted project CLAUDE.md', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-strip-test-'));
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('strips stale orchestrator header from project CLAUDE.md before embedding', () => {
    // Simulate a polluted project CLAUDE.md (written by a previous escaped session)
    const polluted = [
      '# Orchestrator Rules (DO NOT OVERRIDE)',
      '',
      '## Task Assignment',
      '- Task: Old stale task',
      '',
      '---',
      '',
      '# Project Instructions',
      '',
      '# Real Project',
      'Actual project instructions.',
    ].join('\n');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), polluted, 'utf-8');

    const result = buildSessionContext({
      taskName: 'Current task',
      taskUrl: 'https://www.notion.so/current',
      projectContextUrl: 'https://www.notion.so/ctx',
      targetBranch: 'dev',
      projectDir,
      worktreePath: '/fake/worktree',
    });

    // Should have exactly ONE set of orchestrator rules (the current task's)
    const orchestratorCount = (result.match(/# Orchestrator Rules \(DO NOT OVERRIDE\)/g) || []).length;
    expect(orchestratorCount).toBe(1);

    // Should NOT contain the stale task reference
    expect(result).not.toContain('Old stale task');

    // Should contain the current task and the real project instructions
    expect(result).toContain('Current task');
    expect(result).toContain('Actual project instructions.');
  });

  it('leaves clean project CLAUDE.md unchanged', () => {
    const clean = '# My Game\n\nProject instructions here.';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), clean, 'utf-8');

    const result = buildSessionContext({
      taskName: 'Task X',
      taskUrl: 'https://www.notion.so/x',
      projectContextUrl: 'https://www.notion.so/ctx',
      targetBranch: 'dev',
      projectDir,
      worktreePath: '/fake/worktree',
    });

    expect(result).toContain('# Project Instructions');
    expect(result).toContain('# My Game');
    expect(result).toContain('Project instructions here.');
  });
});

describe('loadOrchestratorConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns Node.js defaults when no config file exists', () => {
    const config = loadOrchestratorConfig(tmpDir);
    expect(config.allowedTools).toEqual([]);
    expect(config.prGate.typeCheck).toBe('npx tsc --noEmit');
    expect(config.prGate.build).toBe('npx vite build');
    expect(config.bootstrapScript).toBe('');
    expect(config.bashRules.length).toBeGreaterThan(0);
    expect(config.bashRules[0]).toContain('npx');
  });

  it('reads custom config from .claude/orchestrator.json', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'orchestrator.json'), JSON.stringify({
      allowedTools: ['Bash(dotnet:*)'],
      prGate: { typeCheck: 'dotnet build', build: 'dotnet test' },
      bootstrapScript: './bootstrap.sh',
      bashRules: ['Use `dotnet` instead of `npm`.'],
    }), 'utf-8');

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.allowedTools).toEqual(['Bash(dotnet:*)']);
    expect(config.prGate.typeCheck).toBe('dotnet build');
    expect(config.prGate.build).toBe('dotnet test');
    expect(config.bootstrapScript).toBe('./bootstrap.sh');
    expect(config.bashRules).toEqual(['Use `dotnet` instead of `npm`.']);
  });

  it('falls back to defaults for missing fields in partial config', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'orchestrator.json'), JSON.stringify({
      allowedTools: ['Bash(dotnet:*)'],
    }), 'utf-8');

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.allowedTools).toEqual(['Bash(dotnet:*)']);
    expect(config.prGate.typeCheck).toBe('npx tsc --noEmit');
    expect(config.prGate.build).toBe('npx vite build');
    expect(config.bootstrapScript).toBe('');
  });

  it('returns defaults when config file is invalid JSON', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'orchestrator.json'), 'not json', 'utf-8');

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.prGate.typeCheck).toBe('npx tsc --noEmit');
  });
});
