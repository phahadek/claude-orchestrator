import { describe, it, expect } from 'vitest';
import {
  ALLOWED_TOOLS,
  GROOM_ALLOWED_TOOLS,
  DESIGN_ALLOWED_TOOLS,
  OPS_ALLOWED_TOOLS,
} from '../config';
import { orchestratorMcpToolName } from '../mcp/toolNaming';

// Every kind registered as an orchestrator MCP server tool (see
// mcp/tools/stageProposalTools.ts, mcp/tools/verdictTools.ts,
// mcp/orchestratorMcpServer.ts) — the source of truth every
// mcp__orchestrator__ allow-list entry below is checked against.
const REGISTERED_ORCHESTRATOR_MCP_KINDS = [
  'health',
  'task.create',
  'task.setStatus',
  'task.setDependsOn',
  'task.updateBody',
  'task.setProperties',
  'gate.accrete',
  'seed.stage',
  'arch.createUnit',
  'arch.updateUnit',
  'arch.supersedeUnit',
  'decision.pickOne',
  'journal.setState',
  'session.requestCapability',
  'review.disposition',
  'flaky.confirm',
  'gate.verify',
];

const REGISTERED_TOOL_NAMES = new Set(
  REGISTERED_ORCHESTRATOR_MCP_KINDS.map(orchestratorMcpToolName),
);

describe('ALLOWED_TOOLS — backend-owned PR operations are excluded', () => {
  it('does not contain the mcp__github__* wildcard', () => {
    expect(ALLOWED_TOOLS).not.toContain('mcp__github__*');
  });

  it('does not grant sessions create_pull_request access', () => {
    expect(ALLOWED_TOOLS).not.toContain('mcp__github__create_pull_request');
  });

  it('does not grant sessions merge_pull_request access', () => {
    expect(ALLOWED_TOOLS).not.toContain('mcp__github__merge_pull_request');
  });

  it('retains push_files so sessions can push code', () => {
    expect(ALLOWED_TOOLS).toContain('mcp__github__push_files');
  });

  it('retains github read tools sessions need', () => {
    const readTools = [
      'mcp__github__get_issue',
      'mcp__github__get_pull_request',
      'mcp__github__get_pull_request_files',
      'mcp__github__list_pull_requests',
      'mcp__github__list_issues',
      'mcp__github__search_code',
      'mcp__github__search_issues',
      'mcp__github__search_repositories',
    ];
    for (const tool of readTools) {
      expect(ALLOWED_TOOLS).toContain(tool);
    }
  });
});

describe('mcp__orchestrator__ allow-list entries match the CLI-exposed tool name', () => {
  const allAllowLists = {
    ALLOWED_TOOLS,
    GROOM_ALLOWED_TOOLS,
    DESIGN_ALLOWED_TOOLS,
    OPS_ALLOWED_TOOLS,
  };

  for (const [listName, list] of Object.entries(allAllowLists)) {
    const orchestratorEntries = list.filter((t) =>
      t.startsWith('mcp__orchestrator__'),
    );

    it(`${listName} contains no dotted mcp__orchestrator__ entries`, () => {
      for (const entry of orchestratorEntries) {
        expect(entry).not.toMatch(/\./);
      }
    });

    it(`${listName}'s mcp__orchestrator__ entries all match a registered server tool`, () => {
      for (const entry of orchestratorEntries) {
        expect(REGISTERED_TOOL_NAMES.has(entry)).toBe(true);
      }
    });
  }

  it('ops/gate allow-list contains the underscore forms of gate_verify, task_create, journal_setState, session_requestCapability', () => {
    expect(OPS_ALLOWED_TOOLS).toContain('mcp__orchestrator__gate_verify');
    expect(OPS_ALLOWED_TOOLS).toContain('mcp__orchestrator__task_create');
    expect(OPS_ALLOWED_TOOLS).toContain('mcp__orchestrator__journal_setState');
    expect(OPS_ALLOWED_TOOLS).toContain(
      'mcp__orchestrator__session_requestCapability',
    );
  });
});
