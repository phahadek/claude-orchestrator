import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadOrchestratorConfig,
  getSessionAllowedTools,
  getSessionAddDirs,
  getTestCommandDenyPatterns,
  isGrantable,
  sessionRecordReadCapability,
  parseSessionRecordReadCapability,
  auditLogReadCapability,
  parseAuditLogReadCapability,
  sessionEventsReadCapability,
  parseSessionEventsReadCapability,
  pathReadCapability,
  parsePathReadCapability,
  isSanctionedAutoApproveCapability,
  bashCapabilityConfersFileMutation,
  isDeclaredWriteAutoApprove,
  resolvePreGrantSessionKind,
  resolvePreGrantCapabilities,
} from '../orchestrator-config';
import { NOTION_READ_MCP_TOOLS } from '../../config';
import {
  NOTION_MCP_SERVER_NAME,
  orchestratorMcpToolName,
} from '../../mcp/toolNaming';
import { PLANNING_INTENT_KINDS } from '../../planning/planningIntentKinds';

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
    expect(config.autofix_skip_ci).toBe(false);
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

  it('defaults autofix_skip_ci to false when not set in config', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      'autofix:\n  - npm run lint\n',
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.autofix_skip_ci).toBe(false);
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

  it('parses test_report_format and test_report_glob when set in config', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      [
        'test_report_format: junit-xml',
        'test_report_glob: "**/test-results/*.xml"',
      ].join('\n'),
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.test_report_format).toBe('junit-xml');
    expect(config.test_report_glob).toBe('**/test-results/*.xml');
  });

  it('falls back to defaults for absent or malformed test_report_format/test_report_glob', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      ['test_report_format: cobertura', 'test_report_glob: 42'].join('\n'),
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.test_report_format).toBeUndefined();
    expect(config.test_report_glob).toBe('');
  });

  it('defaults test_report_format and test_report_glob when the config file is absent', () => {
    const config = loadOrchestratorConfig(tmpDir);
    expect(config.test_report_format).toBeUndefined();
    expect(config.test_report_glob).toBe('');
  });

  it('defaults capability_pre_grants to {} when .claude-orchestrator.yml is absent', () => {
    const config = loadOrchestratorConfig(tmpDir);
    expect(config.capability_pre_grants).toEqual({});
  });

  it('parses capability_pre_grants for a well-formed config with all six session kinds', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      [
        'capability_pre_grants:',
        '  gate-verify:',
        '    - "read:audit-log:proj-1"',
        '  investigate:',
        '    - "read:session-events:proj-1"',
        '  ops:',
        '    - "read:audit-log:proj-1"',
        '  groom:',
        '    - "read:path:/etc/foo"',
        '  design:',
        '    - "read:session-events:proj-1"',
        '  docs:',
        '    - "read:path:/etc/bar"',
      ].join('\n'),
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.capability_pre_grants).toEqual({
      'gate-verify': ['read:audit-log:proj-1'],
      investigate: ['read:session-events:proj-1'],
      ops: ['read:audit-log:proj-1'],
      groom: ['read:path:/etc/foo'],
      design: ['read:session-events:proj-1'],
      docs: ['read:path:/etc/bar'],
    });
  });

  it('drops unknown session-kind keys and non-string entries from capability_pre_grants', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      [
        'capability_pre_grants:',
        '  ops:',
        '    - "read:audit-log:proj-1"',
        '    - 42',
        '  not-a-real-kind:',
        '    - "read:audit-log:proj-1"',
      ].join('\n'),
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.capability_pre_grants).toEqual({
      ops: ['read:audit-log:proj-1'],
    });
  });

  it('falls back to {} when capability_pre_grants is not an object', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      'capability_pre_grants:\n  - ops\n  - groom\n',
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.capability_pre_grants).toEqual({});
  });

  it('falls back to {} for capability_pre_grants when the YAML is malformed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      ': invalid: yaml: {',
      'utf-8',
    );

    const config = loadOrchestratorConfig(tmpDir);
    expect(config.capability_pre_grants).toEqual({});
    expect(warnSpy).toHaveBeenCalledOnce();
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

  it('an investigate-dispatched (ops sessionType, report-batch task id) session gets INVESTIGATE_ALLOWED_TOOLS, not OPS_ALLOWED_TOOLS', () => {
    const plainOps = getSessionAllowedTools(
      'ops',
      { allowed_tools: [] },
      [],
      undefined,
      [],
      'notion:some-task-id',
    );
    const investigate = getSessionAllowedTools(
      'ops',
      { allowed_tools: [] },
      [],
      undefined,
      [],
      'report-batch:batch-1',
    );
    expect(investigate).not.toEqual(plainOps);
    expect(investigate).not.toContain(
      orchestratorMcpToolName('journal.setState'),
    );
    expect(investigate).not.toContain(orchestratorMcpToolName('gate.verify'));
    expect(investigate).toContain(orchestratorMcpToolName('decision.pickOne'));
    expect(plainOps).toContain(orchestratorMcpToolName('gate.verify'));
  });

  it('ops base profile is read + stage + safe live-data surface, distinct from groom/design/standard', () => {
    const ops = getSessionAllowedTools('ops', { allowed_tools: [] });
    const groom = getSessionAllowedTools('groom', { allowed_tools: [] });
    const standard = getSessionAllowedTools('standard', { allowed_tools: [] });
    expect(ops).not.toEqual(standard);
    expect(ops).not.toEqual(groom);
    expect(ops.some((t) => t.startsWith('Bash(git '))).toBe(true);
    // Shared read-only Bash + Notion-read base carries over even though each
    // type's orchestrator MCP stage-proposal tools are scoped to its own
    // staged-intent kinds (see config.ts's PLANNING_INTENT_KINDS-mirrored
    // GROOM_MCP_TOOLS/OPS_MCP_TOOLS) rather than being one shared set.
    const opsSet = new Set(ops);
    for (const tool of groom) {
      if (tool.startsWith('mcp__orchestrator__')) continue;
      expect(opsSet.has(tool)).toBe(true);
    }
  });

  it('ops and groom each get only the orchestrator MCP stage-proposal tools for their own staged-intent kinds', () => {
    const ops = getSessionAllowedTools('ops', { allowed_tools: [] });
    const groom = getSessionAllowedTools('groom', { allowed_tools: [] });
    expect(ops).toContain('mcp__orchestrator__journal_setState');
    expect(ops).toContain('mcp__orchestrator__session_requestCapability');
    expect(ops).toContain('mcp__orchestrator__gate_verify');
    expect(ops).not.toContain('mcp__orchestrator__gate_accrete');
    expect(ops).not.toContain('mcp__orchestrator__task_setDependsOn');
    expect(groom).toContain('mcp__orchestrator__gate_accrete');
    expect(groom).toContain('mcp__orchestrator__task_setDependsOn');
    expect(groom).not.toContain('mcp__orchestrator__journal_setState');
    expect(groom).not.toContain('mcp__orchestrator__gate_verify');
  });

  it('ops (gate-verify) session resolved allow-list includes gateSeed_getState without an operator grant, but never a mutating gate/seed tool', () => {
    const ops = getSessionAllowedTools('ops', { allowed_tools: [] });
    const groom = getSessionAllowedTools('groom', { allowed_tools: [] });
    const design = getSessionAllowedTools('design', { allowed_tools: [] });
    const standard = getSessionAllowedTools('standard', { allowed_tools: [] });
    expect(ops).toContain('mcp__orchestrator__gateSeed_getState');
    expect(groom).not.toContain('mcp__orchestrator__gateSeed_getState');
    expect(design).not.toContain('mcp__orchestrator__gateSeed_getState');
    expect(standard).not.toContain('mcp__orchestrator__gateSeed_getState');
    expect(ops).not.toContain('mcp__orchestrator__gate_accrete');
    expect(ops).not.toContain('mcp__orchestrator__seed_stage');
  });

  describe('docs tool set', () => {
    it('returns DOCS_ALLOWED_TOOLS including Write/Edit, git-write, and the PR-open exception', () => {
      const tools = getSessionAllowedTools('docs', { allowed_tools: [] });
      expect(tools).toContain('Write');
      expect(tools).toContain('Edit');
      expect(tools).toContain('Bash(git:*)');
      expect(tools).toContain('Bash(gh pr create:*)');
      expect(tools).toContain('mcp__github__create_pull_request');
      expect(tools).toContain('mcp__orchestrator__notion_pageEdit');
    });

    it('derives its staged-intent MCP tools from PLANNING_INTENT_KINDS.docs, not a hand-written list', () => {
      const tools = getSessionAllowedTools('docs', { allowed_tools: [] });
      for (const kind of PLANNING_INTENT_KINDS.docs) {
        expect(tools).toContain(orchestratorMcpToolName(kind));
      }
    });

    it('includes the session.requestCapability tool — the in-band escalation path for a docs session, derived automatically from PLANNING_INTENT_KINDS.docs', () => {
      const tools = getSessionAllowedTools('docs', { allowed_tools: [] });
      expect(tools).toContain('mcp__orchestrator__session_requestCapability');
    });

    it('merges an allowlisted WebFetch entry per declared source domain and never grants open WebSearch', () => {
      const tools = getSessionAllowedTools(
        'docs',
        { allowed_tools: [] },
        [],
        undefined,
        ['docs.example.com', 'developer.example.org'],
      );
      expect(tools).toContain('WebFetch(domain:docs.example.com)');
      expect(tools).toContain('WebFetch(domain:developer.example.org)');
      expect(tools).not.toContain('WebSearch');
      expect(tools.some((t) => t === 'WebFetch')).toBe(false);
    });

    it('grants no WebFetch at all when no source domains are declared', () => {
      const tools = getSessionAllowedTools('docs', { allowed_tools: [] });
      expect(tools.some((t) => t.startsWith('WebFetch'))).toBe(false);
      expect(tools).not.toContain('WebSearch');
    });

    it('never merges per-project allowed_tools extras into the docs base (unlike ops)', () => {
      const tools = getSessionAllowedTools('docs', {
        allowed_tools: ['mcp__analyst__query_alarm_rules'],
      });
      expect(tools).not.toContain('mcp__analyst__query_alarm_rules');
    });
  });

  describe('task-source-gated Notion read tools', () => {
    it.each(['groom', 'design', 'ops'] as const)(
      "merges NOTION_READ_MCP_TOOLS into a %s session's allow-list for a Notion-task-source project",
      (sessionType) => {
        const tools = getSessionAllowedTools(
          sessionType,
          { allowed_tools: [] },
          [],
          'notion',
        );
        for (const notionTool of NOTION_READ_MCP_TOOLS) {
          expect(tools).toContain(notionTool);
        }
      },
    );

    it.each(['jira', 'yaml', 'github', undefined] as const)(
      'grants no Notion tool to a %s-task-source planning session',
      (taskSource) => {
        for (const sessionType of ['groom', 'design', 'ops'] as const) {
          const tools = getSessionAllowedTools(
            sessionType,
            { allowed_tools: [] },
            [],
            taskSource,
          );
          expect(tools.some((t) => t.startsWith('mcp__notion__'))).toBe(false);
        }
      },
    );

    it('every Notion entry composed into a Notion-sourced allow-list carries the prefix derived from the registered server key', () => {
      const tools = getSessionAllowedTools(
        'groom',
        { allowed_tools: [] },
        [],
        'notion',
      );
      const notionEntries = tools.filter((t) =>
        NOTION_READ_MCP_TOOLS.includes(t),
      );
      expect(notionEntries.length).toBeGreaterThan(0);
      for (const entry of notionEntries) {
        expect(entry.startsWith(`mcp__${NOTION_MCP_SERVER_NAME}__`)).toBe(true);
      }
    });

    it('never merges Notion tools into a standard/code session, even for a Notion-task-source project', () => {
      const tools = getSessionAllowedTools(
        'standard',
        { allowed_tools: [] },
        [],
        'notion',
      );
      expect(tools.some((t) => t.startsWith('mcp__notion__'))).toBe(false);
    });
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
      'Bash(node ~/.claude/scripts/apply-task-intent.mjs:*)',
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

  it('returns true for an audited operational-record read an ops/gate-verify session might request', () => {
    // e.g. a gate-verify session asking to read dashboard.db directly, since
    // its base profile has no such tool — the sanctioned ask path, not
    // speculative pre-provisioning by the gate mechanism.
    expect(isGrantable('Bash(sqlite3 dashboard.db:*)')).toBe(true);
  });

  it('returns true for the own-record read capability — the never-grantable set stays unchanged', () => {
    expect(isGrantable(sessionRecordReadCapability('session-abc'))).toBe(true);
  });

  it('is not denied by GRANT_DENYLIST_PATTERNS for a read:path: capability whose path embeds "apply" or "resolve"', () => {
    expect(
      isGrantable(pathReadCapability('/some/dir/containing/apply/or/resolve')),
    ).toBe(true);
  });

  it('returns true for a Bash(...) capability whose quoted query-argument text embeds "resolve" as a column-name substring, not the command verb', () => {
    expect(
      isGrantable(
        'Bash(node readonly-db-query.js "SELECT resolved_at FROM capability_disqualification")',
      ),
    ).toBe(true);
  });

  it.each(['apply', 'resolve', 'done', 'task-intent'])(
    'returns true when "%s" only appears inside quoted query text, not as the command verb',
    (word) => {
      expect(
        isGrantable(`Bash(psql -c "SELECT * FROM t WHERE col = '${word}'")`),
      ).toBe(true);
    },
  );

  it.each(['apply', 'resolve', 'done', 'task-intent'])(
    'still returns false when "%s" appears unquoted as the command verb/action',
    (word) => {
      expect(isGrantable(`Bash(scripts/${word}-staged-intent.sh:*)`)).toBe(
        false,
      );
    },
  );
});

describe('pathReadCapability / parsePathReadCapability', () => {
  it('round-trips the granted absolute path through the capability string', () => {
    const capability = pathReadCapability('/srv/config/projects/foo');
    expect(capability).toBe('read:path:/srv/config/projects/foo');
    expect(parsePathReadCapability(capability)).toBe(
      '/srv/config/projects/foo',
    );
  });

  it('returns null for a capability that is not a read:path: grant', () => {
    expect(parsePathReadCapability('Bash(psql:*)')).toBeNull();
  });
});

describe('getSessionAddDirs', () => {
  let tmpDir: string;
  let configDir: string;
  let projectDir: string;
  const originalEnv = process.env.ORCHESTRATOR_CONFIG_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-add-dirs-'));
    configDir = path.join(tmpDir, 'config');
    projectDir = path.join(tmpDir, 'my-project');
    fs.mkdirSync(path.join(configDir, 'projects', 'my-project'), {
      recursive: true,
    });
    fs.mkdirSync(projectDir, { recursive: true });
    process.env.ORCHESTRATOR_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.ORCHESTRATOR_CONFIG_DIR;
    } else {
      process.env.ORCHESTRATOR_CONFIG_DIR = originalEnv;
    }
  });

  it.each(['groom', 'design', 'ops', 'docs', 'split'] as const)(
    'returns the shared central-config-tree baseline for a %s session, excluding credential-shaped siblings',
    (sessionType) => {
      const dirs = getSessionAddDirs(sessionType, [], projectDir);

      expect(dirs).toEqual(
        expect.arrayContaining([
          path.join(configDir, 'procedures.md'),
          path.join(configDir, 'task-writing.md'),
          path.join(configDir, 'README.md'),
          path.join(configDir, 'guidelines-baseline.json'),
          path.join(configDir, 'projects', 'my-project', 'context.md'),
          path.join(
            configDir,
            'projects',
            'my-project',
            'investigation-guide.md',
          ),
          path.join(configDir, 'projects', 'my-project', 'grooming.json'),
        ]),
      );

      for (const forbidden of ['remote-control.env', 'hooks', 'systemd']) {
        expect(dirs.some((d) => d.includes(forbidden))).toBe(false);
      }
    },
  );

  it.each(['standard', 'review'] as const)(
    'returns no baseline for a %s (non-planning) session',
    (sessionType) => {
      expect(getSessionAddDirs(sessionType, [], projectDir)).toEqual([]);
    },
  );

  it('adds exactly the granted read:path: root on top of the baseline', () => {
    const grantedPath = '/srv/orchestrator/data/some-project';
    const dirs = getSessionAddDirs(
      'ops',
      [pathReadCapability(grantedPath)],
      projectDir,
    );

    expect(dirs).toContain(grantedPath);
    expect(dirs).toEqual(
      expect.arrayContaining([path.join(configDir, 'procedures.md')]),
    );
  });

  it('ignores a granted capability that is not a read:path: grant', () => {
    const dirs = getSessionAddDirs('ops', ['Bash(psql:*)'], projectDir);
    expect(dirs).not.toContain('Bash(psql:*)');
  });

  it('adds only the granted path for a non-planning session, which has no baseline', () => {
    const grantedPath = '/srv/orchestrator/data/some-project';
    const dirs = getSessionAddDirs(
      'standard',
      [pathReadCapability(grantedPath)],
      projectDir,
    );
    expect(dirs).toEqual([grantedPath]);
  });
});

