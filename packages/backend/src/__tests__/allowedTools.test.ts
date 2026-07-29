import { describe, it, expect } from 'vitest';
import {
  ALLOWED_TOOLS,
  GROOM_ALLOWED_TOOLS,
  DESIGN_ALLOWED_TOOLS,
  OPS_ALLOWED_TOOLS,
  PLANNING_DISALLOWED_TOOLS,
  NOTION_READ_MCP_TOOLS,
} from '../config';
import {
  orchestratorMcpToolName,
  notionMcpToolName,
  NOTION_MCP_SERVER_NAME,
} from '../mcp/toolNaming';

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
  'task.patchBodySection',
  'intent.withdraw',
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
  'completeness.disposition',
  'completeness.traceCoverage',
  'groom.precheck',
  'architecture.getUnit',
  'architecture.queryUnits',
  'task.getById',
];

const REGISTERED_TOOL_NAMES = new Set(
  REGISTERED_ORCHESTRATOR_MCP_KINDS.map(orchestratorMcpToolName),
);

describe('PLANNING_DISALLOWED_TOOLS', () => {
  it('blocks self-scheduling/re-entry built-ins alongside the prior Skill/Write/Edit denylist', () => {
    expect(PLANNING_DISALLOWED_TOOLS).toEqual(
      expect.arrayContaining([
        'Skill',
        'Write',
        'Edit',
        'ScheduleWakeup',
        'CronCreate',
        'CronDelete',
        'CronList',
      ]),
    );
    expect(PLANNING_DISALLOWED_TOOLS).toHaveLength(7);
  });
});

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

  it('design allow-list contains the underscore forms of completeness_disposition and completeness_traceCoverage', () => {
    expect(DESIGN_ALLOWED_TOOLS).toContain(
      'mcp__orchestrator__completeness_disposition',
    );
    expect(DESIGN_ALLOWED_TOOLS).toContain(
      'mcp__orchestrator__completeness_traceCoverage',
    );
  });

  it('groom allow-list contains the underscore form of groom_precheck', () => {
    expect(GROOM_ALLOWED_TOOLS).toContain('mcp__orchestrator__groom_precheck');
  });

  it('groom/design/ops allow-lists all contain the underscore forms of architecture_getUnit and architecture_queryUnits', () => {
    for (const list of [
      GROOM_ALLOWED_TOOLS,
      DESIGN_ALLOWED_TOOLS,
      OPS_ALLOWED_TOOLS,
    ]) {
      expect(list).toContain('mcp__orchestrator__architecture_getUnit');
      expect(list).toContain('mcp__orchestrator__architecture_queryUnits');
    }
  });

  it('groom/design/ops allow-lists all contain the underscore form of task_getById', () => {
    for (const list of [
      GROOM_ALLOWED_TOOLS,
      DESIGN_ALLOWED_TOOLS,
      OPS_ALLOWED_TOOLS,
    ]) {
      expect(list).toContain('mcp__orchestrator__task_getById');
    }
  });

  it('ops/gate allow-list contains the underscore forms of gate_verify, task_create, journal_setState, session_requestCapability', () => {
    expect(OPS_ALLOWED_TOOLS).toContain('mcp__orchestrator__gate_verify');
    expect(OPS_ALLOWED_TOOLS).toContain('mcp__orchestrator__task_create');
    expect(OPS_ALLOWED_TOOLS).toContain('mcp__orchestrator__journal_setState');
    expect(OPS_ALLOWED_TOOLS).toContain(
      'mcp__orchestrator__session_requestCapability',
    );
  });
});

describe('NOTION_READ_MCP_TOOLS', () => {
  it('carries the prefix derived from the registered server key (mcp__notion__), never the unresolvable claude.ai connector namespace', () => {
    for (const tool of NOTION_READ_MCP_TOOLS) {
      expect(tool.startsWith(`mcp__${NOTION_MCP_SERVER_NAME}__`)).toBe(true);
      expect(tool.startsWith('mcp__claude_ai_Notion__')).toBe(false);
    }
  });

  it('every entry is derivable via notionMcpToolName — no hand-written entry can drift from the server key', () => {
    for (const tool of NOTION_READ_MCP_TOOLS) {
      const rawName = tool.slice(`mcp__${NOTION_MCP_SERVER_NAME}__`.length);
      expect(notionMcpToolName(rawName)).toBe(tool);
    }
  });

  it('matches the real tool names exposed by the pinned @notionhq/notion-mcp-server@2.5.1 (verified live against the connected server), never the simplified search/fetch/get-comments names it does not expose', () => {
    expect(NOTION_READ_MCP_TOOLS).toEqual(
      [
        'API-post-search',
        'API-retrieve-page-markdown',
        'API-retrieve-a-comment',
        'API-get-users',
        'API-get-user',
        'API-get-self',
        'API-retrieve-a-page',
        'API-retrieve-a-page-property',
        'API-retrieve-a-block',
        'API-get-block-children',
        'API-query-data-source',
        'API-retrieve-a-data-source',
        'API-retrieve-a-database',
        'API-list-data-source-templates',
      ].map(notionMcpToolName),
    );
  });

  it('contains no create, update, move, or delete verb — a Notion integration token grants write, but this allow-list must stay read-only', () => {
    const writeVerbPattern = /create|update|move|delete/i;
    for (const tool of NOTION_READ_MCP_TOOLS) {
      expect(tool).not.toMatch(writeVerbPattern);
    }
  });

  it('is not unconditionally present in the task-source-agnostic base groom/design/ops allow-lists', () => {
    for (const list of [
      GROOM_ALLOWED_TOOLS,
      DESIGN_ALLOWED_TOOLS,
      OPS_ALLOWED_TOOLS,
    ]) {
      for (const notionTool of NOTION_READ_MCP_TOOLS) {
        expect(list).not.toContain(notionTool);
      }
    }
  });
});
