import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assemblePlanningProcedure,
  deriveGroomDigestSlice,
  deriveDesignDigestSlice,
  deriveOpsDigestSlice,
  WORKFLOW_LOADERS,
  type PlanningDigest,
} from '../procedureAssembler';
import type { GroomLoadResult } from '../../groom/groomLoad';
import type { DesignLoadResult } from '../../design/designLoad';
import type { OpsLoadResult } from '../../ops/opsLoad';
import { KNOWN_INTENT_KINDS } from '../../routes/stagedIntents';

// ─── fixtures ───────────────────────────────────────────────────────────────

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

function fixtureDesignLoadResult(
  codeMapGrounding: Record<string, unknown> = {},
): DesignLoadResult {
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
    archUnits: [{ id: 'arch-1', title: 'Arch Unit A', raw: '- Arch Unit A' }],
    unresolvedPageRefs: [
      { title: 'Some Unresolved Page', raw: '- Some Unresolved Page' },
    ],
    codeMapGrounding,
  };
}

function fixtureOpsLoadResult(): OpsLoadResult {
  const task = {
    id: 'task-3',
    title: 'Investigate the thing',
    status: '🔄 In Progress',
    url: 'https://notion.so/task-3',
    type: '🔎 Investigation',
    mode: 'investigation' as const,
    dependsOn: ['dep-2'],
    blockingDepIds: [],
    depStatus: 'ready' as const,
  };
  return {
    contextPages: [
      { id: 'ctx-2', title: 'Ops Master Context', markdown: '...' },
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

// ─── derive* ────────────────────────────────────────────────────────────────

describe('deriveGroomDigestSlice', () => {
  it('narrows the full loader result to the one target task validation slice', () => {
    const slice = deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1');
    expect(slice.task).toEqual({
      id: 'task-1',
      title: 'Do the thing',
      status: '🔲 Backlog',
      type: '💻 Code',
      url: 'https://notion.so/task-1',
    });
    expect(slice.sizeCheckSeed).toEqual({ files: 3, loc_method: 'estimated' });
    expect(slice.typeCheck).toEqual({ decision: 'none' });
    expect(slice.bindingConstraints).toEqual(['constraint-a']);
    expect(slice.dependencyCandidates?.taskId).toBe('task-1');
    expect(slice.regions).toEqual({
      packages: ['packages/backend'],
      files: ['packages/backend/src/foo.ts'],
      planned: [],
    });
    expect(slice.body).toBe('## Summary\n\nDo the thing body.');
    // never carries the full loader result's milestone-wide fields
    expect(slice as unknown as GroomLoadResult).not.toHaveProperty('board');
    expect(slice as unknown as GroomLoadResult).not.toHaveProperty(
      'contextPages',
    );
    expect(slice as unknown as GroomLoadResult).not.toHaveProperty(
      'neighbourBoards',
    );
  });

  it('matches ids hyphen/case-insensitively', () => {
    const slice = deriveGroomDigestSlice(fixtureGroomLoadResult(), 'TASK1');
    expect(slice.task.id).toBe('task-1');
  });

  it('throws when the task is not in targetTasks', () => {
    expect(() =>
      deriveGroomDigestSlice(fixtureGroomLoadResult(), 'nope'),
    ).toThrow();
  });
});

describe('deriveDesignDigestSlice', () => {
  it('narrows the loader result and flags cached code-map grounding', () => {
    const slice = deriveDesignDigestSlice(
      fixtureDesignLoadResult({ pkgA: {} }),
    );
    expect(slice.task.id).toBe('task-2');
    expect(slice.openQuestions.items).toEqual(['Should we do X or Y?']);
    expect(slice.archUnits).toHaveLength(1);
    expect(slice.unresolvedPageRefs).toHaveLength(1);
    expect(slice.hasCodeMapGrounding).toBe(true);
    expect(slice as unknown as DesignLoadResult).not.toHaveProperty(
      'codeMapGrounding',
    );
  });

  it('reports no grounding when the cache is empty', () => {
    const slice = deriveDesignDigestSlice(fixtureDesignLoadResult({}));
    expect(slice.hasCodeMapGrounding).toBe(false);
  });
});

describe('deriveOpsDigestSlice', () => {
  it('finds the target task across worklist buckets and carries the journal entry', () => {
    const journalEntry = {
      taskId: 'task-3',
      project: 'p1',
      milestone: 'm1',
      state: 'pending' as never,
      updatedAt: '2026-07-20T00:00:00Z',
    };
    const slice = deriveOpsDigestSlice(
      fixtureOpsLoadResult(),
      'task-3',
      journalEntry,
    );
    expect(slice.task.id).toBe('task-3');
    expect(slice.journalEntry).toEqual(journalEntry);
  });

  it('throws when the task is not present in any worklist bucket', () => {
    expect(() =>
      deriveOpsDigestSlice(fixtureOpsLoadResult(), 'nope', null),
    ).toThrow();
  });
});

// ─── assemblePlanningProcedure ──────────────────────────────────────────────

describe('assemblePlanningProcedure', () => {
  const cases: {
    workflow: PlanningDigest['workflow'];
    digest: PlanningDigest;
  }[] = [
    {
      workflow: 'groom',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    },
    {
      workflow: 'design',
      digest: {
        workflow: 'design',
        data: deriveDesignDigestSlice(fixtureDesignLoadResult()),
      },
    },
    {
      workflow: 'ops',
      digest: {
        workflow: 'ops',
        data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
      },
    },
  ];

  for (const { workflow, digest } of cases) {
    it(`composes the skeleton + ${workflow} procedure core + ${workflow} digest`, () => {
      const output = assemblePlanningProcedure({
        taskName: 'A task',
        taskUrl: 'https://notion.so/x',
        milestoneId: 'm1',
        projectId: 'p1',
        digest,
      });

      // Skeleton — written once, present for every workflow.
      expect(output).toContain('## Session Lifecycle');
      expect(output).toContain('## Transport');
      expect(output).toContain('## Structured Output Contract');
      expect(output).toContain('POST /api/task-intents');
      expect(output).toContain('decisionProposal');

      // Per-kind procedure core, sourced from procedureCore.ts.
      expect(output).toMatch(/## .+ Procedure/);
      expect(output).toContain('Hard rules');
      expect(output).toContain('The human is the gate');

      // Per-type digest section.
      const digestTitles: Record<PlanningDigest['workflow'], string> = {
        groom: '## Grooming Validation Slice',
        design: '## Design Investigation Slice',
        ops: '## Ops Journal Slice',
      };
      expect(output).toContain(digestTitles[workflow]);

      // Concrete Transport block — the milestone/project ids, the allowed
      // intent kinds, and at least one concrete client invocation.
      expect(output).toContain('`m1`');
      expect(output).toContain('`p1`');
      expect(output).toContain('ORCHESTRATOR_STAGE_TOKEN');
      expect(output).toMatch(
        /node ~\/\.claude\/scripts\/stage-task-intent\.mjs \S+ '/,
      );
      const allowedKinds: Record<PlanningDigest['workflow'], string[]> = {
        groom: [
          'task.setStatus',
          'task.setProperties',
          'task.setDependsOn',
          'gate.accrete',
          'seed.stage',
          'task.create',
        ],
        design: [
          'task.updateBody',
          'task.setProperties',
          'task.setStatus',
          'seed.stage',
          'task.create',
        ],
        ops: [
          'journal.setState',
          'task.setStatus',
          'session.requestCapability',
          'task.create',
        ],
      };
      for (const kind of allowedKinds[workflow]) {
        expect(output).toContain(kind);
      }
      if (workflow === 'ops') {
        expect(output).toContain('ORCHESTRATOR_OPS_JOURNAL_TOKEN');
      }
    });
  }

  it('never leaks a credential value into the assembled text — only the env-var name', () => {
    for (const { digest } of cases) {
      const output = assemblePlanningProcedure({
        taskName: 'A task',
        taskUrl: 'https://notion.so/x',
        milestoneId: 'm1',
        projectId: 'p1',
        digest,
      });
      // Credentials are referenced by env-var name; this composer never has
      // an actual token value in scope to leak, but assert the shape stays
      // name-only (a `$VAR` or `` `VAR` `` reference) rather than anything
      // resembling a minted token (uuid/random-looking string) next to it.
      expect(output).toMatch(/ORCHESTRATOR_STAGE_TOKEN/);
      expect(output).not.toMatch(
        /ORCHESTRATOR_STAGE_TOKEN[^\n]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
    }
  });

  it("requires the /groom skill's structured proposal format (groomProposal fields) on a groom Ready-flip, not free prose", () => {
    const groomOutput = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });

    expect(groomOutput).toContain('groomProposal');
    expect(groomOutput).toContain('presentation.md');
    for (const field of [
      'achieves',
      'openQuestions',
      'automatedTests',
      'manualVerification',
      'operationalSeed',
    ]) {
      expect(groomOutput).toContain(field);
    }

    // design/ops share the generic decisionProposal contract — the
    // structured groomProposal requirement is groom-specific.
    const designOutput = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'design',
        data: deriveDesignDigestSlice(fixtureDesignLoadResult()),
      },
    });
    expect(designOutput).not.toContain('groomProposal');
  });

  it('states an up-front capability inventory for the dispatched ops procedure: base tools, how to request more, what is never grantable', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'ops',
        data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
      },
    });

    expect(output).toContain('## Capabilities');
    expect(output).toMatch(/read-only Bash/i);
    expect(output).toMatch(/no write.+granted by default/i);
    expect(output).toMatch(/session\.requestCapability/);
    expect(output).toMatch(/never grantable/i);
    expect(output).toMatch(/Write\/Edit tools/i);

    // Stated up-front — before the Transport section, not buried at the end.
    const capabilitiesIdx = output.indexOf('## Capabilities');
    const transportIdx = output.indexOf('## Transport');
    expect(capabilitiesIdx).toBeGreaterThanOrEqual(0);
    expect(transportIdx).toBeGreaterThan(capabilitiesIdx);

    // groom/design never see the ops-only capability inventory.
    for (const { workflow, digest } of cases) {
      if (workflow === 'ops') continue;
      const other = assemblePlanningProcedure({
        taskName: 'A task',
        taskUrl: 'https://notion.so/x',
        milestoneId: 'm1',
        projectId: 'p1',
        digest,
      });
      expect(other).not.toContain('## Capabilities');
    }
  });

  it('states file authorship is a Code task, not something ops writes directly', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'ops',
        data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
      },
    });

    expect(output).toMatch(
      /authoring or rewriting a file.+(is always a|Code task)/is,
    );
    expect(output).toMatch(/💻 Code task/);
    expect(output).toMatch(/ops proposes the content/i);
  });

  it('instructs the dispatched ops procedure to stage/request then keep driving, never ask-before-stage', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'ops',
        data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
      },
    });

    expect(output).toMatch(/stage the next step, then keep driving/i);
    expect(output).toMatch(/applied-pending-confirm/);
    expect(output).not.toMatch(/stop for explicit human sign-off/i);
  });

  it('does not label the ops procedure read-only/stage-only or tell it to park at a stopping point, and states the write-capable drive-to-applied-pending-confirm posture', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'ops',
        data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
      },
    });

    expect(output).not.toMatch(/read-only\/stage-only/i);
    expect(output).not.toMatch(/parks into idle/i);
    expect(output).toMatch(/write-capable/i);
    expect(output).toMatch(
      /drive the operational change itself to completion/i,
    );
    expect(output).toMatch(/applied-pending-confirm/);
    expect(output).toMatch(/resolved/);

    // groom/design keep the original read-only/stage-only, parks-into-idle framing.
    for (const { workflow, digest } of cases) {
      if (workflow === 'ops') continue;
      const other = assemblePlanningProcedure({
        taskName: 'A task',
        taskUrl: 'https://notion.so/x',
        milestoneId: 'm1',
        projectId: 'p1',
        digest,
      });
      expect(other).toMatch(/read-only\/stage-only/i);
      expect(other).toMatch(/parks into idle/i);
    }
  });

  it('states the explicit never-create-a-PR rule for ops, routing PR-bearing work to a staged 💻 Code task instead', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'ops',
        data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
      },
    });

    expect(output).toMatch(/never create a PR/i);
    expect(output).toMatch(/💻 Code task/);
    expect(output).toMatch(/task\.create/);
  });

  it('instructs the dispatched groom procedure that presenting IS staging, never ask-before-stage', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });

    expect(output).toMatch(/presenting IS staging/i);
    expect(output).toMatch(/never ask for sign-off before staging/i);
    expect(output).not.toMatch(/stop for explicit human sign-off/i);
  });

  it('states the terminal mandate: not finished until the grooming decision is staged, a chat write-up is never the deliverable', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });

    expect(output).toMatch(/terminal mandate/i);
    expect(output).toMatch(/NOT finished once you have reached a conclusion/i);
    expect(output).toMatch(
      /chat write-up.+is never the deliverable and is never a valid place to end the turn/is,
    );

    // ops/design never see this groom-specific terminal-mandate language.
    for (const { workflow, digest } of cases) {
      if (workflow === 'groom') continue;
      const other = assemblePlanningProcedure({
        taskName: 'A task',
        taskUrl: 'https://notion.so/x',
        milestoneId: 'm1',
        projectId: 'p1',
        digest,
      });
      expect(other).not.toMatch(/terminal mandate/i);
    }
  });

  it('enumerates the terminal intent set by kind for both the Ready and Deferred grooming paths', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });

    expect(output).toMatch(/Ready path stages/i);
    expect(output).toMatch(/Deferred path stages/i);
    expect(output).toContain('task.setStatus');
    expect(output).toContain('task.setDependsOn');
    expect(output).toContain('gate.accrete');
    expect(output).toContain('seed.stage');
  });

  it('gives the field-level format of a Ready groomingGate intent with a filled worked example', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });

    expect(output).toContain('groomingGate');
    for (const field of [
      'size_check',
      'type_check',
      'constraintsDispositioned',
      'filesPathsEntries',
      'dependsOnTasks',
    ]) {
      expect(output).toContain(field);
    }

    // The worked example is field-complete, not just `{"type": "..."}`.
    const exampleStart = output.indexOf('"groomingGate":{');
    expect(exampleStart).toBeGreaterThanOrEqual(0);
    const example = output.slice(exampleStart, exampleStart + 600);
    expect(example).toContain('"size_check"');
    expect(example).toContain('"type_check"');
    expect(example).toContain('"regions"');
    expect(example).toContain('"constraintsDispositioned"');
    expect(example).toContain('"filesPathsEntries"');
    expect(example).toContain('"dependsOnTasks"');
  });

  it('offers the groom procedure a discard/defer proposal as an alternative to promoting to Ready', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });

    expect(output).toMatch(/task\.setStatus.*Deferred/);
    expect(output).toMatch(/discard\/defer/i);

    for (const { workflow, digest } of cases) {
      if (workflow === 'groom') continue;
      const other = assemblePlanningProcedure({
        taskName: 'A task',
        taskUrl: 'https://notion.so/x',
        milestoneId: 'm1',
        projectId: 'p1',
        digest,
      });
      expect(other).not.toMatch(/discard\/defer/i);
    }
  });

  it('excludes the skill-mode "Resolve manifest & mode" step for groom and design (context is already injected)', () => {
    for (const { workflow, digest } of cases) {
      if (workflow === 'ops') continue;
      const output = assemblePlanningProcedure({
        taskName: 'A task',
        taskUrl: 'https://notion.so/x',
        milestoneId: 'm1',
        projectId: 'p1',
        digest,
      });
      expect(output).not.toContain('Resolve manifest & mode');
      expect(output).not.toContain('grooming manifest');
      expect(output).not.toContain('on-disk cache');
    }
  });

  it('still includes the "Deterministic load" (context-injected) step for the dispatched groom procedure', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });
    expect(output).toContain('Deterministic load');
    expect(output).toContain('already injected into this prompt');
  });

  it('the groom digest section is a constrained slice, not the full milestone-wide loader dump', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });
    expect(output).toContain('size_check seed');
    expect(output).toContain('type_check');
    // Milestone-wide context (the full board / context pages) is never inlined.
    expect(output).not.toContain('Master Context');
  });

  it('includes the task code regions and full body in the groom digest', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });
    expect(output).toContain('Code regions');
    expect(output).toContain('packages/backend');
    expect(output).toContain('packages/backend/src/foo.ts');
    expect(output).toContain('### Task body');
    expect(output).toContain('Do the thing body.');
  });

  it('replaces the bare (none) with a bounded-exploration directive + orientation graft when regions resolve empty', () => {
    const result = fixtureGroomLoadResult();
    result.targetTasks[0].regions = { packages: [], files: [], planned: [] };
    result.codeWorklist = new Map([
      ['packages/backend/src/notion', ['packages/backend/src/notion/x.ts']],
    ]);
    result.targetTasks.push({
      ...result.targetTasks[0],
      id: 'task-2',
      title: 'Sibling task',
      regions: {
        packages: ['packages/backend/src/notion'],
        files: ['packages/backend/src/notion/x.ts'],
        planned: [],
      },
    });

    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(result, 'task-1'),
      },
    });

    expect(output).not.toMatch(/Code regions:.*\(none\)$/m);
    expect(output).toContain('bounded exploration');
    expect(output).toContain('do not loop');
    expect(output).toContain('packages/backend/src/notion');
    expect(output).toContain('Sibling task');
  });

  it('degrades gracefully when regions AND the orientation graft are both empty (fresh milestone)', () => {
    const result = fixtureGroomLoadResult();
    result.targetTasks[0].regions = { packages: [], files: [], planned: [] };
    result.codeWorklist = new Map();

    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(result, 'task-1'),
      },
    });

    expect(output).toContain('bounded exploration');
    expect(output).toContain('fresh milestone');
  });

  it('surfaces greenfield declared paths as planned regions instead of a bare (none)', () => {
    const result = fixtureGroomLoadResult();
    result.targetTasks[0].regions = {
      packages: [],
      files: [],
      planned: [
        { path: 'packages/search/globalSearchIndex.ts', package: 'packages' },
      ],
    };

    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(result, 'task-1'),
      },
    });

    expect(output).toContain('planned');
    expect(output).toContain('packages/search/globalSearchIndex.ts');
    expect(output).not.toContain('bounded exploration');
  });

  it('the design digest section omits raw code-map grounding, pointing at the on-demand route instead', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'design',
        data: deriveDesignDigestSlice(
          fixtureDesignLoadResult({ pkgA: { some: 'big blob' } }),
        ),
      },
    });
    expect(output).toContain('GET /api/design-context');
    expect(output).not.toContain('big blob');
  });

  it('the ops digest section carries the journal entry and task classification only', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'ops',
        data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
      },
    });
    expect(output).toContain('No prior entry');
    expect(output).not.toContain('Ops Master Context');
  });

  it('composes sections in skeleton → procedure core → digest order', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'design',
        data: deriveDesignDigestSlice(fixtureDesignLoadResult()),
      },
    });
    const lifecycleIdx = output.indexOf('## Session Lifecycle');
    const coreIdx = output.indexOf('## Design Execution Procedure');
    const digestIdx = output.indexOf('## Design Investigation Slice');
    expect(lifecycleIdx).toBeGreaterThanOrEqual(0);
    expect(coreIdx).toBeGreaterThan(lifecycleIdx);
    expect(digestIdx).toBeGreaterThan(coreIdx);
  });
});

