import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadOrchestratorConfig, getSessionAllowedTools } from '../orchestrator-config';

describe('loadOrchestratorConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns defaults when .claude-orchestrator.yml is absent', () => {
    const config = loadOrchestratorConfig(tmpDir);
    expect(config.autofix).toEqual([]);
    expect(config.verify).toEqual([]);
    expect(config.ci_check_name).toEqual([]);
    expect(config.allowed_tools).toEqual([]);
    expect(config.bash_rules).toEqual([]);
    expect(config.bootstrap_script).toBe('');
    expect(config.mcp_servers).toBeUndefined();
    expect(config.autofix_skip_ci).toBe(true);
  });

  it('returns parsed values for a well-formed config containing all six fields', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      [
        'autofix:',
        '  - npm run format:write',
        '  - npm run lint:fix',
        'verify:',
        '  - npx tsc --noEmit',
        '  - npm run build',
        'ci_check_name:',
        '  - build',
        'allowed_tools:',
        '  - Bash(dotnet:*)',
        'bash_rules:',
        '  - Use `npx` instead of bare tool names.',
        'bootstrap_script: ./scripts/bootstrap.sh',
      ].join('\n'),
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.autofix).toEqual([
      'npm run format:write',
      'npm run lint:fix',
    ]);
    expect(config.verify).toEqual(['npx tsc --noEmit', 'npm run build']);
    expect(config.ci_check_name).toEqual(['build']);
    expect(config.allowed_tools).toEqual(['Bash(dotnet:*)']);
    expect(config.bash_rules).toEqual([
      'Use `npx` instead of bare tool names.',
    ]);
    expect(config.bootstrap_script).toBe('./scripts/bootstrap.sh');
  });

  it('returns defaults and logs a warning when the YAML is malformed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      ': invalid: yaml: {',
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.autofix).toEqual([]);
    expect(config.verify).toEqual([]);
    expect(config.ci_check_name).toEqual([]);
    expect(config.allowed_tools).toEqual([]);
    expect(config.bash_rules).toEqual([]);
    expect(config.bootstrap_script).toBe('');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('[orchestrator-config]');
  });

  it('returns defaults for missing optional fields (partial config is valid)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      'allowed_tools:\n  - Bash(node:*)\n',
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.allowed_tools).toEqual(['Bash(node:*)']);
    expect(config.autofix).toEqual([]);
    expect(config.verify).toEqual([]);
    expect(config.ci_check_name).toEqual([]);
    expect(config.bash_rules).toEqual([]);
    expect(config.bootstrap_script).toBe('');
    expect(config.mcp_servers).toBeUndefined();
  });

  it('parses mcp_servers as a record when present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      [
        'mcp_servers:',
        '  github:',
        '    type: http',
        '    url: https://api.githubcopilot.com/mcp/',
      ].join('\n'),
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.mcp_servers).toEqual({
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    });
  });

  it('sets mcp_servers to undefined when it is not an object', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      'mcp_servers:\n  - github\n  - notion\n',
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.mcp_servers).toBeUndefined();
  });

  it('defaults autofix_skip_ci to true when not set in config', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      'autofix:\n  - npm run lint\n',
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.autofix_skip_ci).toBe(true);
  });

  it('parses autofix_skip_ci: false from config', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      'autofix_skip_ci: false\n',
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.autofix_skip_ci).toBe(false);
  });

  it('parses autofix_skip_ci: true from config', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      'autofix_skip_ci: true\n',
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.autofix_skip_ci).toBe(true);
  });
});

describe('getSessionAllowedTools', () => {
  it('merges base ALLOWED_TOOLS with per-project allowed_tools', () => {
    const merged = getSessionAllowedTools({
      allowed_tools: ['Bash(custom:*)'],
    });
    expect(merged).toContain('Bash(git:*)');
    expect(merged).toContain('Bash(custom:*)');
  });

  it('grants no Notion tool — read or write — to orchestrator-launched sessions', () => {
    const merged = getSessionAllowedTools({ allowed_tools: [] });
    expect(merged.some((t) => t.startsWith('mcp__claude_ai_Notion__'))).toBe(
      false,
    );
  });

  it('still excludes Notion tools when a project grants extra allowed_tools', () => {
    const merged = getSessionAllowedTools({
      allowed_tools: ['Bash(custom:*)'],
    });
    expect(merged.some((t) => t.startsWith('mcp__claude_ai_Notion__'))).toBe(
      false,
    );
  });
});