/**
 * Mirrors the SDK's `Bash(<prefix>:*)` deny-rule matching for test purposes
 * only: a chained command (`&&`/`;`/`|`) is evaluated per simple command,
 * and each simple command is denied if it equals, or starts with, one of
 * the rules' prefixes.
 */
function isDeniedByPatterns(patterns: string[], command: string): boolean {
  const prefixes = patterns
    .map((p) => /^Bash\((.+):\*\)$/.exec(p)?.[1])
    .filter((p): p is string => Boolean(p));
  const simpleCommands = command.split(/&&|;|\|/).map((c) => c.trim());
  return simpleCommands.some((sc) =>
    prefixes.some((prefix) => sc === prefix || sc.startsWith(`${prefix} `)),
  );
}

describe('getTestCommandDenyPatterns', () => {
  it('returns an empty list when no test commands are configured', () => {
    expect(getTestCommandDenyPatterns([])).toEqual([]);
  });

  it('turns each configured test command into a Bash(<command>:*) deny rule', () => {
    const denies = getTestCommandDenyPatterns([
      'npm test',
      'npm run test:unit',
    ]);
    expect(denies).toContain('Bash(npm test:*)');
    expect(denies).toContain('Bash(npm run test:unit:*)');
  });

  it('dedupes and trims whitespace', () => {
    const denies = getTestCommandDenyPatterns([' npm test ', 'npm test', '']);
    expect(denies.filter((p) => p === 'Bash(npm test:*)')).toHaveLength(1);
  });

  it('never denies the coarse install/build/typecheck prefixes', () => {
    const denies = getTestCommandDenyPatterns(['npm test']);
    expect(denies).not.toContain('Bash(npm:*)');
    expect(denies).not.toContain('Bash(npx:*)');
    expect(denies).not.toContain('Bash(tsc:*)');
  });

  describe('claude-dashboard-shaped config (npm run test -w <workspace>)', () => {
    const denies = getTestCommandDenyPatterns([
      'npm run test -w packages/frontend',
      'npm run test -w packages/backend',
    ]);

    it.each([
      'npx vitest run',
      'npx vitest run src/routes/__tests__/stagedIntents.dispositionStranded.test.ts',
      'cd packages/backend && npx vitest run',
      'cd packages/backend && npx vitest run 2>&1 | tail -150',
    ])('blocks the direct-runner bypass %s', (command) => {
      expect(isDeniedByPatterns(denies, command)).toBe(true);
    });

    it.each([
      'npx tsc --noEmit -p packages/backend/tsconfig.json',
      'npm run build',
      'npm ci',
    ])('leaves %s permitted', (command) => {
      expect(isDeniedByPatterns(denies, command)).toBe(false);
    });
  });

  describe('polimarket-shaped config (uv run pytest)', () => {
    const denies = getTestCommandDenyPatterns(['uv run pytest']);

    it.each([
      'uv run pytest',
      'uv run pytest tests/',
      'pytest',
      'python -m pytest',
    ])('blocks the direct-runner invocation %s', (command) => {
      expect(isDeniedByPatterns(denies, command)).toBe(true);
    });

    it('does not block other uv run subcommands', () => {
      expect(isDeniedByPatterns(denies, 'uv run ruff check')).toBe(false);
      expect(isDeniedByPatterns(denies, 'uv sync')).toBe(false);
    });
  });
});

