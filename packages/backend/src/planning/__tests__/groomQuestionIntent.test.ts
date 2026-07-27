import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  assemblePlanningProcedure,
  deriveGroomDigestSlice,
} from '../procedureAssembler';
import { PLANNING_INTENT_KINDS } from '../planningIntentKinds';
import { GROOM_ALLOWED_TOOLS } from '../../config';
import { orchestratorMcpToolName } from '../../mcp/toolNaming';
import { buildMcpServer } from '../../mcp/orchestratorMcpServer';
import { SessionManager } from '../../session/SessionManager';
import { insertSession } from '../../db/queries';
import { createStagedIntentsRouter } from '../../routes/stagedIntents';
import { getStagedIntent } from '../../db/queries';
import type { GroomLoadResult } from '../../groom/groomLoad';

function fixtureGroomLoadResult(): GroomLoadResult {
  return {
    contextPages: [{ id: 'ctx-1', title: 'Master Context', markdown: '...' }],
    board: [],
    neighbourBoards: [],
    targetTasks: [
      {
        id: 'task-1',
        title: 'Do the thing',
        status: '🔲 Backlog',
        type: '💻 Code',
        priority: 'P1',
        url: 'https://notion.so/task-1',
        filesSection: '',
        rawMarkdown: '## Summary\n\nDo the thing body.',
        readinessViolations: [{ code: 'no_open_questions', message: 'ok' }],
        sizeCheckSeed: { files: 3, loc_method: 'estimated' },
        typeCheck: { decision: 'none' },
        regions: {
          packages: ['packages/backend'],
          files: ['packages/backend/src/foo.ts'],
          planned: [],
        },
        bindingConstraints: ['constraint-a'],
        filesPathsEntries: [],
        dependsOnTasks: [],
      },
    ],
    codeWorklist: new Map(),
    gitFreshness: {},
    dependencyCandidates: [
      {
        taskId: 'task-1',
        candidateBlockers: [{ id: 'blocker-1' }],
        declaredDeps: ['dep-1'],
      },
    ],
  } as unknown as GroomLoadResult;
}

function assembleGroomOutput(): string {
  return assemblePlanningProcedure({
    taskName: 'A task',
    taskUrl: 'https://notion.so/x',
    milestoneId: 'm1',
    projectId: 'p1',
    digest: {
      workflow: 'groom',
      data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
    },
  });
}

describe('groom decision.pickOne question-intent', () => {
  it('PLANNING_INTENT_KINDS.groom contains decision.pickOne', () => {
    expect(PLANNING_INTENT_KINDS.groom).toContain('decision.pickOne');
  });

  it('GROOM_ALLOWED_TOOLS contains the CLI-sanitized decision.pickOne tool name', () => {
    expect(GROOM_ALLOWED_TOOLS).toContain(
      orchestratorMcpToolName('decision.pickOne'),
    );
  });

  it('the assembled groom procedure renders a decision.pickOne invocation example', () => {
    const output = assembleGroomOutput();
    expect(output).toMatch(
      /`mcp__orchestrator__decision_pickOne` with `\{"payload":/,
    );
  });

  it('the assembled groom procedure instructs raising an operator-judgment finding as a question-intent, not a status write', () => {
    const output = assembleGroomOutput();
    expect(output).toMatch(/operator judgment/i);
    expect(output).toMatch(/decision\.pickOne/);
    expect(output).toMatch(/never smuggled through a `task\.setStatus`/);
  });

  it('the assembled groom procedure states that task.setStatus is staged only when the status actually changes', () => {
    const output = assembleGroomOutput();
    expect(output).toMatch(
      /`task\.setStatus` is staged only when the status is actually changing/,
    );
  });

  it('the assembled groom procedure still forbids punting a resolvable readiness judgment to the operator', () => {
    const output = assembleGroomOutput();
    expect(output).toMatch(/not a punt channel/);
    expect(output).toMatch(
      /a readiness judgment this session is equipped to resolve is still resolved now/,
    );
  });
});

describe('a decision.pickOne staged by a groom session', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM staged_intent').run();
    db.prepare('DELETE FROM staged_intent_group').run();
  });

  it('persists as staged and is answerable', async () => {
    const sessionId = 'groom-question-1';
    insertSession({
      session_id: sessionId,
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'groom',
    });

    const server = buildMcpServer(sessionId, new SessionManager());
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: 'decision.pickOne',
      arguments: {
        payload: {
          prompt: 'Widen scope, file a sibling task, or proceed as specified?',
          options: [
            {
              label: 'Widen scope',
              description: 'Cover the API transport too.',
            },
            {
              label: 'File a sibling task',
              description:
                'Scope this task as-is; API transport gets its own task.',
            },
          ],
          allowFreeForm: true,
        },
        decisionProposal:
          'Scope gap found: the Scope section omits the ApiSessionRunner transport.',
      },
    });
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    const text = (result as { content: Array<{ type: string; text?: string }> })
      .content[0]?.text;
    const intent = JSON.parse(text as string) as { id: string };

    await client.close();
    await server.close();

    const staged = getStagedIntent(intent.id)!;
    expect(staged.kind).toBe('decision.pickOne');
    expect(staged.state).toBe('staged');

    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter());
    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/answer`)
      .send({ chosenLabel: 'Widen scope' });

    expect(res.status).toBe(200);
    const answered = getStagedIntent(intent.id)!;
    expect(answered.state).toBe('committed');
    expect(JSON.parse(answered.answer!)).toEqual({
      chosenLabel: 'Widen scope',
      freeForm: null,
    });
  });
});
