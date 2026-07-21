import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadOrchestratorConfig,
  getSessionAllowedTools,
  isGrantable,
} from '../orchestrator-config';

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
  it('merges base ALLOWED_TOOLS with per-project allowed_tools for standard sessions', () => {
    const merged = getSessionAllowedTools('standard', {
      allowed_tools: ['Bash(custom:*)'],
    });
    expect(merged).toContain('Bash(git:*)');
    expect(merged).toContain('Bash(custom:*)');
  });

  it('grants no Notion tool — read or write — to standard orchestrator-launched sessions', () => {
    const merged = getSessionAllowedTools('standard', { allowed_tools: [] });
    expect(merged.some((t) => t.startsWith('mcp__claude_ai_Notion__'))).toBe(
      false,
    );
  });

  it('still excludes Notion tools when a project grants extra allowed_tools', () => {
    const merged = getSessionAllowedTools('standard', {
      allowed_tools: ['Bash(custom:*)'],
    });
    expect(merged.some((t) => t.startsWith('mcp__claude_ai_Notion__'))).toBe(
      false,
    );
  });

  const FORBIDDEN_FOR_PLANNING = [
    'Write',
    'Edit',
    'Bash(git:*)',
    'mcp__github__create_pull_request',
    'mcp__github__merge_pull_request',
    'mcp__github__push_files',
    'mcp__github__create_or_update_file',
    'mcp__claude_ai_Notion__notion-create-pages',
    'mcp__claude_ai_Notion__notion-update-page',
  ];

  it.each(['groom', 'design'] as const)(
    '%s tool set excludes Write/Edit, git-mutation, PR/github MCP, and Notion-write MCP',
    (sessionType) => {
      const tools = getSessionAllowedTools(sessionType, {
        allowed_tools: ['Bash(rm:*)'],
      });
      for (const forbidden of FORBIDDEN_FOR_PLANNING) {
        expect(tools).not.toContain(forbidden);
      }
      expect(tools.some((t) => t.startsWith('mcp__github__'))).toBe(false);
      expect(
        tools.some((t) => t.startsWith('mcp__claude_ai_Notion__notion-create')),
      ).toBe(false);
      expect(
        tools.some((t) => t.startsWith('mcp__claude_ai_Notion__notion-update')),
      ).toBe(false);
      // per-project extras (which may include mutating commands) are never merged in
      expect(tools).not.toContain('Bash(rm:*)');
    },
  );

  it('groom and design each return a dedicated per-type set, not the base ALLOWED_TOOLS', () => {
    const groom = getSessionAllowedTools('groom', { allowed_tools: [] });
    const design = getSessionAllowedTools('design', { allowed_tools: [] });
    expect(groom).not.toEqual(design);
    expect(design.some((t) => t.startsWith('Bash(git '))).toBe(true);
  });

  it('ops tool set excludes Write/Edit, git-mutation, PR/github MCP, and Notion-write MCP', () => {
    const tools = getSessionAllowedTools('ops', { allowed_tools: [] });
    for (const forbidden of FORBIDDEN_FOR_PLANNING) {
      expect(tools).not.toContain(forbidden);
    }
    expect(tools.some((t) => t.startsWith('mcp__github__'))).toBe(false);
  });

  it('ops merges the per-project allowed_tools extras (its audited live-data read surface), unlike groom/design', () => {
    const tools = getSessionAllowedTools('ops', {
      allowed_tools: ['mcp__analyst__query_alarm_rules'],
    });
    expect(tools).toContain('mcp__analyst__query_alarm_rules');
  });

  it('ops base profile is read + stage + safe live-data surface, distinct from groom/design/standard', () => {
    const ops = getSessionAllowedTools('ops', { allowed_tools: [] });
    const groom = getSessionAllowedTools('groom', { allowed_tools: [] });
    const standard = getSessionAllowedTools('standard', { allowed_tools: [] });
    expect(ops).not.toEqual(standard);
    expect(ops.some((t) => t.startsWith('Bash(git '))).toBe(true);
    expect(ops).toEqual(expect.arrayContaining(groom));
  });

  describe('granted-capability composition', () => {
    it('an empty granted set equals the base profile', () => {
      const withEmpty = getSessionAllowedTools(
        'standard',
        { allowed_tools: [] },
        [],
      );
      const withoutArg = getSessionAllowedTools('standard', {
        allowed_tools: [],
      });
      expect(withEmpty).toEqual(withoutArg);
    });

    it('composes base ∪ granted for a standard session', () => {
      const merged = getSessionAllowedTools('standard', { allowed_tools: [] }, [
        'Bash(psql:*)',
      ]);
      expect(merged).toContain('Bash(git:*)');
      expect(merged).toContain('Bash(psql:*)');
    });

    it('composes base ∪ granted for a planning session, still excluding project extras', () => {
      const merged = getSessionAllowedTools(
        'groom',
        { allowed_tools: ['Bash(rm:*)'] },
        ['Bash(psql:*)'],
      );
      expect(merged).toContain('Bash(psql:*)');
      expect(merged).not.toContain('Bash(rm:*)');
    });

    it('dedupes a grant that overlaps the base profile', () => {
      const merged = getSessionAllowedTools('standard', { allowed_tools: [] }, [
        'Bash(git:*)',
      ]);
      expect(merged.filter((t) => t === 'Bash(git:*)')).toHaveLength(1);
    });

    it.each([
      'Bash(node ~/.claude/scripts/stage-task-intent.mjs apply:*)',
      'Bash(node ~/.claude/scripts/resolve-task.mjs:*)',
      'mark-task-done',
    ])('never merges a resolved/apply/done-scoped grant (%s)', (capability) => {
      const merged = getSessionAllowedTools('standard', { allowed_tools: [] }, [
        capability,
      ]);
      expect(merged).not.toContain(capability);
    });

    it.each(['Write', 'Edit'])(
      'never merges a %s grant, even for a standard session',
      (capability) => {
        const merged = getSessionAllowedTools(
          'standard',
          { allowed_tools: [] },
          [capability],
        );
        expect(merged).not.toContain(capability);
      },
    );
  });
});

describe('isGrantable', () => {
  it.each(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])(
    'returns false for %s (un-grantable)',
    (capability) => {
      expect(isGrantable(capability)).toBe(false);
    },
  );

  it('returns true for a normal Bash grant', () => {
    expect(isGrantable('Bash(psql:*)')).toBe(true);
  });
});