describe('bashCapabilityConfersFileMutation', () => {
  it.each([
    'Bash(sed:*)',
    'Bash(perl -i:*)',
    'Bash(tee:*)',
    'Bash(dd:*)',
    'Bash(rm:*)',
    'Bash(cp:*)',
    'Bash(mv:*)',
  ])('returns true for the file-mutating command %s', (capability) => {
    expect(bashCapabilityConfersFileMutation(capability)).toBe(true);
  });

  it('returns true when the capability string embeds a shell redirect', () => {
    expect(bashCapabilityConfersFileMutation('Bash(echo hi > file.txt)')).toBe(
      true,
    );
  });

  it.each(['Bash(psql:*)', 'Bash(git:*)', 'Bash(cat:*)', 'Bash(ls:*)'])(
    'returns false for the non-mutating command %s',
    (capability) => {
      expect(bashCapabilityConfersFileMutation(capability)).toBe(false);
    },
  );

  it('returns false for a non-Bash capability', () => {
    expect(
      bashCapabilityConfersFileMutation('mcp__github__merge_pull_request'),
    ).toBe(false);
    expect(bashCapabilityConfersFileMutation('Edit')).toBe(false);
  });
});

describe('sessionRecordReadCapability / parseSessionRecordReadCapability', () => {
  it('round-trips the target session id through the capability string', () => {
    const capability = sessionRecordReadCapability('session-abc');
    expect(capability).toBe('read:session-record:session-abc');
    expect(parseSessionRecordReadCapability(capability)).toBe('session-abc');
  });

  it('returns null for a capability that is not an own-record-read grant', () => {
    expect(parseSessionRecordReadCapability('Bash(psql:*)')).toBeNull();
    expect(
      parseSessionRecordReadCapability('mcp__github__merge_pull_request'),
    ).toBeNull();
  });

  it('is read-only: there is no write/mutation counterpart capability string', () => {
    // The own-record read has exactly one grantable form — a read keyed by
    // target session id. There is no `write:session-record:...` or similar,
    // and this prefix never widens into anything other than that one read.
    const capability = sessionRecordReadCapability('session-xyz');
    expect(capability).not.toMatch(/write|mutate|delete|update/i);
  });

  it("is never merged into the spawned session's CLI --allowed-tools — it names no tool the CLI resolves, only a route-level grant check", () => {
    const capability = sessionRecordReadCapability('session-abc');
    const merged = getSessionAllowedTools('ops', { allowed_tools: [] }, [
      capability,
    ]);
    expect(merged).not.toContain(capability);
  });
});

