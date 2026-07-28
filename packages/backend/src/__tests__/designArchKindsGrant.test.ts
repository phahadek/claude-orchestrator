/**
 * A design session locks decisions, updates architecture pages, and files
 * follow-on Code tasks per config/procedures.md § Task types — but until
 * now PLANNING_INTENT_KINDS.design had no arch.* kind, so the architecture-
 * page update (the type's defining deliverable) was unreachable even though
 * the MCP tools were registered for every session (registerStageProposalTools).
 * See planningIntentKinds.ts for the single source of truth these lists
 * derive from.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db';
import { DESIGN_ALLOWED_TOOLS } from '../config';
import { orchestratorMcpToolName } from '../mcp/toolNaming';
import { PLANNING_INTENT_KINDS } from '../planning/planningIntentKinds';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerStageProposalTools } from '../mcp/tools/stageProposalTools';
import { getStagedIntent } from '../db/queries';
import {
  assemblePlanningProcedure,
  deriveDesignDigestSlice,
} from '../planning/procedureAssembler';
import type { DesignLoadResult } from '../design/designLoad';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('PLANNING_INTENT_KINDS — design gains the arch.* kinds', () => {
  it('design includes arch.createUnit, arch.updateUnit and arch.supersedeUnit', () => {
    expect(PLANNING_INTENT_KINDS.design).toContain('arch.createUnit');
    expect(PLANNING_INTENT_KINDS.design).toContain('arch.updateUnit');
    expect(PLANNING_INTENT_KINDS.design).toContain('arch.supersedeUnit');
  });

  it('groom does not gain any arch.* kind', () => {
    expect(PLANNING_INTENT_KINDS.groom.some((k) => k.startsWith('arch.'))).toBe(
      false,
    );
  });

  it('ops does not gain any arch.* kind', () => {
    expect(PLANNING_INTENT_KINDS.ops.some((k) => k.startsWith('arch.'))).toBe(
      false,
    );
  });
});

describe('DESIGN_ALLOWED_TOOLS — CLI-sanitized arch.* names', () => {
  it.each(['arch.createUnit', 'arch.updateUnit', 'arch.supersedeUnit'])(
    'contains %s',
    (kind) => {
      expect(DESIGN_ALLOWED_TOOLS).toContain(orchestratorMcpToolName(kind));
    },
  );
});

function fixtureDesignLoadResult(): DesignLoadResult {
  return {
    task: {
      id: 'task-2',
      title: 'Design the thing',
      status: '🔄 In Progress',
      type: '🎨 Design',
      url: 'https://notion.so/task-2',
    },
    markdown: '# Design the thing\n\nSome body.',
    openQuestions: {
      items: ['Should we do X or Y?'],
      source: 'explicit_heading',
    },
    archSource: 'notion',
    archUnits: [],
    unresolvedPageRefs: [],
    codeMapGrounding: {},
  };
}

describe('an assembled design procedure renders an arch.updateUnit invocation example', () => {
  it('includes the CLI-sanitized tool name and an example payload', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A design task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'design',
        data: deriveDesignDigestSlice(fixtureDesignLoadResult()),
      },
    });
    expect(output).toContain(orchestratorMcpToolName('arch.updateUnit'));
    expect(output).toContain('baseVersion');
  });
});

describe('a staged arch.updateUnit intent from a design session', () => {
  it('persists with state = "staged" and is not auto-applied', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerStageProposalTools(server, {
      sessionId: 'session-design-1',
      projectId: 'proj-1',
      kinds: PLANNING_INTENT_KINDS.design,
    });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: 'arch.updateUnit',
      arguments: {
        payload: {
          unitId: 'unit-1',
          baseVersion: 1,
          title: 'Updated title',
          body: 'Updated markdown body.',
        },
      },
    });

    const text = (result as { content: Array<{ type: string; text?: string }> })
      .content[0]?.text;
    expect(typeof text).toBe('string');
    const intent = JSON.parse(text as string) as { id: string; kind: string };
    expect(intent.kind).toBe('arch.updateUnit');

    const row = getStagedIntent(intent.id);
    expect(row).toBeTruthy();
    expect(row?.state).toBe('staged');

    await client.close();
    await server.close();
  });
});
