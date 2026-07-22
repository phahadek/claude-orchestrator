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
    });
  }

  it('states an up-front capability inventory for the dispatched ops procedure: base tools, how to request more, what is never grantable', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
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
        digest,
      });
      expect(other).not.toContain('## Capabilities');
    }
  });

  it('states file authorship is a Code task, not something ops writes directly', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
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

  it('instructs the dispatched ops procedure to stage the decision then park, never ask-before-stage', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      digest: {
        workflow: 'ops',
        data: deriveOpsDigestSlice(fixtureOpsLoadResult(), 'task-3', null),
      },
    });

    expect(output).toMatch(/stage the decision, then park/i);
    expect(output).not.toMatch(/stop for explicit human sign-off/i);
  });

  it('instructs the dispatched groom procedure that presenting IS staging, never ask-before-stage', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
      digest: {
        workflow: 'groom',
        data: deriveGroomDigestSlice(fixtureGroomLoadResult(), 'task-1'),
      },
    });

    expect(output).toMatch(/presenting IS staging/i);
    expect(output).toMatch(/never ask for sign-off before staging/i);
    expect(output).not.toMatch(/stop for explicit human sign-off/i);
  });

  it('offers the groom procedure a discard/defer proposal as an alternative to promoting to Ready', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
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

  it('the design digest section omits raw code-map grounding, pointing at the on-demand route instead', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
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

  it('advertises session.requestCapability for ops, coherent with the capability inventory section', () => {
    const output = assemblePlanningProcedure({
      taskName: 'A task',
      taskUrl: 'https://notion.so/x',
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