describe('auditLogReadCapability / parseAuditLogReadCapability', () => {
  it('round-trips the target project id through the capability string', () => {
    const capability = auditLogReadCapability('project-abc');
    expect(capability).toBe('read:audit-log:project-abc');
    expect(parseAuditLogReadCapability(capability)).toBe('project-abc');
  });

  it('returns null for a capability that is not an audit-log-read grant', () => {
    expect(parseAuditLogReadCapability('Bash(psql:*)')).toBeNull();
    expect(
      parseAuditLogReadCapability(sessionRecordReadCapability('session-abc')),
    ).toBeNull();
  });

  it("is never merged into the spawned session's CLI --allowed-tools", () => {
    const capability = auditLogReadCapability('project-abc');
    const merged = getSessionAllowedTools('ops', { allowed_tools: [] }, [
      capability,
    ]);
    expect(merged).not.toContain(capability);
  });
});

describe('sessionEventsReadCapability / parseSessionEventsReadCapability', () => {
  it('round-trips the target project id through the capability string', () => {
    const capability = sessionEventsReadCapability('project-abc');
    expect(capability).toBe('read:session-events:project-abc');
    expect(parseSessionEventsReadCapability(capability)).toBe('project-abc');
  });

  it('returns null for a capability that is not a session-events-read grant', () => {
    expect(parseSessionEventsReadCapability('Bash(psql:*)')).toBeNull();
    expect(
      parseSessionEventsReadCapability(
        sessionRecordReadCapability('session-abc'),
      ),
    ).toBeNull();
    expect(
      parseSessionEventsReadCapability(auditLogReadCapability('project-abc')),
    ).toBeNull();
  });

  it("is never merged into the spawned session's CLI --allowed-tools", () => {
    const capability = sessionEventsReadCapability('project-abc');
    const merged = getSessionAllowedTools('ops', { allowed_tools: [] }, [
      capability,
    ]);
    expect(merged).not.toContain(capability);
  });
});

