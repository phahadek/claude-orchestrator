import { describe, it, expect } from 'vitest';
import {
  assemblePlanningProcedure,
  deriveGroomDigestSlice,
  deriveDesignDigestSlice,
  deriveOpsDigestSlice,
  type PlanningDigest,
} from '../planning/procedureAssembler';
import type { GroomLoadResult } from '../groom/groomLoad';
import type { DesignLoadResult } from '../design/designLoad';
import type { OpsLoadResult } from '../ops/opsLoad';

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
        },
      },
    ],
  } as unknown as GroomLoadResult;
}

function fixtureDesignLoadResult(): DesignLoadResult {
  return {
    contextPages: [{ id: 'ctx-2', title: 'Design Master Context', markdown: '...' }],
    board: [],
    neighbourBoards: [],
    targetTasks: [
      {
        id: 'task-2',
        title: 'Design the thing',
        status: '📐 Design',
        type: '📐 Design',
        priority: 'P1',
        url: 'https://notion.so/task-2',
        filesSection: '',
        rawMarkdown: '## Summary\n\nDesign the thing body.',
        openQuestions: [],
        regions: {
          packages: ['packages/backend'],
          files: ['packages/backend/src/foo.ts'],
        },
      },
    ],
  } as unknown as DesignLoadResult;
}

function fixtureOpsLoadResult(): OpsLoadResult {
  const task = {
    id: 'task-3',
    title: 'Stand up off-box backups',
    status: '🔄 In Progress',
    url: 'https://notion.so/task-3',
    type: '🔧 Operational',
    mode: 'operational' as const,
    dependsOn: [],
    blockingDepIds: [],
    depStatus: 'ready' as const,
  };
  return {
    contextPages: [
      { id: 'ctx-3', title: 'Ops Master Context', markdown: '...' },
    ],
    boards: {
      target: { milestone: 'm1', board: 'b1', counts: {} as never },
      neighbours: [],
    },
    worklist: {
      executable: [task],
      dep_blocked: [],
      needs_grooming: [],
      closed_not_done: [],
      leftover_tooling: [],
      test_authoring: [],
      newly_unblocked: [],
    },
  } as unknown as OpsLoadResult;
}

function assembleOps(): string {
  const digest: PlanningDigest = {
    workflow: 'ops',
    data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
  };
  return assemblePlanningProcedure({
    taskName: 'Stand up off-box backups',
    taskUrl: 'https://notion.so/task-3',
    milestoneId: 'm1',
    projectId: 'p1',
    digest,
  });
}

function assembleGroom(): string {
  const digest: PlanningDigest = {
    workflow: 'groom',
    data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
  };
  return assemblePlanningProcedure({
    taskName: 'Do the thing',
    taskUrl: 'https://notion.so/task-1',
    milestoneId: 'm1',
    projectId: 'p1',
    digest,
  });
}

function assembleDesign(): string {
  const digest: PlanningDigest = {
    workflow: 'design',
    data: deriveDesignDigestSlice(fixtureDesignLoadResult()),
  };
  return assemblePlanningProcedure({
    taskName: 'Design the thing',
    taskUrl: 'https://notion.so/task-2',
    milestoneId: 'm1',
    projectId: 'p1',
    digest,
  });
}

describe('assembled ops procedure — incidental tooling-gap triage', () => {
  it('distinguishes a tooling gap incidental to the mandate from one required by it', () => {
    const output = assembleOps();
    expect(output).toContain('An incidental tooling gap is not a blocker');
    expect(output).toContain('IS incidental:');
    expect(output).toContain('IS required:');
  });

  it('instructs filing the incidental gap as a follow-on and continuing, recording it once', () => {
    const output = assembleOps();
    expect(output).toMatch(/file it as a follow-on `task\.create` once/);
    expect(output).toMatch(/record it in the journal in a single line/);
    expect(output).toMatch(/continue executing the mandate/);
    expect(output).toMatch(
      /DO NOT re-stage `journal\.setState` about the same incidental gap more than once/,
    );
    expect(output).toMatch(/DO NOT end the turn, stall, or wait on operator input/);
  });

  it('still requires session.requestCapability for a genuinely required capability', () => {
    const output = assembleOps();
    expect(output).toContain('Ask for what you need — never fabricate');
    expect(output).toMatch(/stage `session\.requestCapability`/);
  });

  it('still permits needs-setup for a real blocker', () => {
    const output = assembleOps();
    expect(output).toMatch(/report `needs-setup`/);
  });

  it('states the injected digest is authoritative, so a task-store read failure is not itself a stop condition', () => {
    const output = assembleOps();
    expect(output).toMatch(
      /injected digest is the authoritative task content/,
    );
    expect(output).toMatch(
      /failure to reach the task store .* is not by itself a reason to stop/,
    );
  });

  it('never instructs fabricating around a gap', () => {
    const output = assembleOps();
    expect(output).toMatch(
      /DO NOT fabricate or guess at what the missing read would have returned/,
    );
  });

  it('leaves the groom procedure unaffected', () => {
    const output = assembleGroom();
    expect(output).not.toContain('An incidental tooling gap is not a blocker');
  });

  it('leaves the design procedure unaffected', () => {
    const output = assembleDesign();
    expect(output).not.toContain('An incidental tooling gap is not a blocker');
  });
});