// ─── output contract kinds stay in sync with the real intent-kind registry ──

describe('planning intent kinds', () => {
  it('every intent kind referenced in the skeleton output contract is a real KNOWN_INTENT_KINDS member', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });
    const match = output.match(
      /Stage findings as one of: (.+?)\. Every staged intent/,
    );
    expect(match).toBeTruthy();
    const kinds = match![1].split(',').map((k) => k.trim());
    for (const kind of kinds) {
      expect(KNOWN_INTENT_KINDS.has(kind)).toBe(true);
    }
  });

  it('advertises seed.stage for groom, alongside gate.accrete, so a Code task can accrete both markers before Ready', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });
    const match = output.match(
      /Stage findings as one of: (.+?)\. Every staged intent/,
    );
    expect(match).toBeTruthy();
    const kinds = match![1].split(',').map((k) => k.trim());
    expect(kinds).toContain('seed.stage');
    expect(kinds).toContain('gate.accrete');
    for (const kind of kinds) {
      expect(KNOWN_INTENT_KINDS.has(kind)).toBe(true);
    }
  });

  it('advertises task.create for groom, design, and ops, so a dispatched session can stage its mandated follow-on tasks', () => {
    const outputs = [
      assemblePlanningProcedure({
        taskName: 'A task',
        taskUrl: 'https://notion.so/x',
        milestoneId: 'm1',
        projectId: 'p1',
        digest: {
          workflow: 'groom',
          data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
        },
      }),
      assemblePlanningProcedure({
        taskName: 'A task',
        taskUrl: 'https://notion.so/x',
        milestoneId: 'm1',
        projectId: 'p1',
        digest: {
          workflow: 'design',
          data: deriveDesignDigestSlice(fixtureDesignLoadResult()),
        },
      }),
      assemblePlanningProcedure({
        taskName: 'A task',
        taskUrl: 'https://notion.so/x',
        milestoneId: 'm1',
        projectId: 'p1',
        digest: {
          workflow: 'ops',
          data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
        },
      }),
    ];
    for (const output of outputs) {
      const match = output.match(
        /Stage findings as one of: (.+?)\. Every staged intent/,
      );
      expect(match).toBeTruthy();
      const kinds = match![1].split(',').map((k) => k.trim());
      expect(kinds).toContain('task.create');
      for (const kind of kinds) {
        expect(KNOWN_INTENT_KINDS.has(kind)).toBe(true);
      }
    }
  });

  it('advertises session.requestCapability for ops, coherent with the capability inventory section', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      milestoneId: 'm1',
      projectId: 'p1',
      digest: {
        workflow: 'ops',
        data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
      },
    });
    const match = output.match(
      /Stage findings as one of: (.+?)\. Every staged intent/,
    );
    expect(match).toBeTruthy();
    const kinds = match![1].split(',').map((k) => k.trim());
    expect(kinds).toContain('session.requestCapability');
    for (const kind of kinds) {
      expect(KNOWN_INTENT_KINDS.has(kind)).toBe(true);
    }
  });
});