describe('isSanctionedAutoApproveCapability', () => {
  it("auto-approves the audit-log capability for the requesting session's own project", () => {
    expect(
      isSanctionedAutoApproveCapability(
        auditLogReadCapability('project-abc'),
        'session-1',
        'project-abc',
      ),
    ).toBe(true);
  });

  it("does not auto-approve the audit-log capability for a different project than the requester's own", () => {
    expect(
      isSanctionedAutoApproveCapability(
        auditLogReadCapability('project-other'),
        'session-1',
        'project-abc',
      ),
    ).toBe(false);
  });

  it('does not auto-approve the audit-log capability when no requesting project id is supplied', () => {
    expect(
      isSanctionedAutoApproveCapability(
        auditLogReadCapability('project-abc'),
        'session-1',
      ),
    ).toBe(false);
  });

  it("auto-approves the session-events capability for the requesting session's own project", () => {
    expect(
      isSanctionedAutoApproveCapability(
        sessionEventsReadCapability('project-abc'),
        'session-1',
        'project-abc',
      ),
    ).toBe(true);
  });

  it("does not auto-approve the session-events capability for a different project than the requester's own", () => {
    expect(
      isSanctionedAutoApproveCapability(
        sessionEventsReadCapability('project-other'),
        'session-1',
        'project-abc',
      ),
    ).toBe(false);
  });

  it('still auto-approves the own-record-read capability for the requesting session', () => {
    expect(
      isSanctionedAutoApproveCapability(
        sessionRecordReadCapability('session-1'),
        'session-1',
        'project-abc',
      ),
    ).toBe(true);
  });

  it('does not auto-approve the audit-log capability for a groom session', () => {
    expect(
      isSanctionedAutoApproveCapability(
        auditLogReadCapability('project-abc'),
        'session-1',
        'project-abc',
        'groom',
      ),
    ).toBe(false);
  });

  it('does not auto-approve the session-events capability for a groom session', () => {
    expect(
      isSanctionedAutoApproveCapability(
        sessionEventsReadCapability('project-abc'),
        'session-1',
        'project-abc',
        'groom',
      ),
    ).toBe(false);
  });

  it.each(['ops', 'design', 'review'])(
    'still auto-approves the audit-log capability for a %s session',
    (sessionType) => {
      expect(
        isSanctionedAutoApproveCapability(
          auditLogReadCapability('project-abc'),
          'session-1',
          'project-abc',
          sessionType,
        ),
      ).toBe(true);
    },
  );

  it.each(['ops', 'design', 'review'])(
    'still auto-approves the session-events capability for a %s session',
    (sessionType) => {
      expect(
        isSanctionedAutoApproveCapability(
          sessionEventsReadCapability('project-abc'),
          'session-1',
          'project-abc',
          sessionType,
        ),
      ).toBe(true);
    },
  );

  it('still auto-approves the own-record-read capability for a groom session', () => {
    expect(
      isSanctionedAutoApproveCapability(
        sessionRecordReadCapability('session-1'),
        'session-1',
        'project-abc',
        'groom',
      ),
    ).toBe(true);
  });

  it.each([
    ['audit-log', auditLogReadCapability('project-abc')],
    ['session-events', sessionEventsReadCapability('project-abc')],
  ])(
    'auto-approves the %s capability for an investigate-dispatched session (sessionType ops, report-batch task id)',
    (_label, capability) => {
      expect(
        isSanctionedAutoApproveCapability(
          capability,
          'session-1',
          'project-abc',
          'ops',
          'report-batch:batch-1',
        ),
      ).toBe(true);
    },
  );
});

describe('isDeclaredWriteAutoApprove', () => {
  it('is true for a capability that exact-matches a non-Prod-Mutating declared entry', () => {
    expect(
      isDeclaredWriteAutoApprove('Bash(npm ci:*)', [
        { capability: 'Bash(npm ci:*)', prodMutating: false },
      ]),
    ).toBe(true);
  });

  it('is false for a capability that matches a Prod-Mutating declared entry', () => {
    expect(
      isDeclaredWriteAutoApprove('Bash(git push:*)', [
        { capability: 'Bash(git push:*)', prodMutating: true },
      ]),
    ).toBe(false);
  });

  it('is false for a capability with no declared match at all', () => {
    expect(
      isDeclaredWriteAutoApprove('Bash(npm publish:*)', [
        { capability: 'Bash(npm ci:*)', prodMutating: false },
      ]),
    ).toBe(false);
  });

  it('never matches by prefix/pattern — only an exact string match counts', () => {
    expect(
      isDeclaredWriteAutoApprove('Bash(npm ci --production:*)', [
        { capability: 'Bash(npm ci:*)', prodMutating: false },
      ]),
    ).toBe(false);
  });

  it('is false for an empty declared-writes set', () => {
    expect(isDeclaredWriteAutoApprove('Bash(npm ci:*)', [])).toBe(false);
  });
});