// ─── WORKFLOW_LOADERS ───────────────────────────────────────────────────────

describe('WORKFLOW_LOADERS', () => {
  it('maps every workflow to its loader module', () => {
    expect(WORKFLOW_LOADERS.groom).toMatch(/groomLoad/);
    expect(WORKFLOW_LOADERS.design).toMatch(/designLoad/);
    expect(WORKFLOW_LOADERS.ops).toMatch(/opsLoad/);
  });
});

// ─── delivery: reaches the session via the appended-prompt file, not
// buildOrchestratorClaudeMd ───────────────────────────────────────────────

describe('delivery wiring in SessionManager', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('completeStart short-circuits to injectedProcedureContent for planning sessions before falling back to buildSessionContext', () => {
    const completeStartIdx = source.indexOf('private async completeStart(');
    const cleanupIdx = source.indexOf('private async cleanupPartialWorktree(');
    const block = source.slice(completeStartIdx, cleanupIdx);
    expect(block).toMatch(/isPlanning\s*&&\s*injectedProcedureContent/);
    expect(block).toMatch(/writeSystemPromptFile\s*\(/);
  });

  it('StartOptions documents injectedProcedureContent as the assembler hand-off', () => {
    expect(source).toMatch(/injectedProcedureContent\?:\s*string/);
    expect(source).toMatch(/procedureAssembler\.ts/);
  });
});