describe('resolvePreGrantSessionKind', () => {
  it('resolves an ops session on a gate-item task to gate-verify', () => {
    expect(resolvePreGrantSessionKind('ops', 'gate-item:abc123')).toBe(
      'gate-verify',
    );
  });

  it('resolves an ops session on a report-batch task to investigate', () => {
    expect(resolvePreGrantSessionKind('ops', 'report-batch:xyz789')).toBe(
      'investigate',
    );
  });

  it('resolves a plain ops session to ops', () => {
    expect(resolvePreGrantSessionKind('ops', 'notion:abc123')).toBe('ops');
  });

  it('resolves groom/design/docs sessions to themselves', () => {
    expect(resolvePreGrantSessionKind('groom', 'notion:abc123')).toBe(
      'groom',
    );
    expect(resolvePreGrantSessionKind('design', 'notion:abc123')).toBe(
      'design',
    );
    expect(resolvePreGrantSessionKind('docs', 'notion:abc123')).toBe('docs');
  });

  it('returns null for session types with no pre-grant key', () => {
    expect(resolvePreGrantSessionKind('standard', 'notion:abc123')).toBeNull();
    expect(resolvePreGrantSessionKind('review', 'notion:abc123')).toBeNull();
    expect(resolvePreGrantSessionKind('split', 'notion:abc123')).toBeNull();
    expect(
      resolvePreGrantSessionKind('depth_review', 'notion:abc123'),
    ).toBeNull();
  });

  it('returns null for a null/undefined taskId on a non-ops-sub-kind session type', () => {
    expect(resolvePreGrantSessionKind('standard', null)).toBeNull();
    expect(resolvePreGrantSessionKind('standard', undefined)).toBeNull();
  });
});

describe('resolvePreGrantCapabilities', () => {
  it('returns the configured pre-grant list for each of the six resolvable kinds', () => {
    const orchConfig = {
      capability_pre_grants: {
        'gate-verify': ['read:audit-log:proj-1'],
        investigate: ['read:session-events:proj-1'],
        ops: ['read:audit-log:proj-1'],
        groom: ['read:path:/etc/foo'],
        design: ['read:session-events:proj-1'],
        docs: ['read:path:/etc/bar'],
      },
    };

    expect(
      resolvePreGrantCapabilities(orchConfig, 'ops', 'gate-item:abc'),
    ).toEqual(['read:audit-log:proj-1']);
    expect(
      resolvePreGrantCapabilities(orchConfig, 'ops', 'report-batch:abc'),
    ).toEqual(['read:session-events:proj-1']);
    expect(
      resolvePreGrantCapabilities(orchConfig, 'ops', 'notion:abc'),
    ).toEqual(['read:audit-log:proj-1']);
    expect(
      resolvePreGrantCapabilities(orchConfig, 'groom', 'notion:abc'),
    ).toEqual(['read:path:/etc/foo']);
    expect(
      resolvePreGrantCapabilities(orchConfig, 'design', 'notion:abc'),
    ).toEqual(['read:session-events:proj-1']);
    expect(
      resolvePreGrantCapabilities(orchConfig, 'docs', 'notion:abc'),
    ).toEqual(['read:path:/etc/bar']);
  });

  it('drops a configured entry that fails isGrantable rather than writing it', () => {
    const orchConfig = {
      capability_pre_grants: {
        ops: ['read:audit-log:proj-1', 'Bash(git task-intent apply:*)'],
      },
    };

    expect(
      resolvePreGrantCapabilities(orchConfig, 'ops', 'notion:abc'),
    ).toEqual(['read:audit-log:proj-1']);
  });

  it('returns [] for a session type with no pre-grant key, regardless of config', () => {
    const orchConfig = {
      capability_pre_grants: { ops: ['read:audit-log:proj-1'] },
    };
    expect(
      resolvePreGrantCapabilities(orchConfig, 'standard', 'notion:abc'),
    ).toEqual([]);
  });

  it('returns [] when the resolved kind has no configured entry', () => {
    const orchConfig = { capability_pre_grants: {} };
    expect(
      resolvePreGrantCapabilities(orchConfig, 'ops', 'notion:abc'),
    ).toEqual([]);
  });
});
